import os

import pytest

from opendirector.agent import cli_discovery as discovery
from opendirector.agent import deepseek, jiuwenswarm, native, runtime


def test_path_has_priority(monkeypatch):
    monkeypatch.setattr(discovery.shutil, 'which', lambda _: '/chosen/codex')
    def unexpected(*args):
        raise AssertionError('fallback must not run when PATH resolves')
    monkeypatch.setattr(discovery, 'codex_candidates', unexpected)
    assert native.executable('codex') == '/chosen/codex'


@pytest.mark.parametrize(('platform', 'relative'), [
    ('win32', 'AppData/Local/OpenAI/Codex/bin/version/codex.exe'),
    ('win32', 'AppData/Roaming/npm/codex.cmd'),
    ('linux', '.local/bin/codex'),
    ('linux', '.nvm/versions/node/v24/bin/codex'),
    ('darwin', 'Applications/Codex.app/Contents/Resources/codex'),
])
def test_common_installs_reach_shared_runtime(monkeypatch, tmp_path, platform, relative):
    binary = tmp_path / relative
    binary.parent.mkdir(parents=True)
    binary.touch()
    binary.chmod(0o755)
    monkeypatch.setattr(discovery.shutil, 'which', lambda _: None)
    candidates = list(discovery.codex_candidates(tmp_path, platform, {}))
    assert binary in candidates
    monkeypatch.setattr(discovery, 'codex_candidates', lambda *args: iter(candidates))
    # Ignore host-global installs: this test represents an isolated user's machine.
    monkeypatch.setattr(discovery.os, 'access', lambda path, mode: path == binary)
    assert runtime.installation('codex') == str(binary)
    assert runtime.runtime_available('codex') is True


def test_desktop_versions_use_install_time(tmp_path):
    root = tmp_path / 'AppData/Local/OpenAI/Codex/bin'
    older = root / 'zzz/codex.exe'
    newer = root / 'aaa/codex.exe'
    for index, binary in enumerate((older, newer)):
        binary.parent.mkdir(parents=True)
        binary.touch()
        os.utime(binary, (1000000000 + index, 1000000000 + index))
    candidates = list(discovery.codex_candidates(tmp_path, 'win32', {}))
    assert candidates[:2] == [newer, older]


def test_skip_missing_directory_and_nonexecutable(monkeypatch, tmp_path):
    folder = tmp_path / 'codex-dir'
    folder.mkdir()
    blocked = tmp_path / 'codex'
    blocked.touch()
    monkeypatch.setattr(discovery.shutil, 'which', lambda _: None)
    monkeypatch.setattr(discovery, 'codex_candidates', lambda *args: iter([
        tmp_path / 'missing', folder, blocked,
    ]))
    monkeypatch.setattr(discovery.os, 'access', lambda *args: False)
    assert native.executable('codex') is None


@pytest.mark.parametrize('platform', ['win32', 'linux', 'darwin'])
def test_custom_npm_prefix(tmp_path, platform):
    prefix = tmp_path / 'custom-npm'
    candidates = list(discovery.codex_candidates(tmp_path, platform, {'NPM_CONFIG_PREFIX': str(prefix)}))
    expected = prefix / ('codex.cmd' if platform == 'win32' else 'bin/codex')
    assert expected in candidates


@pytest.mark.parametrize('name', ['opencode', 'claude', 'dsh', 'jiuwenswarm-process'])
@pytest.mark.parametrize('platform', ['win32', 'linux', 'darwin'])
def test_external_harness_path_priority(monkeypatch, name, platform):
    monkeypatch.setattr(discovery.sys, 'platform', platform)
    monkeypatch.setattr(discovery.shutil, 'which', lambda command: '/chosen/' + command)
    def unexpected(*args):
        raise AssertionError('fallback must not run when PATH resolves')
    monkeypatch.setattr(discovery, 'common_candidates', unexpected)
    assert discovery.cli_executable(name) == '/chosen/' + name


@pytest.mark.parametrize(('name', 'platform', 'relative'), [
    ('opencode', 'win32', '.opencode/bin/opencode.exe'),
    ('opencode', 'linux', '.opencode/bin/opencode'),
    ('claude', 'win32', '.local/bin/claude.exe'),
    ('claude', 'linux', '.claude/local/claude'),
    ('claude', 'darwin', '.local/bin/claude'),
    ('opencode', 'darwin', '.bun/bin/opencode'),
    ('dsh', 'win32', 'AppData/Roaming/Python/Python314/Scripts/dsh.exe'),
    ('dsh', 'linux', '.local/bin/dsh'),
    ('dsh', 'darwin', 'Library/Python/3.14/bin/dsh'),
    ('jiuwenswarm-process', 'win32', 'AppData/Local/Programs/Python/Python314/Scripts/jiuwenswarm-process.exe'),
    ('jiuwenswarm-process', 'linux', '.local/bin/jiuwenswarm-process'),
    ('jiuwenswarm-process', 'darwin', 'Library/Python/3.14/bin/jiuwenswarm-process'),
    ('claude', 'win32', 'AppData/Roaming/npm/claude.cmd'),
    ('opencode', 'linux', '.nvm/versions/node/v24/bin/opencode'),
])
def test_fallback_shared_by_detection_and_commands(monkeypatch, tmp_path, name, platform, relative):
    binary = tmp_path / relative
    binary.parent.mkdir(parents=True)
    binary.touch()
    binary.chmod(0o755)
    candidates = list(discovery.common_candidates(name, tmp_path, platform, {}))
    assert binary in candidates
    monkeypatch.setattr(discovery.shutil, 'which', lambda _: None)
    monkeypatch.setattr(discovery, 'common_candidates', lambda *args: iter(candidates))
    monkeypatch.setattr(discovery.os, 'access', lambda path, mode: path == binary)
    engine = {'dsh': 'deepseek', 'jiuwenswarm-process': 'jiuwenswarm'}.get(name, name)
    assert runtime.installation(engine) == str(binary)
    if name == 'dsh':
        monkeypatch.setenv('DSH_HOME', str(tmp_path / 'empty-config'))
        assert deepseek.arguments(tmp_path)[0] == str(binary)
    elif name == 'jiuwenswarm-process':
        assert jiuwenswarm.executable() == str(binary)
    else:
        assert native.command(engine, tmp_path, str(tmp_path / 'socket'), 'token', '', '', [])[0][0] == str(binary)


@pytest.mark.parametrize('name', ['opencode', 'claude', 'dsh', 'jiuwenswarm-process'])
@pytest.mark.parametrize('platform', ['win32', 'linux', 'darwin'])
def test_external_harness_custom_prefix_and_missing(monkeypatch, tmp_path, name, platform):
    prefix = tmp_path / 'npm'
    candidates = list(discovery.common_candidates(name, tmp_path, platform, {'NPM_CONFIG_PREFIX': str(prefix)}))
    assert prefix / (name + '.cmd' if platform == 'win32' else 'bin/' + name) in candidates
    monkeypatch.setattr(discovery.shutil, 'which', lambda _: None)
    monkeypatch.setattr(discovery, 'common_candidates', lambda *args: iter([tmp_path / 'missing']))
    assert discovery.cli_executable(name) is None


def test_windows_redirected_appdata_keeps_standard_locations(tmp_path):
    env = {'APPDATA': str(tmp_path / 'redirected'), 'LOCALAPPDATA': str(tmp_path / 'redirected-local')}
    assert tmp_path / 'AppData/Roaming/npm/claude.cmd' in list(
        discovery.common_candidates('claude', tmp_path, 'win32', env))
