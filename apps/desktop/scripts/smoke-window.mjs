import { guardLargeVideoDataUrl, largeVideoState, verifyLargeVideoBytes } from './large-video.mjs';
import { app, BrowserWindow } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function smokeWindow({ window, host, getLocale }) {
  const result = await window.webContents.executeJavaScript(`(async () => {
    const r = await fetch('/api/health', {headers: {'X-OpenDirector-Request': '1'}});
    const health = await r.json();
    const projects = await fetch('/api/creation/projects', {headers: {'X-OpenDirector-Request': '1'}});
    return {health, projects: projects.status, isolated: typeof require === 'undefined', bridge: !!window.opendirectorDesktop};
  })()`);
  if (result.health.status !== 'ok' || result.projects !== 200 || !result.isolated || !result.bridge) throw new Error('Desktop smoke failed');
  await waitFor(() => window.webContents.executeJavaScript('document.querySelectorAll("button").length > 2'), 'Workbench did not become interactive');
  if (process.platform === 'win32' && await window.webContents.executeJavaScript('!localStorage.getItem("opendirector.modelSetup.v1")')) {
    await checkWindowsWelcomeCaption(window);
  }
  await window.webContents.executeJavaScript('document.querySelector(".cw-welcome-secondary")?.click()');
  await waitFor(() => window.webContents.executeJavaScript('!!document.querySelector(".react-flow") && !!document.querySelector(".cw-save-status i.saved")'), 'Canvas did not open');
  result.projectIds = await waitFor(() => window.webContents.executeJavaScript(`fetch('/api/creation/projects', {headers: {'X-OpenDirector-Request': '1'}})
    .then(r => r.json()).then(value => value.projects.length ? value.projects.map(project => project.id).sort() : null)`), 'Canvas project was not persisted');
  await delay(500);
  await window.webContents.executeJavaScript('document.querySelector(".cw-welcome-secondary")?.click()');
  await delay(300);
  if (await window.webContents.executeJavaScript('!!document.querySelector("dialog[open]")')) throw new Error('A dialog obscures the canvas');
  if (process.platform === 'win32') await checkWindowsCaption(window);
  if (process.env.OPENDIRECTOR_DESKTOP_DATA) {
    const projectId = result.projectIds.length === 1
      ? result.projectIds[0]
      : process.env.OPENDIRECTOR_DESKTOP_SMOKE_MEDIA_PROJECT;
    if (result.projectIds.length === 1) await dropMedia(window);
    const fingerprints = Object.fromEntries(
      Object.entries({ image: 'png', video: 'mp4', audio: 'wav' }).map(([kind, extension]) => {
        const bytes = readFileSync(join(process.env.OPENDIRECTOR_DESKTOP_DATA, `desktop-drop.${extension}`));
        return [kind, 'sha256:' + createHash('sha256').update(bytes).digest('hex')];
      }),
    );
    let state;
    try {
      await waitFor(async () => {
        state = await droppedMediaState(window, projectId, fingerprints);
        return state.saved;
      }, 'Dropped video, image and audio were not saved');
    } catch (error) {
      throw new Error(`${error.message}: ${JSON.stringify(state)}`, { cause: error });
    }
    result.mediaDrop = projectId;
    const fixture = process.env.OPENDIRECTOR_DESKTOP_SMOKE_LARGE_VIDEO;
    if (fixture) result.largeVideo = await smokeLargeVideo(window, host, projectId, JSON.parse(fixture), result.projectIds.length === 1);
  }
  if (result.projectIds.length === 1) await smokeTraceWindows(window, result.projectIds[0]);
  result.sidebarInitiallyOpen = await window.webContents.executeJavaScript("document.querySelector('.cw-workspace').dataset.desktopSidebar === 'open'");
  if (!result.sidebarInitiallyOpen) {
    await window.webContents.executeJavaScript("document.querySelector('.od-caption-actions button').click()");
    await waitFor(() => window.webContents.executeJavaScript("document.querySelector('.cw-workspace').dataset.desktopSidebar === 'open'"), 'Sidebar did not expand');
  }
  if (process.platform === 'win32') {
    const bounds = window.getBounds();
    try {
      window.setSize(800, bounds.height);
      await waitFor(() => window.webContents.executeJavaScript('innerWidth <= 800'), 'Windows test window did not resize');
      await checkWindowsCaption(window);
    } finally {
      window.setBounds(bounds);
    }
  }
  if (result.projectIds.length === 1) {
    await window.webContents.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: navigator.platform.startsWith('Mac'), ctrlKey: !navigator.platform.startsWith('Mac'), bubbles: true }))");
    result.projectIds = await waitFor(() => window.webContents.executeJavaScript(`fetch('/api/creation/projects', {headers: {'X-OpenDirector-Request': '1'}})
      .then(r => r.json()).then(value => value.projects.length === 2 ? value.projects.map(project => project.id).sort() : null)`), 'New project shortcut did not persist a project');
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('.cw-project-name-editor input')"), 'New project name did not become editable');
    await window.webContents.executeJavaScript("document.querySelector('.cw-project-name-editor input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('.cw-save-status i.saved')"), 'New project did not finish saving');
  }
  await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('.od-project-sidebar nav button')"), 'Sidebar projects did not load');
  // Opening a trace window can leave the native focus on its closing child.
  // Finish the project rename and focus the main window before testing keyboard focus.
  await waitFor(() => window.webContents.executeJavaScript("!document.querySelector('.cw-project-name-editor input')"), 'Project rename did not finish');
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
  window.webContents.focus();
  await waitFor(() => window.isFocused(), 'Desktop window could not take focus before search');
  await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-search-toggle').click()");
  await waitFor(() => window.webContents.executeJavaScript("document.activeElement === document.querySelector('.od-sidebar-search')"), 'Project search did not take focus');
  const firstProject = await window.webContents.executeJavaScript("document.querySelector('.od-project-sidebar nav button span').textContent");
  for (const query of ['__no_matching_project__', `  ${firstProject.toLocaleUpperCase()}  `, '']) {
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.od-sidebar-search');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => window.webContents.executeJavaScript(query === '__no_matching_project__' ? "!!document.querySelector('.od-sidebar-empty') && !document.querySelector('.od-project-sidebar nav button')" : "!!document.querySelector('.od-project-sidebar nav button') && !document.querySelector('.od-sidebar-empty')"), 'Sidebar project search failed');
  }
  await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-search-close').click()");
  await waitFor(() => window.webContents.executeJavaScript("!document.querySelector('.od-sidebar-search') && document.activeElement === document.querySelector('.od-sidebar-search-toggle')"), 'Closing search did not restore focus');
  await window.webContents.executeJavaScript("document.querySelector('.od-caption-actions button').click()");
  await delay(200);
  await window.webContents.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: navigator.platform.startsWith('Mac'), ctrlKey: !navigator.platform.startsWith('Mac'), bubbles: true }))");
  await waitFor(() => window.webContents.executeJavaScript("document.activeElement === document.querySelector('.od-sidebar-search')"), 'Project search shortcut failed');
  await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor(() => window.webContents.executeJavaScript("!document.querySelector('.od-sidebar-search')"), 'Escape did not close project search');
  const captionInteractive = await window.webContents.executeJavaScript("[...document.querySelectorAll('.od-caption-actions button, .od-caption-actions svg')].every(element => getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'no-drag')");
  if (!captionInteractive) throw new Error('Caption buttons overlap native drag regions');
  const evidence = process.env.OPENDIRECTOR_DESKTOP_EVIDENCE;
  for (const language of ['en-US', 'zh-CN']) {
    await window.webContents.executeJavaScript(`window.dispatchEvent(new StorageEvent('storage', { key: 'opendirector.locale.v1', newValue: '${language}' }))`);
    await delay(500);
    const current = await window.webContents.executeJavaScript('document.documentElement.lang');
    if (current !== language || getLocale() !== language) throw new Error('Desktop locale synchronization failed');
    if (!(await window.webContents.executeJavaScript('!!document.querySelector(".react-flow") && !!document.querySelector(".cw-save-status i.saved")'))) throw new Error('Canvas was lost during language switching');
    const settingsStyle = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.od-sidebar-settings .cw-icon-button');
      return button && getComputedStyle(button).visibility === 'visible' && button.querySelector('svg') && !button.textContent.trim();
    })()`);
    if (!settingsStyle) throw new Error('Sidebar settings did not reuse the canvas icon button');
    await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-settings .cw-icon-button').click()");
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('.cw-settings-dialog[open]')"), 'Sidebar settings did not open');
    await window.webContents.executeJavaScript("document.querySelector('.cw-settings-close').click()");
    await waitFor(() => window.webContents.executeJavaScript("!document.querySelector('.cw-settings-dialog[open]')"), 'Settings did not close');
    await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-project-more').click()");
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('.od-sidebar-project-menu [role=menuitem]')"), 'Project menu did not open');
    const deleteLabel = await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-project-menu').textContent");
    if (!deleteLabel.includes(language === 'en-US' ? 'Delete' : '删除')) throw new Error('Project delete action was not localized');
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, `project-menu-${language}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-project-menu button').click()");
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('dialog[open] .cw-project-dialog-actions')"), 'Delete confirmation did not open');
    await window.webContents.executeJavaScript("document.querySelector('dialog[open] .cw-project-dialog-actions button').click()");
    await waitFor(() => window.webContents.executeJavaScript("!document.querySelector('dialog[open]')"), 'Delete cancellation did not close confirmation');
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      const button = await window.webContents.executeJavaScript("(() => { const r = document.querySelector('.od-sidebar-create').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
      window.webContents.sendInputEvent({ type: 'mouseMove', ...button });
      await waitFor(() => window.webContents.executeJavaScript("getComputedStyle(document.querySelector('.od-sidebar-create-shortcut')).opacity === '1'"), 'New project hover shortcut was not visible');
      writeFileSync(join(evidence, `new-project-hover-${language}.png`), (await window.webContents.capturePage()).toPNG());
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 300, y: 100 });
      await waitFor(() => window.webContents.executeJavaScript("getComputedStyle(document.querySelector('.od-sidebar-create-shortcut')).opacity === '0'"), 'New project shortcut stayed visible after hover');
      await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-search-toggle').click()");
      await delay(200);
      writeFileSync(join(evidence, `search-open-${language}.png`), (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-search-close').click()");
      await delay(200);
      for (const state of ['expanded', 'collapsed']) {
        if (state === 'collapsed') {
          await window.webContents.executeJavaScript("document.querySelector('.od-caption-actions button').click()");
          await delay(500);
        }
        const placements = await window.webContents.executeJavaScript(`(() => {
          const open = document.querySelector('.cw-workspace').dataset.desktopSidebar === 'open';
          return { open, create: document.querySelectorAll(open ? '.od-sidebar-create' : '.od-caption-actions button').length };
        })()`);
        if (placements.open !== (state === 'expanded') || placements.create !== (state === 'expanded' ? 1 : 2)) throw new Error('New project button placement failed');
        window.webContents.invalidate();
        await delay(200);
        writeFileSync(join(evidence, `sidebar-${state}-${language}.png`), (await window.webContents.capturePage()).toPNG());
      }
      await window.webContents.executeJavaScript("document.querySelector('.od-caption-actions button').click()");
      await delay(500);
    }
  }
  if (process.platform === 'darwin') {
    const chrome = await window.webContents.executeJavaScript(`(() => {
      const header = document.querySelector('.cw-topbar');
      return { top: header.getBoundingClientRect().top,
        canvasTop: document.querySelector('.react-flow').getBoundingClientRect().top,
        padding: getComputedStyle(header).paddingLeft,
        drag: getComputedStyle(header).getPropertyValue('-webkit-app-region') };
    })()`);
    if (chrome.top !== 0 || chrome.canvasTop !== 48 || chrome.padding !== '20px' || chrome.drag !== 'drag') throw new Error('Desktop chrome layout failed: ' + JSON.stringify(chrome));
    window.show();
    app.focus({ steal: true });
    window.focus();
    await waitFor(() => window.isVisible() && window.isFocused(), 'Desktop window could not take focus before fullscreen');
    for (const fullscreen of [true, false]) {
      window.setFullScreen(fullscreen);
      await waitFor(() => window.isFullScreen() === fullscreen,
        `Native fullscreen transition failed: target=${fullscreen}`);
      await waitFor(() => window.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-desktop-fullscreen') === ${fullscreen}`),
        `Fullscreen chrome synchronization failed: target=${fullscreen}`);
    }
    await window.webContents.executeJavaScript("document.querySelector('.od-caption-actions button').click()");
    await delay(500);
    const bounds = window.getBounds();
    window.setSize(800, 600);
    await delay(200);
    const fits = await window.webContents.executeJavaScript(`(() => {
      const language = document.querySelector('.cw-topbar .cw-language-toggle').getBoundingClientRect();
      const title = document.querySelector('.cw-topbar .cw-project-selector').getBoundingClientRect();
      const actions = document.querySelector('.cw-top-actions').getBoundingClientRect();
      return title.right <= language.left && language.right <= actions.left && actions.right <= innerWidth;
    })()`);
    if (!fits) throw new Error('Desktop controls overlap in a narrow window');
    window.setBounds(bounds);
    await delay(200);
    await window.webContents.executeJavaScript("document.querySelector('.od-caption-actions button').click()");
    await delay(500);
    result.chrome = chrome;
  }
  if (process.env.OPENDIRECTOR_DESKTOP_SMOKE_DELETE === '1') {
    await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-create').click()");
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('.cw-project-name-editor input')"), 'Deletion test project was not created');
    await window.webContents.executeJavaScript("document.querySelector('.cw-project-name-editor input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('.cw-save-status i.saved') && !document.querySelector('.cw-project-name-editor input')"), 'Deletion test project was not saved');
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('.od-sidebar-project-select[aria-current=page]')"), 'New project row did not load');
    await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-project-select[aria-current=page]').parentElement.querySelector('.od-sidebar-project-more').click()");
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('.od-sidebar-project-menu button')"), 'Delete test menu did not open');
    await window.webContents.executeJavaScript("document.querySelector('.od-sidebar-project-menu button').click()");
    await waitFor(() => window.webContents.executeJavaScript("!!document.querySelector('dialog[open] button[type=submit]')"), 'Delete test confirmation did not open');
    await window.webContents.executeJavaScript("document.querySelector('dialog[open] button[type=submit]').click()");
    await waitFor(() => window.webContents.executeJavaScript(`(async () => {
      const response = await fetch('/api/creation/projects', {headers: {'X-OpenDirector-Request': '1'}});
      const value = await response.json();
      return !document.querySelector('dialog[open]') && !!document.querySelector('.cw-save-status i.saved') &&
        !!document.querySelector('.cw-workspace[aria-busy=false]') &&
        !!document.querySelector('.od-sidebar-project-select[aria-current=page]') &&
        JSON.stringify(value.projects.map(p => p.id).sort()) === '${JSON.stringify(result.projectIds)}';
    })()`), 'Deleting the open test project did not restore the remaining projects');
    result.projectDeletion = true;
  }
  await waitFor(() => window.webContents.executeJavaScript(
    "!!document.querySelector('.od-sidebar-project-select:not([aria-current]):not(:disabled)')"),
    'No other editable project was available for rapid switching');
  for (let attempt = 0; attempt < 8; attempt++) {
    const switched = await window.webContents.executeJavaScript(`(async () => {
      const target = document.querySelector('.od-sidebar-project-select:not([aria-current]):not(:disabled)');
      const canvas = document.querySelector('.react-flow');
      for (let click = 0; click < 5; click++) target.click();
      const deadline = performance.now() + 5000;
      do {
        await new Promise(requestAnimationFrame);
        if (document.querySelector('.canvas-loading-screen') ||
            document.querySelector('.react-flow') !== canvas) {
          throw new Error('Project switch obscured or replaced the canvas surface');
        }
        if (target.matches('[aria-current="page"]') &&
            document.querySelector('.cw-workspace[aria-busy="false"]')) return true;
      } while (performance.now() < deadline);
      return false;
    })()`);
    if (!switched) throw new Error('Rapid project switching did not settle');
  }
  result.sidebarFinallyOpen = process.env.OPENDIRECTOR_DESKTOP_SMOKE_SIDEBAR === 'open';
  if (await window.webContents.executeJavaScript("document.querySelector('.cw-workspace').dataset.desktopSidebar === 'open'") !== result.sidebarFinallyOpen) {
    await window.webContents.executeJavaScript("document.querySelector('.od-caption-actions button').click()");
  }
  await waitFor(() => window.webContents.executeJavaScript(`localStorage.getItem('opendirector.desktop.sidebar.v1') === '${result.sidebarFinallyOpen ? 'open' : 'closed'}'`), 'Sidebar preference was not saved');
  await window.webContents.executeJavaScript('window.opendirectorDesktop.setExporting(true)');
  await delay(50);
  window.close();
  if (window.isVisible() || !(await host.inspect())) throw new Error('Closing a window stopped the Host');
  return result;
}

