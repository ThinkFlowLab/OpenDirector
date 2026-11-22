import { z } from 'zod';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell, nativeTheme } from 'electron';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { Host, ownedURL, proxyRequest } from './host.mjs';
import { messages, localeFor } from './locale.mjs';
import { registerCommand, commandPath } from './command.mjs';

app.setName('OpenDirector');
const desktopChrome = ['darwin', 'win32'].includes(process.platform);
const captionHeight = 48;
const here = dirname(fileURLToPath(import.meta.url));
const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(here, '..', 'runtime');
const isolated = process.env.OPENDIRECTOR_DESKTOP_DATA;
if (isolated) app.setPath('userData', isolated);
protocol.registerSchemesAsPrivileged([{ scheme: 'opendirector', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
} }]);
let host;
let window;
let exporting = false;
let quitting = false;
let quitPending = false;
let locale = localeFor(app.getLocale());
const text = () => messages[locale];
const userData = app.getPath('userData');
const logs = join(userData, 'logs');
const workspace = join(userData, 'workspace');
mkdirSync(logs, { recursive: true });
mkdirSync(workspace, { recursive: true });
const logFile = join(logs, 'desktop.log');
const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
try { locale = localeFor(readFileSync(join(userData, 'locale'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') log.write(`Locale read failed: ${error.message}\n`); }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(fatal);
}

function trusted(event) {
  return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && ownedURL(event.senderFrame.url);
}
ipcMain.on('desktop:locale', (event, value) => {
  if (!trusted(event) || !['en-US', 'zh-CN'].includes(value)) return;
  locale = value;
  writeFileSync(join(userData, 'locale'), value, { mode: 0o600 });
  menu();
});
ipcMain.on('desktop:theme', (event, value) => {
  if (trusted(event) && ['light', 'dark'].includes(value)) { nativeTheme.themeSource = value;
    if (process.platform === 'win32') window.setTitleBarOverlay(windowsCaption());
    applyBackdrop(); }
});
ipcMain.on('desktop:session', (event, value) => {
  const parsed = z.uuid().safeParse(value);
  if (trusted(event) && parsed.success) host.registerSession(parsed.data);
});
ipcMain.on('desktop:exporting', (event, value) => {
  if (trusted(event) && typeof value === 'boolean') exporting = value;
});

function desktopActions() {
  return [
    { label: text().command, click: manageCommand },
    { label: text().data, click: () => shell.openPath(workspace) },
    { label: text().logs, click: () => shell.openPath(logs) },
  ];
}

ipcMain.on('desktop:more', event => {
  if (trusted(event) && desktopChrome) Menu.buildFromTemplate(desktopActions()).popup({ window });
});

function windowsCaption() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { height: captionHeight, color: dark ? '#141414' : '#f7f8fa', symbolColor: dark ? '#eceef2' : '#30343c' };
}

function menu() {
  const editing = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].map(role => ({ role, label: text()[role] }));
  const view = [
    { role: 'togglefullscreen', label: text().fullscreen },
    { role: 'toggleDevTools', label: text().devtools },
  ];
  const quit = { label: text().quit, accelerator: 'CmdOrCtrl+Q', click: () => app.quit() };
  const shortcuts = [...editing, ...view, quit].map(item => ({ ...item, visible: false, acceleratorWorksWhenHidden: true }));
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(Menu.buildFromTemplate(shortcuts));
    return;
  }
  const about = { role: 'about', label: text().app };
  Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === 'darwin' ? [
    { label: text().app, submenu: [about, quit, ...shortcuts.slice(0, -1)] },
  ] : [
    { label: text().app, submenu: [about, ...desktopActions(), quit] },
    { label: text().edit, submenu: editing },
    { label: text().view, submenu: view },
  ]));
}

async function manageCommand() {
  const destination = commandPath(homedir());
  const { response } = await dialog.showMessageBox(window, { message: text().command, detail: destination,
    buttons: [text().install, text().remove, text().cancel], cancelId: 2 });
  if (response === 2) return;
  if (response === 1) {
    await dialog.showMessageBox(window, { message: text().commandRemoveHelp, detail: destination });
    return;
  }
  try {
    const launcher = join(runtime, 'bin', process.platform === 'win32' ? 'opendirector.cmd' : 'opendirector');
    const result = await registerCommand({ destination, launcher });
    await dialog.showMessageBox(window, { message: text()[result === 'installed' ? 'commandDone' : 'commandAlreadyInstalled'], detail: destination });
  } catch (error) {
    await dialog.showMessageBox(window, { type: 'error', message: text().failed,
      detail: error.message === 'command_collision' ? [text().collision, destination].join('\n') : error.message });
  }
}

