// 预加载脚本：通过 contextBridge 向渲染进程暴露安全 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 异步加载笔记本库
  loadLibrary: () => ipcRenderer.invoke('load-library'),
  // 异步保存（编辑过程中高频调用）
  save: (data) => ipcRenderer.send('save', data),
  // 同步保存（关闭窗口前兜底，保证落盘后才关闭）
  saveSync: (data) => ipcRenderer.sendSync('save-sync', data),
  // 导出笔记本到 .mbook
  exportBook: (payload) => ipcRenderer.invoke('export-book', payload),
  // 导出为 Word（HTML 包装 .doc）
  exportWord: (payload) => ipcRenderer.invoke('export-word', payload),
  // 导出为 PDF（主进程 printToPDF）
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload),
  // 从 .mbook 导入恢复
  importBook: () => ipcRenderer.invoke('import-book'),
  // 自绘标题栏窗口控制
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  onMaxState: (cb) => ipcRenderer.on('win-max-state', (e, v) => cb(v)),
  close: () => ipcRenderer.send('win-close'),
  // 读取 emoji 素材目录（动态渲染面板，避免删除后破图）
  listEmoji: () => ipcRenderer.invoke('list-emoji'),
  // 添加自定义素材（系统选图 -> 复制进素材目录）
  addEmoji: () => ipcRenderer.invoke('add-emoji'),
  deleteEmoji: (name) => ipcRenderer.invoke('delete-emoji', name)
});
