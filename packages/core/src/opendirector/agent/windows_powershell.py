#!python -I
"""Run OpenCode's Windows PowerShell command with UTF-8 native pipelines."""

import asyncio
from contextlib import suppress
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


_COMMAND_ENV = 'OPENDIRECTOR_POWERSHELL_COMMAND'
_BOOTSTRAP = r"""
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (& {
    $source = [Environment]::GetEnvironmentVariable('OPENDIRECTOR_POWERSHELL_COMMAND')
    [Environment]::SetEnvironmentVariable('OPENDIRECTOR_POWERSHELL_COMMAND', $null)
    # A dot-sourced script can hide the last native command's failure. Check
    # inside the script so the shell still exits 1 (or honors an explicit exit).
    [scriptblock]::Create($source + [Environment]::NewLine + 'if (-not $?) { exit 1 }')
})
"""


def system_powershell():
    return Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'


def _select_shell(configured, env):
    # OpenCode checks its configured shell (or SHELL), then pwsh, then
    # powershell. The remaining Git Bash/cmd fallbacks need no encoding setup.
    path = env.get('PATH', '')
    preferred = configured or env.get('SHELL')
    if preferred and Path(preferred).stem.lower() not in {'nu', 'fish'}:
        if Path(preferred).stem.lower() == 'bash':
            # OpenCode resolves bare bash through Git for Windows before PATH.
            return None
        if executable := shutil.which(preferred, path=path):
            return Path(executable)
    if not shutil.which('pwsh', path=path):
        if executable := shutil.which('powershell', path=path):
            return Path(executable)
    return None


async def configure_opencode(binary, cwd, env, directory):
    if os.name != 'nt' or 'OPENCODE_CONFIG_CONTENT' not in env:
        return
    powershell = system_powershell()
    if not powershell.is_file():
        return

    # Ask the same OpenCode binary to resolve its config before setting shell.
    # This preserves explicit Git Bash/PowerShell 7 choices in user config.
    try:
        process = await asyncio.create_subprocess_exec(
            binary, 'debug', 'config', '--pure', cwd=cwd, env=env,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except OSError:
        return
    try:
        raw, _ = await asyncio.wait_for(process.communicate(), 10)
    except TimeoutError:
        return
    finally:
        if process.returncode is None:
            with suppress(ProcessLookupError):
                process.kill()
            await process.wait()

    if process.returncode:
        return
    try:
        config = json.loads(raw)
    except ValueError:
        return
    selected = _select_shell(config.get('shell'), env)
    if selected is None or selected.resolve() != powershell.resolve():
        return

    env['OPENCODE_CONFIG_CONTENT'] = json.dumps({
        **json.loads(env['OPENCODE_CONFIG_CONTENT']),
        'shell': str(make_launcher(directory)),
    })


def make_launcher(directory):
    from distlib.scripts import ScriptMaker

    source = Path(__file__)
    maker = ScriptMaker(str(source.parent), str(directory))
    maker.force = True
    launcher = Path(maker.make(source.name)[0])
    # OpenCode uses the basename to select PowerShell arguments and parsing.
    return launcher.replace(directory / 'powershell.exe')


def main():
    args = sys.argv[1:]
    env = dict(os.environ)
    if len(args) >= 2 and args[-2].lower() in {'-command', '-c'} and args[-1] != '-':
        env[_COMMAND_ENV] = args[-1]
        args[-1] = _BOOTSTRAP
    return subprocess.call(
        [str(system_powershell()), *args], env=env, creationflags=subprocess.CREATE_NO_WINDOW,
        stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
    )


if __name__ == '__main__':
    sys.exit(main())
