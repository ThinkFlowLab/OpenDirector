/** Build-host prerequisites: uv, Node/npm and a standalone FFmpeg/ffprobe directory. */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const runtime = join(desktop, 'runtime');
const media = process.env.OPENDIRECTOR_FFMPEG_DIR;
if (!media) throw new Error('Set OPENDIRECTOR_FFMPEG_DIR to standalone ffmpeg and ffprobe binaries for this target.');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
// runtime/ is a generated artifact: start from a clean distribution so a Python build from an earlier
// run cannot be packaged beside the one this run installs.
const pythonDirectory = join(runtime, 'python');
rmSync(pythonDirectory, { recursive: true, force: true });
mkdirSync(join(runtime, 'bin'), { recursive: true });
run('uv', ['python', 'install', '3.12', '--install-dir', pythonDirectory, '--no-bin']);
const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const installations = readdirSync(pythonDirectory, { withFileTypes: true });
// uv leaves a version-less alias beside the concrete distribution (a symlink on POSIX, a junction on
// Windows). A Windows-target package dereferences that link while archiving, so keeping it would copy
// the whole runtime twice and roughly double the installer size and install time.
for (const entry of installations) if (entry.isSymbolicLink()) rmSync(join(pythonDirectory, entry.name));
const distributions = installations.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() &&
  entry.name.startsWith('cpython-3.12') && entry.name.includes(architecture));
if (distributions.length !== 1) throw new Error(`Expected exactly one standalone Python distribution, found ${distributions.length}`);
const distribution = distributions[0].name;
const python = join(pythonDirectory, distribution, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const wheels = join(root, 'build/desktop-wheel');
mkdirSync(wheels, { recursive: true });
run('uv', ['build', '--wheel', '--out-dir', wheels]);
const wheel = readdirSync(wheels).find(name => name.startsWith('opendirector-') && name.endsWith('.whl'));
if (!wheel) throw new Error('OpenDirector wheel was not produced');
run('uv', ['pip', 'install', '--break-system-packages', '--reinstall-package', 'opendirector', '--python', python, join(wheels, wheel)]);
for (const name of ['ffmpeg', 'ffprobe']) {
  const executable = name + (process.platform === 'win32' ? '.exe' : '');
  copyFileSync(join(media, executable), join(runtime, 'bin', executable));
  chmodSync(join(runtime, 'bin', executable), 0o755);
  if (process.platform === 'darwin') {
    const target = spawnSync('file', [join(runtime, 'bin', executable)], { encoding: 'utf8' });
    if (target.status !== 0 || !target.stdout.includes(process.arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error(`${name} does not match the target architecture`);
  }
  const license = spawnSync(join(runtime, 'bin', executable), ['-L'], { encoding: 'utf8' });
  if (license.status !== 0) throw new Error(`${name} license inspection failed`);
  writeFileSync(join(runtime, 'bin', `LICENSE.${name}.txt`), license.stdout + license.stderr);
  run(join(runtime, 'bin', executable), ['-version']);
}
const pythonRelative = relative(runtime, python);
const desktopExecutable = process.platform === 'darwin' ? '../../MacOS/OpenDirector' : process.platform === 'win32' ? '../../OpenDirector.exe' : '../../opendirector-desktop';
const workspace = process.platform === 'darwin' ? '$HOME/Library/Application Support/OpenDirector/workspace' : '${XDG_CONFIG_HOME:-$HOME/.config}/OpenDirector/workspace';
const unix = `#!/bin/sh\nset -eu\nSCRIPT="$0"\nwhile [ -L "$SCRIPT" ]; do\n BASE=$(CDPATH= cd -- "$(dirname -- "$SCRIPT")" && pwd)\n LINK=$(readlink "$SCRIPT")\n case "$LINK" in /*) SCRIPT="$LINK" ;; *) SCRIPT="$BASE/$LINK" ;; esac\ndone\nRUNTIME=$(CDPATH= cd -- "$(dirname -- "$SCRIPT")/.." && pwd)\nexport PATH="$RUNTIME/bin:$PATH"\nexport OPENDIRECTOR_ROOT="\${OPENDIRECTOR_ROOT:-${workspace}}"\nexport OPENDIRECTOR_DESKTOP_EXECUTABLE="$RUNTIME/${desktopExecutable}"\nexec "$RUNTIME/${pythonRelative}" -I -B -m opendirector.cli "$@"\n`;
if (process.platform === 'win32') writeFileSync(join(runtime, 'bin/opendirector.cmd'), `@echo off\r\nset "PATH=%~dp0;%PATH%"\r\nif not defined OPENDIRECTOR_ROOT set "OPENDIRECTOR_ROOT=%APPDATA%\\OpenDirector\\workspace"\r\nset "OPENDIRECTOR_DESKTOP_EXECUTABLE=%~dp0..\\${desktopExecutable}"\r\n"%~dp0..\\${pythonRelative}" -I -B -X utf8 -m opendirector.cli %*\r\n`);
else { writeFileSync(join(runtime, 'bin/opendirector'), unix); chmodSync(join(runtime, 'bin/opendirector'), 0o755); }
run(python, ['-I', '-X', 'utf8', '-m', 'opendirector.cli', '--help']);
writeFileSync(join(runtime, 'manifest.json'), JSON.stringify({ version: 1, platform: process.platform, arch: process.arch,
  python: pythonRelative, application: JSON.parse(readFileSync(join(root, 'package.json'))).version }, null, 2));
