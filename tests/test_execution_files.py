"""Exercise real files/handles, including Windows reparse and replacement boundaries."""
import os
from pathlib import Path

import pytest

from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.execution_files import execution_file


def test_execution_file_rejects_a_hardlink_to_an_outside_file(tmp_path):
    work = tmp_path / 'work'
    work.mkdir()
    outside = tmp_path / 'private'
    outside.write_bytes(b'outside bytes')
    os.link(outside, work / 'input')
    with pytest.raises(ProjectError) as error:
        with execution_file(work, 'input'):
            pytest.fail('Hardlinked outside input was accepted')
    assert error.value.status == 403 and error.value.code == 'execution_file_link'
    assert outside.read_bytes() == b'outside bytes'


def test_nested_unicode_file_roundtrip_and_exclusive_creation(tmp_path):
    work = tmp_path / 'work'; work.mkdir()
    (work / 'nested').mkdir()
    name = 'nested/中文 🎬 包.zip'
    content = bytes(range(256)) * 4096
    with execution_file(work, name, create=True) as stream:
        assert not os.get_inheritable(stream.fileno())
        stream.write(content)
    with execution_file(work, str(work / name)) as stream:
        assert not os.get_inheritable(stream.fileno())
        assert stream.read() == content
        assert stream.seek(12) == 12
    with pytest.raises(OSError):
        with execution_file(work, name, create=True):
            pytest.fail('Existing output must not be overwritten')
    assert (work / name).read_bytes() == content


@pytest.mark.parametrize('create', [False, True])
def test_lexical_escape_and_root_are_rejected(tmp_path, create):
    work = tmp_path / 'work'; work.mkdir()
    outside = tmp_path / 'outside.zip'; outside.write_bytes(b'outside')
    for name in ['../outside.zip', str(outside), str(work), '.']:
        with pytest.raises(ProjectError, match='本轮执行目录'):
            with execution_file(work, name, create=create):
                pytest.fail('Outside path was opened')
    assert outside.read_bytes() == b'outside'


def test_failed_create_and_flush_preserve_platform_output_ownership(tmp_path, monkeypatch):
    work = tmp_path / 'work'; work.mkdir()
    preserved = work / 'preserved'; preserved.write_bytes(b'keep')
    with pytest.raises(RuntimeError, match='copy failed'):
        with execution_file(work, 'partial.zip', create=True) as stream:
            stream.write(b'partial')
            raise RuntimeError('copy failed')
    if os.name == 'nt': assert not (work / 'partial.zip').exists()
    else:
        assert (work / 'partial.zip').read_bytes() == b'partial'
        with pytest.raises(FileExistsError):
            with execution_file(work, 'partial.zip', create=True):
                pytest.fail('Retry overwrote incomplete output')
    def failed_sync(fd):
        raise OSError('flush failed')
    monkeypatch.setattr(os, 'fsync', failed_sync)
    with pytest.raises(OSError, match='flush failed'):
        with execution_file(work, 'flush.zip', create=True) as stream:
            stream.write(b'partial')
    if os.name == 'nt': assert not (work / 'flush.zip').exists()
    else:
        assert (work / 'flush.zip').read_bytes() == b'partial'
        (work / 'partial.zip').unlink(); (work / 'flush.zip').unlink()
    assert preserved.read_bytes() == b'keep'
    # Every directory handle is released, including on error.
    preserved.unlink(); work.rmdir()


def test_empty_files_and_directories_are_rejected(tmp_path):
    (tmp_path / 'empty').touch()
    (tmp_path / 'folder').mkdir()
    for name in ['empty', 'folder']:
        with pytest.raises(ProjectError, match='非空普通文件'):
            with execution_file(tmp_path, name):
                pytest.fail('Not a nonempty ordinary file')


def test_symbolic_links_are_not_followed(tmp_path):
    work = tmp_path / 'work'; work.mkdir()
    outside = tmp_path / 'outside'; outside.mkdir()
    target = outside / 'input'; target.write_bytes(b'outside')
    try:
        (work / 'link').symlink_to(target)
        (work / 'directory-link').symlink_to(outside, target_is_directory=True)
    except OSError as error:
        if getattr(error, 'winerror', None) == 1314:
            pytest.skip('Windows symlink privilege unavailable; junction tests run separately')
        raise
    for name, create in [('link', False), ('link', True), ('directory-link/input', False), ('directory-link/output', True)]:
        with pytest.raises(OSError):
            with execution_file(work, name, create=create):
                pytest.fail('Link traversal was allowed')
    assert target.read_bytes() == b'outside'
    assert not (outside / 'output').exists()