async function smokeLargeVideo(window, host, projectId, fixture, firstLaunch) {
  const { webContents } = window;
  const name = 'large-video.mp4';
  if (firstLaunch) {
    await webContents.executeJavaScript(`(${guardLargeVideoDataUrl})(${JSON.stringify(name)})`);
    const cdp = webContents.debugger;
    cdp.attach();
    try {
      const { root } = await cdp.sendCommand('DOM.getDocument');
      const { nodeId } = await cdp.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'input[type=file][aria-label="Choose local asset files"], input[type=file][aria-label="选择本地素材文件"]',
      });
      if (!nodeId) throw new Error('Canvas local file input is absent');
      await cdp.sendCommand('DOM.setFileInputFiles', {
        nodeId, files: [join(process.env.OPENDIRECTOR_DESKTOP_DATA, name)],
      });
    } finally {
      cdp.detach();
    }
  }
  const binding = await waitFor(() => webContents.executeJavaScript(
    `(${largeVideoState})(${JSON.stringify(projectId)}, ${JSON.stringify(fixture)})`,
  ), 'Large video did not bind to a saved canvas node', 300);
  if (binding.blocked) throw new Error('Large video import attempted FileReader.readAsDataURL');
  const response = await fetch(`${host.url}/api/creation/projects/${projectId}/assets/${binding.assetId}/content`, {
    headers: { 'X-OpenDirector-Request': '1', 'X-OpenDirector-Desktop': host.token },
  });
  await verifyLargeVideoBytes(response, fixture);
  return binding;
}

