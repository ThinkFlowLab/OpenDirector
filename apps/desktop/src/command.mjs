import { readFile, readlink, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function registerCommand({ destination, launcher }) {
  await mkdir(dirname(destination), { recursive: true });
  const windows = process.platform === 'win32';
  const script = `@"${launcher}" %*\r\n`;
  try {
    if (windows) await writeFile(destination, script, { flag: 'wx' });
    else await symlink(launcher, destination);
    return 'installed';
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const matches = windows
    ? await readFile(destination, 'utf8').then(value => value === script, () => false)
    : await readlink(destination).then(value => value === launcher, () => false);
  if (matches) return 'already_installed';
  throw new Error('command_collision');
}

export const commandPath = home => join(home, '.local', 'bin', process.platform === 'win32' ? 'opendirector.cmd' : 'opendirector');
