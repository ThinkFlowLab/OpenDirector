"""Bounded fallback discovery for external harnesses outside the server PATH."""
import os
from pathlib import Path
import shutil
import sys
from collections.abc import Iterator, Mapping


def _newest(root: Path, pattern: str) -> list[Path]:
    try:
        return sorted(root.glob(pattern), key=lambda p: (p.stat().st_mtime_ns, str(p)), reverse=True)
    except OSError:
        return []


def codex_candidates(home: Path, platform: str, env: Mapping[str, str]) -> Iterator[Path]:
    if platform == 'win32':
        local = Path(env.get('LOCALAPPDATA') or home / 'AppData/Local')
        # Desktop versions use opaque directory names: prefer the most recently installed.
        for base in dict.fromkeys((local, home / 'AppData/Local')):
            yield from _newest(base / 'OpenAI/Codex/bin', '*/codex.exe')
    yield from common_candidates('codex', home, platform, env)
    if platform == 'darwin':
        for apps in (home / 'Applications', Path('/Applications')):
            yield apps / 'Codex.app/Contents/Resources/codex'


def common_candidates(name: str, home: Path, platform: str, env: Mapping[str, str]) -> Iterator[Path]:
    """Only inspect known bin directories and bounded version-manager layouts."""
    bins = [home / '.local/bin', home / '.bun/bin', home / '.volta/bin']
    if name == 'opencode':
        bins.insert(0, home / '.opencode/bin')
    elif name == 'claude':
        bins.append(home / '.claude/local')
    for key in ('PIPX_BIN_DIR', 'UV_TOOL_BIN_DIR'):
        if value := env.get(key):
            bins.append(Path(value).expanduser())
    if platform == 'win32':
        local = Path(env.get('LOCALAPPDATA') or home / 'AppData/Local')
        roaming = Path(env.get('APPDATA') or home / 'AppData/Roaming')
        bins.extend((home / 'scoop/shims', roaming / 'npm', home / 'AppData/Roaming/npm'))
        if prefix := env.get('NPM_CONFIG_PREFIX'):
            bins.append(Path(prefix))
        if nvm := env.get('NVM_HOME'):
            bins.extend(_newest(Path(nvm), 'v*'))
        if name in {'dsh', 'jiuwenswarm-process'}:
            bins.append(Path(sys.executable).parent)
            for base in dict.fromkeys((roaming, home / 'AppData/Roaming')):
                bins.extend(_newest(base / 'Python', 'Python*/Scripts'))
            for base in dict.fromkeys((local, home / 'AppData/Local')):
                bins.extend(_newest(base / 'Programs/Python', 'Python*/Scripts'))
        suffixes = ('.exe', '.cmd', '.bat')
    else:
        bins.append(home / '.npm-global/bin')
        if prefix := env.get('NPM_CONFIG_PREFIX'):
            bins.append(Path(prefix) / 'bin')
        nvm = Path(env.get('NVM_DIR') or home / '.nvm')
        bins.extend(_newest(nvm, 'versions/node/*/bin'))
        bins.extend((Path('/usr/local/bin'), Path('/usr/bin')))
        if platform == 'darwin':
            bins.append(Path('/opt/homebrew/bin'))
            if name in {'dsh', 'jiuwenswarm-process'}:
                bins.extend(_newest(home / 'Library/Python', '*/bin'))
        if name in {'dsh', 'jiuwenswarm-process'}:
            bins.append(Path(sys.executable).parent)
        suffixes = ('',)
    for directory in bins:
        for suffix in suffixes:
            yield directory / (name + suffix)


def cli_executable(name: str) -> str | None:
    if path := shutil.which(name):
        return path
    # Names are internal command IDs, never shell input or user-provided paths.
    if name not in {'codex', 'claude', 'opencode', 'dsh', 'jiuwenswarm-process'}:
        return None
    candidates = (codex_candidates(Path.home(), sys.platform, os.environ) if name == 'codex'
        else common_candidates(name, Path.home(), sys.platform, os.environ))
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        except OSError:
            continue
    return None