async function dropMedia(window) {
  const { webContents } = window;
  const { x, y } = await webContents.executeJavaScript(`(() => {
    const bounds = document.querySelector('.react-flow').getBoundingClientRect();
    return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
  })()`);
  const files = ['mp4', 'wav', 'png'].map(extension =>
    join(process.env.OPENDIRECTOR_DESKTOP_DATA, `desktop-drop.${extension}`));
  const data = { items: [], files, dragOperationsMask: 1 };
  const debuggerSession = webContents.debugger;
  debuggerSession.attach();
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await debuggerSession.sendCommand('Input.dispatchDragEvent', { type, x, y, data });
    }
  } finally {
    debuggerSession.detach();
  }
}

async function droppedMediaState(window, projectId, fingerprints) {
  return window.webContents.executeJavaScript(`(async () => {
    const response = await fetch('/api/creation/projects/' + ${JSON.stringify(projectId)}, {
      headers: { 'X-OpenDirector-Request': '1' },
    });
    if (!response.ok) return { status: response.status };
    const { canvasItems, assets } = await response.json();
    const saved = Object.entries(${JSON.stringify(fingerprints)}).every(([kind, fingerprint]) =>
      canvasItems.some(item => item.kind === kind && item.binding.role === 'material' &&
        assets.some(asset => asset.id === item.binding.objectRef.assetId && asset.kind === kind &&
          asset.provenance.source === 'upload' && asset.fingerprint === fingerprint)));
    return { saved, nodes: canvasItems.map(item => item.kind), assets: assets.map(asset => asset.name),
      notice: document.querySelector('.cw-toast [role="status"]')?.textContent };
  })()`);
}

