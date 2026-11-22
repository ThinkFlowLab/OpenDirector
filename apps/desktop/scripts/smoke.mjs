import { copyFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLargeVideo } from './large-video.mjs';
import { spawn } from 'node:child_process';

const binary = process.argv[2];
if (!binary) throw new Error('Usage: node scripts/smoke.mjs /path/to/packaged/OpenDirector');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'opendirector-desktop-')));
let logOffset = 0;
let previous;
let mediaProject;
let sidebarOpen = false;
let largeVideo;
try {
 const video = process.platform === 'win32'
  ? await createLargeVideo(join(directory, 'large-video.mp4'))
  : null;
 const fixtures = [
  ['desktop-drop.mp4', '../../../tests/fixtures/timeline-text/visual-a.mp4'],
  ['desktop-drop.wav', '../../../tests/fixtures/timeline-text/audio-a.wav'],
  ['desktop-drop.png', '../../../src/assets/open_director_logo.png'],
 ];
 for (const [name, source] of fixtures) {
  await copyFile(fileURLToPath(new URL(source, import.meta.url)), join(directory, name));
 }
 for (let attempt = 0; attempt < 3; attempt++) {
  const child = spawn(binary, ['--smoke'], {
    env: {
      ...process.env,
      OPENDIRECTOR_DESKTOP_DATA: directory,
      OPENDIRECTOR_DESKTOP_SMOKE_LARGE_VIDEO: video ? JSON.stringify(video) : '',
      OPENDIRECTOR_DESKTOP_SMOKE_MEDIA_PROJECT: mediaProject ?? '',
      OPENDIRECTOR_DESKTOP_SMOKE_DELETE: attempt === 2 ? '1' : '',
      OPENDIRECTOR_DESKTOP_SMOKE_SIDEBAR: attempt === 0 ? 'open' : 'closed',
    },
    stdio: 'inherit',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timeout));
  const log = await readFile(join(directory, 'logs/desktop.log'), 'utf8');
  const latest = log.slice(logOffset).split('\n').findLast(line => line.startsWith('smoke {'));
  logOffset = log.length;
  if (result !== 0 || !latest) throw new Error(`Packaged desktop smoke failed on launch ${attempt + 1} (${result}):\n${log}`);
  const receipt = JSON.parse(latest.slice(6));
  if (!receipt.mediaDrop || (mediaProject && receipt.mediaDrop !== mediaProject)) throw new Error('Desktop media drop was not verified');
  mediaProject = receipt.mediaDrop;
  if (video) {
    if (!receipt.largeVideo || (largeVideo && JSON.stringify(largeVideo) !== JSON.stringify(receipt.largeVideo)))
      throw new Error('Large video node or asset identity changed across launches');
    largeVideo = receipt.largeVideo;
  }
  if (receipt.sidebarInitiallyOpen !== sidebarOpen) throw new Error('Sidebar default or restored state is incorrect');
  sidebarOpen = receipt.sidebarFinallyOpen;
  const current = receipt.projectIds;
  if (previous && JSON.stringify(previous) !== JSON.stringify(current)) throw new Error('Reopening changed the project identities');
  previous = current;
 }
  process.stdout.write('Packaged canvas, media drag-and-drop, authenticated API, isolation, both locales, hidden-window Host, reopen and sidebar preferences: passed\n');
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
