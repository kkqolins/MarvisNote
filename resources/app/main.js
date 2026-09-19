// Marvis 星露谷笔记本 - 主进程
// 保存可靠性设计：
// 1) 渲染进程每次编辑防抖 300ms 发 'save' IPC，主进程同步写盘（原子写 tmp+rename）
// 2) 渲染进程 beforeunload 发 'save-sync' 同步 IPC，保证关闭前最后一次数据一定落盘
// 3) 导出/导入使用系统原生对话框
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(process.env.APPDATA, 'MarvisNote');
const LIB_PATH = path.join(APP_DIR, 'library.json');

/* ---------- 文件写入（原子写，防止写一半损坏） ---------- */
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, file);
}

function writeLibrary(data) {
  try {
    if (!fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR, { recursive: true });
    const payload = {
      app: 'marvis-note',
      version: 8,
      books: (data && data.books) || [],
      collapsed: (data && data.collapsed) || {},
      curBookId: (data && data.curBookId) || null,
      curPageId: (data && data.curPageId) || null,
      titleMain: (data && data.titleMain) || '',
      titleSub: (data && data.titleSub) || '',
      savedAt: new Date().toISOString()
    };
    writeFileAtomic(LIB_PATH, JSON.stringify(payload, null, 1));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function readLibrary() {
  try {
    if (!fs.existsSync(LIB_PATH)) return { ok: true, data: null };
    const raw = fs.readFileSync(LIB_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- IPC ---------- */
ipcMain.handle('load-library', async () => readLibrary());

ipcMain.on('save', (e, data) => {
  writeLibrary(data);
});

ipcMain.on('save-sync', (e, data) => {
  e.returnValue = writeLibrary(data);
});

ipcMain.handle('export-book', async (ev, payload) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const r = await dialog.showSaveDialog(win, {
    title: '导出笔记本',
    defaultPath: ((payload && payload.name) || '我的笔记本') + '.mbook',
    filters: [{ name: 'Marvis 笔记本', extensions: ['mbook'] }]
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  try {
    const data = {
      app: 'marvis-note',
      version: 8,
      name: path.basename(r.filePath, '.mbook'),
      pages: (payload && payload.pages) || [],
      exportedAt: new Date().toISOString()
    };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('import-book', async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '导入笔记本（恢复历史）',
    filters: [
      { name: 'Marvis 笔记本', extensions: ['mbook'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true };
  const file = r.filePaths[0];
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    const pages = (data.pages || []).map(p => ({
      id: p.id || ('p' + Date.now() + Math.random().toString(36).slice(2, 8)),
      title: p.title || '未命名笔记',
      html: p.html || ''
    }));
    return {
      ok: true,
      path: file,
      name: data.name || path.basename(file, '.mbook'),
      pages
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ---------- 导出为 Word / PDF ---------- */
// 将富文本 HTML 中的相对素材路径（assets/emoji、assets/bookicon）转成本机 file:// 绝对路径，
// 保证导出的 Word/PDF 在本机打开时贴纸图片可正常显示
function absolutizeAssets(html) {
  const assetDir = path.join(__dirname, 'assets').replace(/\\/g, '/');
  return String(html || '').replace(/(src|href)="(assets\/)/g, '$1="file:///' + assetDir + '/');
}

// 导出为 Word：HTML 包装成 .doc（UTF-8 BOM，Word 可直接识别富文本与内嵌图片）
ipcMain.handle('export-word', async (ev, payload) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const name = (payload && payload.name) || '我的笔记本';
  const r = await dialog.showSaveDialog(win, {
    title: '导出为 Word',
    defaultPath: name + '.doc',
    filters: [{ name: 'Word 文档', extensions: ['doc'] }]
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  try {
    const html = absolutizeAssets((payload && payload.html) || '<html><head><meta charset="utf-8"></head><body></body></html>');
    fs.writeFileSync(r.filePath, '\ufeff' + html, 'utf-8');
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 导出为 PDF：隐藏窗口加载 HTML 后 webContents.printToPDF 打印为 A4 PDF
ipcMain.handle('export-pdf', async (ev, payload) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const name = (payload && payload.name) || '我的笔记本';
  const r = await dialog.showSaveDialog(win, {
    title: '导出为 PDF',
    defaultPath: name + '.pdf',
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  let pdfWin = null;
  let tmpHtml = null;
  try {
    const html = absolutizeAssets((payload && payload.html) || '<html><head><meta charset="utf-8"></head><body></body></html>');
    tmpHtml = path.join(os.tmpdir(), 'marvis-note-export-' + Date.now() + '.html');
    fs.writeFileSync(tmpHtml, html, 'utf-8');
    pdfWin = new BrowserWindow({
      show: false,
      width: 794,            // A4 @96dpi 宽度
      height: 1123,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
    });
    await pdfWin.loadFile(tmpHtml);
    const data = await pdfWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'none' }
    });
    fs.writeFileSync(r.filePath, data);
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (pdfWin) { try { pdfWin.destroy(); } catch (e) {} }
    if (tmpHtml) { try { fs.unlinkSync(tmpHtml); } catch (e) {} }
  }
});

/* ---------- 窗口 ---------- */
/* 窗口控制（自绘一体式标题栏） */
ipcMain.on('win-minimize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.minimize();
});
ipcMain.on('win-close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.close();
});
ipcMain.on('win-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});

// 动态读取 emoji 素材目录（面板只渲染实际存在的文件，删除后不再破图）
ipcMain.handle('list-emoji', () => {
  const dir = path.join(__dirname, 'assets', 'emoji');
  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .sort();
  } catch (e) {
    return [];
  }
});

// 删除 emoji 素材：按文件名移入回收站（可逆），并校验防止路径穿越
ipcMain.handle('delete-emoji', async (e, name) => {
  const dir = path.join(__dirname, 'assets', 'emoji');
  const safe = path.basename(String(name || '').replace(/[\\/]/g, ''));
  if (!safe || !/\.[a-zA-Z0-9]+$/.test(safe)) return { ok: false, reason: 'invalid' };
  const file = path.join(dir, safe);
  const real = path.resolve(file);
  if (!real.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(real)) return { ok: false, reason: 'notfound' };
  try {
    await shell.trashItem(real);
    return { ok: true, name: safe };
  } catch (err) {
    // trashItem 失败时退回直接删除
    try { fs.unlinkSync(real); return { ok: true, name: safe }; }
    catch (e2) { return { ok: false, reason: 'failed' }; }
  }
});

// 自定义添加 emoji：系统文件选择器选图片，复制进素材目录，前端刷新即显示
ipcMain.handle('add-emoji', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const dir = path.join(__dirname, 'assets', 'emoji');
  const res = await dialog.showOpenDialog(win, {
    title: '选择要添加的素材图片',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, added: [] };
  const added = [];
  for (const src of res.filePaths) {
    const ext = path.extname(src).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) continue;
    const baseName = path.basename(src);
    let name = baseName;
    let dst = path.join(dir, name);
    let i = 1;
    while (fs.existsSync(dst)) {
      name = path.parse(baseName).name + '_' + i + ext;
      dst = path.join(dir, name);
      i++;
    }
    fs.copyFileSync(src, dst);
    added.push(name);
  }
  return { ok: true, added };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    frame: false,              // 无边框：自绘一体式最小化/关闭
    transparent: false,        // 不透明背景（透明窗口在 Windows 无法拖拽调整大小）
    backgroundColor: '#4a2c14',
    resizable: true,           // 允许拖拽边缘调整窗口大小
    roundedCorners: true,      // Windows 11 原生圆角，无白边
  hasShadow: false,          // 关闭 DWM 阴影，消除四角灰边更沉浸
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'marvis_note.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.loadFile('index.html');
  win.on('maximize', () => win.webContents.send('win-max-state', true));
  win.on('unmaximize', () => win.webContents.send('win-max-state', false));

  win.on('close', () => {
    // 渲染进程 beforeunload 已通过 save-sync 同步落盘，这里无需额外处理
  });
  return win;
}

/* ---------- 应用生命周期 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
