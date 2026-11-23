export const messages = {
  'en-US': {
    app: 'OpenDirector', startup: 'OpenDirector could not start', retry: 'Retry', quit: 'Quit', cancel: 'Cancel',
    interrupted: 'The local service stopped. Restart OpenDirector to reconnect. Existing remote jobs are not automatically cancelled.',
    running: 'Agent, generation or export work is active, or its status could not be checked. Quitting interrupts local work. Remote jobs may continue and incur charges. Quit now?',
    edit: 'Edit', view: 'View', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all', fullscreen: 'Toggle fullscreen', devtools: 'Developer tools',
    menu: 'File', logs: 'Open diagnostics folder', data: 'Open data folder', command: 'Manage terminal command',
    install: 'Install', remove: 'Removal instructions', commandDone: 'Terminal command installed. Open a new terminal to use it.',
    commandAlreadyInstalled: 'The terminal command is already installed.',
    commandRemoveHelp: 'To uninstall the command, inspect the entry at this path and remove it manually if it belongs to OpenDirector.',
    collision: 'This path is already in use. To repair a previous OpenDirector installation, inspect and manually remove its old entry before installing again.',
    failed: 'Operation failed', close: 'Close', save: 'Save file',
  },
  'zh-CN': {
    app: 'OpenDirector', startup: 'OpenDirector 无法启动', retry: '重试', quit: '退出', cancel: '取消',
    interrupted: '本地服务已停止，请重启 OpenDirector 重新连接。已有远端任务不会自动取消。',
    running: 'Agent、生成或导出任务仍在运行，或无法确认任务状态。退出会中断本地工作；远端任务可能继续运行并产生费用。是否退出？',
    edit: '编辑', view: '视图', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选', fullscreen: '切换全屏', devtools: '开发者工具',
    menu: '文件', logs: '打开诊断目录', data: '打开数据目录', command: '管理终端命令',
    install: '安装', remove: '移除说明', commandDone: '终端命令已安装，请打开新终端使用。',
    commandAlreadyInstalled: '终端命令已安装。',
    commandRemoveHelp: '如需卸载终端命令，请检查此路径下的入口，确认它属于 OpenDirector 后手动移除。',
    collision: '此路径已被占用。如需修复旧版 OpenDirector 的终端命令，请检查并手动移除旧入口，再重新安装。',
    failed: '操作失败', close: '关闭', save: '保存文件',
  },
};
export const localeFor = value => value?.startsWith('zh') ? 'zh-CN' : 'en-US';
