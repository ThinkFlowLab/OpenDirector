"""POSIX ownership/error paths use real syscalls on POSIX, a dir-fd adapter on Windows.

The Windows adapter exercises Python control flow and real CRT descriptors; it
is explicitly not evidence that Linux/macOS syscalls have been tested.
"""
import errno
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from opendirector.domain.projects import ProjectError
from opendirector.infrastructure import execution_files as files


@pytest.fixture
def posix_files(monkeypatch):
    actual = os
    proxy = SimpleNamespace(**{name: getattr(actual, name) for name in dir(actual) if not name.startswith('__')})
    opened, duplicated, closed, paths = [], [], [], {}
    if os.name == 'nt':
        import ctypes
        import msvcrt
        from opendirector.infrastructure.windows_execution_files import kernel
        def opening(path, flags, mode=0o600, *, dir_fd=None):
            path = Path(path) if dir_fd is None else paths[dir_fd] / path
            creating = bool(flags & actual.O_CREAT)
            handle = kernel.CreateFileW(str(path), 0x40000000 if creating else 0x80000000,
                7, None, 1 if creating else 3, 0x02000000 | 0x00200000, None)
            if handle == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            fd = msvcrt.open_osfhandle(handle, actual.O_WRONLY if creating else actual.O_RDONLY)
            paths[fd] = path
            opened.append(fd)
            return fd
        def unlinking(path, *, dir_fd=None):
            (Path(path) if dir_fd is None else paths[dir_fd] / path).unlink()
        proxy.name = 'posix'
        proxy.O_NOFOLLOW = 1 << 26
        proxy.O_DIRECTORY = 1 << 27
        proxy.O_NONBLOCK = 0
        proxy.unlink = unlinking
    else:
        def opening(*args, **kwargs):
            fd = actual.open(*args, **kwargs)
            opened.append(fd)
            return fd
    def duplicating(fd):
        duplicate = actual.dup(fd)
        duplicated.append(duplicate)
        return duplicate
    def closing(fd):
        actual.close(fd)
        closed.append(fd)
    proxy.open, proxy.dup, proxy.close = opening, duplicating, closing
    proxy.supports_dir_fd = {*actual.supports_dir_fd, opening}
    monkeypatch.setattr(files, 'os', proxy)
    return proxy, opened, duplicated, closed


@pytest.mark.parametrize('kind', ['directory', 'empty'])
def test_posix_rejects_non_regular_or_empty_inputs_before_dup(tmp_path, posix_files, kind):
    proxy, opened, duplicated, closed = posix_files
    target = tmp_path / 'input'
    target.mkdir() if kind == 'directory' else target.touch()
    for _ in range(100):
        with pytest.raises(ProjectError, match='非空普通文件'):
            with files.execution_file(tmp_path, 'input'):
                pytest.fail('Invalid input was yielded')
    assert duplicated == []
    assert len(opened) == len(closed)


@pytest.mark.parametrize('create', [False, True])
@pytest.mark.parametrize('failure', [OSError, RuntimeError])
def test_posix_fdopen_failures_close_original_and_duplicate(tmp_path, posix_files, create, failure):
    proxy, opened, duplicated, closed = posix_files
    if not create:
        (tmp_path / 'input').write_bytes(b'owned')
    sentinel = tmp_path / 'preserved'; sentinel.write_bytes(b'keep')
    def failed_fdopen(*args):
        raise failure('fdopen failed')
    proxy.fdopen = failed_fdopen
    for _ in range(30):
        with pytest.raises(failure, match='fdopen failed'):
            with files.execution_file(tmp_path, 'output' if create else 'input', create=create):
                pytest.fail('Failed wrapper was yielded')
        if create:
            assert (tmp_path / 'output').read_bytes() == b''
            (tmp_path / 'output').unlink()
    assert len(duplicated) == 30
    assert len(closed) == len(opened) + len(duplicated)
    for fd in set(opened + duplicated):
        with pytest.raises(OSError) as error:
            os.fstat(fd)
        assert error.value.errno == errno.EBADF
    assert sentinel.read_bytes() == b'keep'


@pytest.mark.parametrize('create', [False, True])
def test_posix_dup_failure_releases_directories_and_file(tmp_path, posix_files, create):
    proxy, opened, duplicated, closed = posix_files
    (tmp_path / 'input').write_bytes(b'keep')
    def failed_dup(fd):
        raise OSError('dup failed')
    proxy.dup = failed_dup
    with pytest.raises(OSError, match='dup failed'):
        with files.execution_file(tmp_path, 'output' if create else 'input', create=create):
            pytest.fail('Failed duplicate was yielded')
    assert duplicated == []
    assert len(opened) == len(closed)
    if create: assert (tmp_path / 'output').read_bytes() == b''
    else: assert not (tmp_path / 'output').exists()
    assert (tmp_path / 'input').read_bytes() == b'keep'


def test_posix_regular_binary_file_roundtrip_and_exclusive_creation(tmp_path, posix_files):
    _, opened, duplicated, _ = posix_files
    content = b'\x00\r\n\xff' * 4096
    with files.execution_file(tmp_path, '中文.bin', create=True) as stream:
        assert not os.get_inheritable(stream.fileno())
        stream.write(content)
    with files.execution_file(tmp_path, '中文.bin') as stream:
        assert not os.get_inheritable(stream.fileno())
        assert stream.read() == content
    with pytest.raises(OSError):
        with files.execution_file(tmp_path, '中文.bin', create=True):
            pytest.fail('Existing file was overwritten')
    assert (tmp_path / '中文.bin').read_bytes() == content
    for fd in set(opened + duplicated):
        with pytest.raises(OSError):
            os.fstat(fd)


@pytest.mark.skipif(os.name == 'nt', reason='requires POSIX rename of an open file')
@pytest.mark.parametrize('replacement', [False, True])
def test_posix_failed_output_never_unlinks_a_replaced_name(tmp_path, posix_files, replacement):
    _, opened, duplicated, _ = posix_files
    target, moved = tmp_path / 'output', tmp_path / 'moved'
    with pytest.raises(RuntimeError, match='export failed'):
        with files.execution_file(tmp_path, 'output', create=True) as stream:
            stream.write(b'owned partial output')
            target.rename(moved)
            if replacement: target.write_bytes(b'other writer bytes')
            raise RuntimeError('export failed')
    assert moved.read_bytes() == b'owned partial output'
    if replacement:
        assert target.read_bytes() == b'other writer bytes'
        with pytest.raises(FileExistsError):
            with files.execution_file(tmp_path, 'output', create=True):
                pytest.fail('Retry overwrote another writer')
    else: assert not target.exists()
    for fd in set(opened + duplicated):
        with pytest.raises(OSError): os.fstat(fd)