async function checkWindowsWelcomeCaption(window) {
  const originalBounds = window.getBounds();
  const [minWidth] = window.getMinimumSize();
  try {
    window.setSize(minWidth, originalBounds.height);
    const bounds = await waitFor(() => window.webContents.executeJavaScript(`(() => {
      const overlay = navigator.windowControlsOverlay;
      const language = document.querySelector('dialog.cw-welcome[open] .cw-welcome-language');
      if (innerWidth > ${minWidth} || !overlay?.visible || !language) return null;
      return { captionBottom: overlay.getTitlebarAreaRect().bottom, languageTop: language.getBoundingClientRect().top };
    })()`), 'Windows welcome or caption did not appear at minimum width');
    if (bounds.languageTop < bounds.captionBottom) {
      throw new Error(`Window controls overlap the welcome language selector: ${JSON.stringify(bounds)}`);
    }
  } finally {
    window.setBounds(originalBounds);
  }
}

async function checkWindowsCaption(window) {
  if (window.isMenuBarVisible()) throw new Error('Windows application menu is visible');
  let bounds;
  try {
    await waitFor(async () => {
      bounds = await window.webContents.executeJavaScript(`(() => {
        const overlay = navigator.windowControlsOverlay;
        const actions = document.querySelector('.cw-top-actions');
        return {
          visible: overlay?.visible,
          titlebarRight: overlay?.getTitlebarAreaRect().right,
          toolbarRight: actions?.getBoundingClientRect().right,
        };
      })()`);
      return bounds.visible && bounds.toolbarRight <= bounds.titlebarRight;
    }, 'Window controls overlap the workspace toolbar');
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(bounds)}`, { cause: error });
  }
}

async function smokeTraceWindows(window, projectId) {
  const evaluate = code => window.webContents.executeJavaScript(code);
  const projectPath = await evaluate(`fetch('/api/creation/projects', {headers: {'X-OpenDirector-Request': '1'}})
    .then(response => response.json()).then(({projects}) => projects.find(project => project.id === '${projectId}').path)`);
  const folder = join(projectPath, 'agent-runs');
  mkdirSync(folder, { recursive: true });
  const openedChat = await evaluate(`(() => {
    const toggle = document.querySelector('.cw-chat-button');
    if (toggle.getAttribute('aria-expanded') === 'true') return false;
    toggle.click();
    return true;
  })()`);
  const editor = ".cw-assistant-composer [contenteditable=true]";
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(editor)})?.checkVisibility()`), 'Assistant composer did not open');
  await waitFor(() => evaluate(`(() => {
    const chat = document.querySelector('#canvas-assistant').getBoundingClientRect();
    const canvas = document.querySelector('.cw-canvas-region').getBoundingClientRect();
    const sidebar = document.querySelector('.cw-workspace[data-desktop-sidebar=open] .od-project-sidebar');
    return chat.left >= (sidebar?.getBoundingClientRect().right ?? 0) && chat.right <= canvas.left;
  })()`), 'The project sidebar, conversation and canvas overlap');
  await evaluate(`document.querySelector(${JSON.stringify(editor)}).focus()`);
  await window.webContents.insertText('Draft before opening trace');
  const draft = () => evaluate(`document.querySelector(${JSON.stringify(editor)})?.textContent`);
  await waitFor(async () => (await draft())?.includes('Draft before opening trace'), 'Assistant draft input was not accepted');

  for (const live of [false, true]) {
    const turn = live ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001';
    const file = join(folder, `${turn}.opencode.jsonl`);
    const event = text => JSON.stringify({ type: 'model.reasoning', text }) + '\n';
    const first = live ? 'Live trace begins' : 'Historical trace';
    writeFileSync(file, event(first));
    const query = new URLSearchParams({ traceProject: projectId, turn, runtime: 'opencode', ...(live ? { live: '1' } : {}) });
    await evaluate(`window.open('/?${query}', '_blank', 'noopener,noreferrer'); undefined`);
    const child = await waitFor(() => BrowserWindow.getAllWindows().find(item =>
      item.getParentWindow() === window && item.webContents.getURL().includes(turn)), 'Desktop trace did not open in its own window');
    const contains = text => child.webContents.executeJavaScript(
      `document.querySelector('.cw-trace-page')?.innerText.includes(${JSON.stringify(text)})`);
    await waitFor(() => contains(first), 'Trace window did not read the stored trace');
    appendFileSync(file, event('Trace file updated'));
    if (live) await waitFor(() => contains('Trace file updated'), 'Live trace did not refresh');
    else if (await contains('Trace file updated')) throw new Error('Historical trace unexpectedly refreshed');
    child.close();
    await waitFor(() => child.isDestroyed(), 'Trace window did not close');
    if (!(await draft())?.includes('Draft before opening trace')) throw new Error('Closing the trace lost the assistant draft');
  }
  window.focus();
  await evaluate(`document.querySelector(${JSON.stringify(editor)}).focus()`);
  await window.webContents.insertText(' and continued afterward');
  await waitFor(async () => (await draft())?.includes('continued afterward'), 'Assistant composer stopped accepting input');
  if (openedChat) await evaluate("document.querySelector('.cw-chat-button').click()");
}

async function waitFor(check, message, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}