@pytest.mark.skipif(os.name != 'nt', reason='Windows file namespace')
@pytest.mark.parametrize('name', ['input:stream', 'input::$DATA', 'NUL', 'NUL.zip', 'CON',
                                  'COM1', 'LPT9.txt', 'trailing.', 'trailing ', 'sub/NUL/file',
                                  'sub./output', 'sub /output'])
def test_windows_device_aliases_and_alternate_streams_are_rejected(tmp_path, name):
    source = tmp_path / 'input'; source.write_bytes(b'keep')
    for create in [False, True]:
        with pytest.raises(OSError):
            with execution_file(tmp_path, name, create=create):
                pytest.fail('Special Windows filename was opened')
    assert source.read_bytes() == b'keep'
    assert sorted(p.name for p in tmp_path.iterdir()) == ['input']


@pytest.mark.skipif(os.name != 'nt', reason='Windows junctions need no symlink privilege')
def test_windows_junctions_are_rejected_even_when_the_target_is_inside_work(tmp_path):
    import _winapi
    work = tmp_path / 'work'; work.mkdir()
    for target in [tmp_path / 'outside', work / 'inside']:
        target.mkdir()
        (target / 'input').write_bytes(b'original')
        alias = work / 'alias'
        _winapi.CreateJunction(str(target), str(alias))
        try:
            for name, create in [('alias/input', False), ('alias/output', True)]:
                with pytest.raises(OSError):
                    with execution_file(work, name, create=create):
                        pytest.fail('Junction traversal was allowed')
            assert not (target / 'output').exists()
            assert (target / 'input').read_bytes() == b'original'
        finally:
            alias.rmdir()


@pytest.mark.skipif(os.name != 'nt', reason='Windows handle sharing')
def test_windows_open_directories_cannot_be_replaced_during_lookup(tmp_path, monkeypatch):
    from opendirector.infrastructure import windows_execution_files as windows
    child = tmp_path / 'nested'; child.mkdir()
    original = windows._open_relative
    attempted = []
    def open_then_replace(parent, name, **options):
        handle = original(parent, name, **options)
        if options.get('directory') and name == 'nested':
            with pytest.raises(OSError):
                child.rename(tmp_path / 'moved')
            attempted.append(name)
        return handle
    monkeypatch.setattr(windows, '_open_relative', open_then_replace)
    with execution_file(tmp_path, 'nested/output', create=True) as stream:
        stream.write(b'owned')
        with pytest.raises(OSError):
            (child / 'output').rename(child / 'replaced')
    assert attempted == ['nested']
    assert (child / 'output').read_bytes() == b'owned'
    child.rename(tmp_path / 'moved')  # No leaked ancestor handles.


@pytest.mark.skipif(os.name != 'nt', reason='Windows handle sharing')
def test_windows_input_cannot_be_rewritten_or_deleted_until_closed(tmp_path):
    target = tmp_path / 'input'; target.write_bytes(b'original')
    with execution_file(tmp_path, 'input') as stream:
        with pytest.raises(OSError): target.write_bytes(b'changed')
        with pytest.raises(OSError): target.unlink()
        assert stream.read() == b'original'
    target.write_bytes(b'after close')
    assert target.read_bytes() == b'after close'


@pytest.mark.parametrize('component', ['work', 'turn', 'agent-runs'])
@pytest.mark.parametrize('create', [False, True])
@pytest.mark.parametrize('absolute', [False, True])
def test_execution_root_and_ancestors_cannot_redirect_file_access(tmp_path, component, create, absolute):
    from process_helpers import directory_link
    work = tmp_path / 'project/agent-runs/turn/work'
    work.mkdir(parents=True)
    anchor = {'work': work, 'turn': work.parent, 'agent-runs': work.parent.parent}[component]
    outside = tmp_path / 'outside'
    outside_work = outside / work.relative_to(anchor)
    outside_work.mkdir(parents=True)
    sentinel = outside_work / 'input'
    sentinel.write_bytes(b'outside must stay private')
    anchor.rename(anchor.with_name(anchor.name + '-original'))
    directory_link(anchor, outside)
    name = 'output' if create else 'input'
    try:
        with pytest.raises(OSError):
            with execution_file(work, str(work / name) if absolute else name, create=create):
                pytest.fail('Redirected root was accepted')
        assert sentinel.read_bytes() == b'outside must stay private'
        assert not (outside_work / 'output').exists()
    finally:
        anchor.rmdir() if os.name == 'nt' else anchor.unlink()


