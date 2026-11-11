"""Atomic metadata publication under readers and Windows sharing conflicts."""
from concurrent.futures import ThreadPoolExecutor
import errno
import json
import os
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import pytest

from opendirector.infrastructure import local_projects as local
from opendirector.domain.projects import ProjectError
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects


def test_atomic_json_publication_preserves_open_reader_and_publishes_after_close(tmp_path, monkeypatch):
    path = tmp_path / 'state.json'
    before, after = {'revision': 1}, {'revision': 2, 'text': '中文'}
    local.write_json(path, before)
    original = os.replace
    attempted, blocked = Event(), Event()
    def replacing(source, target):
        attempted.set()
        try:
            return original(source, target)
        except PermissionError as error:
            assert os.name == 'nt' and error.winerror in {5, 32, 33}
            blocked.set()
            raise
    monkeypatch.setattr(local.os, 'replace', replacing)
    with ThreadPoolExecutor(max_workers=1) as pool:
        reader = path.open('rb')
        try:
            published = pool.submit(local.write_json, path, after)
            assert attempted.wait(3)
            if os.name == 'nt':
                assert blocked.wait(3), 'Real Windows reader must exercise sharing failure'
                assert not published.done()
                assert json.loads(path.read_text()) == before
            assert json.load(reader) == before
        finally:
            reader.close()
        published.result(timeout=3)
    assert local.read_json(path) == after
    assert list(tmp_path.glob('.opendirector-*.tmp')) == []


@pytest.mark.parametrize('winerror', [5, 32, 33, 2, 112])
def test_atomic_json_persistent_and_unrelated_errors_keep_old_bytes(tmp_path, monkeypatch, winerror):
    path = tmp_path / 'state.json'
    local.write_json(path, {'revision': 1})
    original = path.read_bytes()
    failure = OSError(errno.EACCES, 'blocked')
    failure.winerror = winerror
    calls, delays = [], []
    clock = [0.0]
    def replacing(*args):
        calls.append(args)
        raise failure
    def sleeping(seconds):
        delays.append(seconds)
        clock[0] += seconds
    proxy = SimpleNamespace(**{name: getattr(os, name) for name in dir(os) if not name.startswith('__')})
    proxy.name, proxy.replace = 'nt', replacing
    monkeypatch.setattr(local, 'os', proxy)
    monkeypatch.setattr(local, 'time', SimpleNamespace(monotonic=lambda: clock[0], sleep=sleeping))
    with pytest.raises(OSError) as caught:
        local.write_json(path, {'revision': 2})
    assert caught.value is failure
    assert path.read_bytes() == original
    assert list(tmp_path.glob('.opendirector-*.tmp')) == []
    if winerror in {5, 32, 33}:
        assert len(calls) > 1 and 0 < sum(delays) <= 1
    else:
        assert len(calls) == 1 and delays == []


def test_atomic_json_rechecks_link_rejection_before_retry(tmp_path, monkeypatch):
    path = tmp_path / 'state.json'
    local.write_json(path, {'revision': 1})
    original = path.read_bytes()
    state = dict(link=False, attempts=0)
    is_symlink = type(path).is_symlink
    monkeypatch.setattr(type(path), 'is_symlink',
        lambda entry: state['link'] if local._json_path(entry) == local._json_path(path) else is_symlink(entry))
    failure = PermissionError(errno.EACCES, 'reader holds target')
    failure.winerror = 5
    def replacing(*args):
        state['attempts'] += 1
        raise failure
    def sleeping(seconds):
        state['link'] = True
    proxy = SimpleNamespace(**{name: getattr(os, name) for name in dir(os) if not name.startswith('__')})
    proxy.name, proxy.replace = 'nt', replacing
    monkeypatch.setattr(local, 'os', proxy)
    monkeypatch.setattr(local, 'time', SimpleNamespace(monotonic=lambda: 0.0, sleep=sleeping))
    with pytest.raises(ProjectError, match='不能覆盖符号链接'):
        local.write_json(path, {'revision': 2})
    assert state['attempts'] == 1
    assert path.read_bytes() == original
    assert list(tmp_path.glob('.opendirector-*.tmp')) == []


def test_project_commit_and_reopen_with_metadata_path_beyond_max_path(tmp_path, monkeypatch):
    # The project directory itself fits MAX_PATH; immutable commit paths do not.
    repository = tmp_path / ('p' * max(1, 140 - len(str(tmp_path.resolve()))))
    store = CreationProjects(local.LocalProjects(repository))
    targets = []
    original = os.replace
    def replacing(source, target):
        targets.append(str(target).removeprefix('\\\\?\\'))
        return original(source, target)
    monkeypatch.setattr(local.os, 'replace', replacing)
    command = parse_command(dict(type='project.create', projectId=uuid4(), commandId=uuid4(),
        payload={'name': '中文 metadata'}))
    assert store.execute(command).status == 'applied'
    directory = store.local.root / '中文 metadata'
    commit = directory / 'commits' / (str(command.commandId) + '.json')
    assert any(len(target) > 260 for target in targets)
    assert local.read_json(commit)['command']['commandId'] == str(command.commandId)
    restarted = CreationProjects(local.LocalProjects(repository))
    assert restarted.snapshot(command.projectId).project.name == '中文 metadata'
    assert list(directory.rglob('.opendirector-*.tmp')) == []


def test_long_metadata_read_and_replace_use_the_same_checked_path(tmp_path):
    directory = tmp_path / ('d' * 80) / ('n' * 80)
    type(directory)(local._json_path(directory)).mkdir(parents=True)
    path = directory / ('s' * 80 + '.json')
    assert len(str(path)) > 260
    local.write_json(path, {'revision': 1, 'text': '中文'})
    assert local.read_json(path) == {'revision': 1, 'text': '中文'}
    local.write_json(path, {'revision': 2})
    assert local.read_json(path) == {'revision': 2}
    assert list(type(directory)(local._json_path(directory)).glob('.opendirector-*.tmp')) == []