async function start() {
  menu();
  const manifest = JSON.parse(readFileSync(join(runtime, 'manifest.json'), 'utf8'));
  if (typeof manifest.python !== 'string' || manifest.python.startsWith('/') || manifest.python.split(/[\\/]/).includes('..')) throw new Error('Invalid runtime Python path');
  if (manifest.version !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Runtime platform does not match this application');
  host = new Host({ python: join(runtime, manifest.python), directory: workspace, log,
    env: { ...process.env, OPENDIRECTOR_ROOT: workspace,
      PATH: join(runtime, 'bin') + (process.platform === 'win32' ? ';' : ':') + process.env.PATH },
    onExit: () => { if (!quitting) void fatal(new Error(text().interrupted)); },
  });
  await host.ready;
  const ownedSession = session.fromPartition('persist:opendirector');
  ownedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  let projectSubscription;
  ownedSession.protocol.handle('opendirector', request => proxyRequest(request, host, async (url, options) => {
    const pathname = new URL(url).pathname;
    if (options.method === 'GET' && /^\/api\/creation\/projects\/[^/]+\/subscribe$/.test(pathname)) {
      // Chromium can leave the upstream stream open after the renderer switches projects.
      projectSubscription?.abort();
      projectSubscription = new AbortController();
      options.signal = AbortSignal.any([options.signal, projectSubscription.signal]);
    }
    // Electron net.fetch buffers request streams internally. The private Host
    // upload uses Node fetch to send the body incrementally over loopback.
    // Asset reads use it too so large response bodies reach the renderer.
    const assetMedia = options.method === 'GET' &&
      /^\/api\/creation\/projects\/[^/]+\/assets\/[^/]+\/content$/.test(pathname);
    return options.duplex || assetMedia ? fetch(url, options) : net.fetch(url, options);
  }));
  ownedSession.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: text().save }));
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600, show: false, title: 'OpenDirector',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
      vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000' } : {}),
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: windowsCaption() } : {}),
    webPreferences: { session: ownedSession, preload: join(here, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true },
  });
  if (process.platform === 'win32') window.setMenuBarVisibility(false);
  if (desktopChrome) {
    const fullscreen = value => window.webContents.send('desktop:fullscreen', value);
    window.on('enter-full-screen', () => fullscreen(true));
    window.on('leave-full-screen', () => fullscreen(false));
    window.webContents.on('did-finish-load', () => fullscreen(window.isFullScreen()));
    if (process.platform === 'darwin') {
      for (const event of ['minimize', 'hide', 'restore', 'show']) window.on(event, applyBackdrop);
    }
  }
  const traceURL = url => {
    const target = new URL(url);
    return ownedURL(url) && target.pathname === '/' && target.searchParams.has('traceProject');
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (traceURL(url)) {
      const trace = new BrowserWindow({
        parent: window, width: 1100, height: 760,
        webPreferences: { session: ownedSession, nodeIntegration: false,
          contextIsolation: true, sandbox: true, webSecurity: true },
      });
      if (process.platform !== 'darwin') trace.removeMenu();
      trace.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      trace.webContents.on('will-navigate', (event, target) => {
        if (!traceURL(target)) event.preventDefault();
      });
      void trace.loadURL(url).catch(error => {
        log.write(`Trace window failed: ${error.message}\n`);
        if (!trace.isDestroyed()) trace.destroy();
      });
    } else if (new URL(url).protocol === 'https:') {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (!ownedURL(url)) event.preventDefault(); });
  window.webContents.on('render-process-gone', (_event, { reason, exitCode }) => {
    exporting = false;
    log.write(`Renderer exited: reason=${reason} exitCode=${exitCode}\n`);
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  app.on('activate', () => { window?.show(); window?.focus(); });
  await window.loadURL('opendirector://app/');
  window.show();
  if (process.argv.includes('--smoke')) {
    try {
      const { smokeWindow } = await import('../scripts/smoke-window.mjs');
      const result = await smokeWindow({ window, host, getLocale: () => locale });
      quitting = true;
      window.destroy();
      if (!(await host.stop())) throw new Error('Host exited without confirming session cleanup');
      log.write(`smoke ${JSON.stringify(result)}\n`);
      app.exit(0);
    } catch (error) {
      log.write('Desktop smoke test failed\n');
      // CI receives assertion details on stderr. The persistent log contains
      // only a fixed message because errors can include Host response data.
      console.error(error);
      quitting = true;
      window?.destroy();
      await host.stop();
      app.exit(1);
    }
  }
}

function applyBackdrop() {
  if (process.platform !== 'darwin' || !window || window.isDestroyed()) return;
  if (window.isMinimized() || !window.isVisible()) {
    window.setVibrancy(null);
    window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#202022' : '#eeeef1');
  } else {
    window.setVibrancy('sidebar');
    window.setBackgroundColor('#00000000');
  }
}

async function fatal(error) {
  log.write(`Host failure: ${error.message}\n`);
  await host?.stop();
  if (process.argv.includes('--smoke')) { app.exit(1); return; }
  await dialog.showMessageBox({ type: 'error', message: text().startup, detail: `${error.message}\n${logFile}`, buttons: [text().close] });
  quitting = true;
  app.quit();
}

// Keep Electron alive until the explicit quit path finishes stopping the Host.
app.on('window-all-closed', () => {});

app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  void (async () => {
    try {
      const state = await host?.inspect();
      if (exporting || state === null || state && (state.agents || state.generations || state.tools)) {
        const { response } = await dialog.showMessageBox({ type: 'warning', message: text().running,
          buttons: [text().cancel, text().quit], defaultId: 0, cancelId: 0 });
        if (response !== 1) return;
      }
      quitting = true;
      window?.destroy();
      await host?.stop();
      app.quit();
    } finally { quitPending = false; }
  })();
});