@pytest.mark.parametrize('create', [False, True])
def test_root_replacement_during_component_lookup_never_reaches_outside(tmp_path, monkeypatch, create):
    from process_helpers import directory_link
    from opendirector.infrastructure import execution_files as files
    work = tmp_path / 'work'; work.mkdir()
    (work / 'input').write_bytes(b'owned')
    moved = tmp_path / 'moved'
    outside = tmp_path / 'outside'; outside.mkdir()
    (outside / 'input').write_bytes(b'outside')
    state = dict(attempted=False, linked=False, blocked=False)
    if os.name == 'nt':
        from opendirector.infrastructure import windows_execution_files as implementation
        original = implementation._open_relative
        attribute = '_open_relative'
    else:
        implementation, original, attribute = files.os, files.os.open, 'open'
    def replacing(name_or_parent, *args, **kwargs):
        name = args[0] if os.name == 'nt' else name_or_parent
        if name == 'work' and not state['attempted']:
            state['attempted'] = True
            try:
                work.rename(moved)
                directory_link(work, outside)
                state['linked'] = True
            except OSError:
                state['blocked'] = True
        return original(name_or_parent, *args, **kwargs)
    monkeypatch.setattr(implementation, attribute, replacing)
    if os.name != 'nt':
        monkeypatch.setattr(files.os, 'supports_dir_fd', {*os.supports_dir_fd, replacing})
    try:
        try:
            with execution_file(work, 'output' if create else 'input', create=create) as stream:
                assert state['blocked'] and not state['linked']
                if create:
                    stream.write(b'owned output')
                else:
                    assert stream.read() == b'owned'
        except OSError:
            assert state['attempted']
        assert state['attempted']
        assert (outside / 'input').read_bytes() == b'outside'
        assert not (outside / 'output').exists()
    finally:
        if state['linked']:
            work.rmdir() if os.name == 'nt' else work.unlink()


@pytest.mark.parametrize('create', [False, True])
def test_bound_root_survives_ancestor_replacement_before_file_open(tmp_path, monkeypatch, create):
    from process_helpers import directory_link
    from opendirector.infrastructure import execution_files as files
    turn = tmp_path / 'turn'
    work = turn / 'work'; work.mkdir(parents=True)
    (work / 'input').write_bytes(b'owned')
    outside = tmp_path / 'outside'
    (outside / 'work').mkdir(parents=True)
    (outside / 'work/input').write_bytes(b'outside')
    moved = tmp_path / 'moved'
    state = dict(attempted=False, linked=False, moved=False)
    filename = 'output' if create else 'input'
    if os.name == 'nt':
        from opendirector.infrastructure import windows_execution_files as implementation
        original, attribute = implementation._open_relative, '_open_relative'
    else:
        implementation, original, attribute = files.os, files.os.open, 'open'
    def replacing(name_or_parent, *args, **kwargs):
        name = args[0] if os.name == 'nt' else name_or_parent
        if name == filename and not state['attempted']:
            state['attempted'] = True
            try:
                turn.rename(moved)
                state['moved'] = True
                directory_link(turn, outside)
                state['linked'] = True
            except OSError:
                pass  # Windows may block renaming an ancestor of the pinned root.
        return original(name_or_parent, *args, **kwargs)
    monkeypatch.setattr(implementation, attribute, replacing)
    if os.name != 'nt':
        monkeypatch.setattr(files.os, 'supports_dir_fd', {*os.supports_dir_fd, replacing})
    try:
        with execution_file(work, filename, create=create) as stream:
            if create:
                stream.write(b'owned output')
            else:
                assert stream.read() == b'owned'
        assert state['attempted']
        actual_work = moved / 'work' if state['moved'] else work
        assert (actual_work / 'input').read_bytes() == b'owned'
        if create:
            assert (actual_work / 'output').read_bytes() == b'owned output'
        assert (outside / 'work/input').read_bytes() == b'outside'
        assert not (outside / 'work/output').exists()
    finally:
        if state['linked']:
            turn.rmdir() if os.name == 'nt' else turn.unlink()
