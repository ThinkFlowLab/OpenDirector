"""Private native fixture setup preserves caller identity and permission bits."""
import os
import stat

import pytest

from process_helpers import directory_link, native_user_directory
from process_helpers import project_heartbeat


def test_native_directory_uses_same_owner_and_is_idempotent(tmp_path):
    before = tmp_path.stat()
    report = native_user_directory(tmp_path)
    assert tmp_path.stat().st_ino == before.st_ino
    if os.name == 'nt':
        assert report['owner'] in report['descriptor'].split('G:', 1)[0]
        assert native_user_directory(tmp_path) == report
    else:
        assert report is None
        assert stat.S_IMODE(tmp_path.stat().st_mode) == stat.S_IMODE(before.st_mode)


def test_native_directory_refuses_nonempty_directory(tmp_path):
    sentinel = tmp_path / 'sentinel'; sentinel.write_bytes(b'keep')
    with pytest.raises(ValueError, match='empty'):
        native_user_directory(tmp_path)
    assert sentinel.read_bytes() == b'keep'


def test_native_directory_refuses_file(tmp_path):
    sentinel = tmp_path / 'sentinel'; sentinel.write_bytes(b'keep')
    with pytest.raises(ValueError, match='ordinary directory'):
        native_user_directory(sentinel)
    assert sentinel.read_bytes() == b'keep'


def test_native_directory_refuses_alias(tmp_path):
    target = tmp_path / 'target'; target.mkdir()
    alias = tmp_path / 'alias'; directory_link(alias, target)
    try:
        with pytest.raises(ValueError, match='ordinary directory'):
            native_user_directory(alias)
        assert target.is_dir() and list(target.iterdir()) == []
    finally:
        alias.rmdir() if os.name == 'nt' else alias.unlink()


def test_native_directory_preserves_denials_and_parent(tmp_path):
    if os.name == 'nt':
        import subprocess
        parent_before = subprocess.check_output(['icacls.exe', str(tmp_path.parent)])
        subprocess.run(['icacls.exe', str(tmp_path), '/deny', '*S-1-1-0:(DC)'], check=True, capture_output=True)
        before = subprocess.check_output(['icacls.exe', str(tmp_path)])
        report = native_user_directory(tmp_path)
        assert subprocess.check_output(['icacls.exe', str(tmp_path)]) == before
        assert '(D;' in report['descriptor'] and ';;;WD)' in report['descriptor']
        assert native_user_directory(tmp_path) == report
        assert subprocess.check_output(['icacls.exe', str(tmp_path.parent)]) == parent_before
    else:
        tmp_path.chmod(0o500)
        try:
            assert native_user_directory(tmp_path) is None
            assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o500
        finally:
            tmp_path.chmod(0o700)


def test_project_heartbeat_uses_one_existing_identity_and_stops():
    import time
    from types import SimpleNamespace
    calls = []
    class Client:
        def put(self, path, json):
            calls.append((path, json))
            return SimpleNamespace(status_code=200, text='ok')
    with project_heartbeat(Client(), 'project', 'session', interval=.01) as result:
        deadline = time.monotonic() + 2
        while result['count'] < 2 and time.monotonic() < deadline: time.sleep(.01)
        assert result['count'] >= 2
    final = list(calls); time.sleep(.03)
    assert calls == final
    assert all(item == ('/api/creation/sessions/session', {'projectId': 'project'}) for item in calls)


def test_project_heartbeat_surfaces_a_refused_renewal():
    import time
    from types import SimpleNamespace
    calls = []
    class Client:
        def put(self, path, json):
            calls.append((path, json))
            return SimpleNamespace(status_code=200 if len(calls) == 1 else 409, text='locked')
    with pytest.raises(AssertionError, match='409'):
        with project_heartbeat(Client(), 'project', 'session', interval=.01) as result:
            deadline = time.monotonic() + 2
            while not result['failures'] and time.monotonic() < deadline: time.sleep(.01)
            assert result['failures']
    assert len(calls) == 2


def test_project_heartbeat_stops_when_the_stream_fails():
    import time
    from types import SimpleNamespace
    calls = []
    class Client:
        def put(self, path, json):
            calls.append((path, json))
            return SimpleNamespace(status_code=200, text='ok')
    with pytest.raises(RuntimeError, match='stream failed'):
        with project_heartbeat(Client(), 'project', 'session', interval=.01):
            raise RuntimeError('stream failed')
    final = list(calls); time.sleep(.03)
    assert calls == final
