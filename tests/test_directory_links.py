"""Harness aliases must work without elevation and preserve their targets."""
import pytest

from opendirector.agent.directory_links import link_directory, unlink_directory


def test_directory_alias_roundtrip_and_dangling_cleanup(tmp_path):
    target = tmp_path / 'private skills'
    target.mkdir()
    sentinel = target / 'resource.txt'
    sentinel.write_text('keep')
    alias = tmp_path / 'alias'
    link_directory(alias, target)
    assert (alias / sentinel.name).read_text() == 'keep'
    unlink_directory(alias)
    assert sentinel.read_text() == 'keep'
    link_directory(alias, target)
    sentinel.unlink()
    target.rmdir()
    unlink_directory(alias)
    assert not alias.exists()
    unlink_directory(alias)  # Missing aliases are harmless.


def test_directory_alias_never_replaces_real_files_or_directories(tmp_path):
    target = tmp_path / 'target'
    target.mkdir()
    occupied = tmp_path / 'occupied'
    occupied.mkdir()
    sentinel = occupied / 'user.txt'
    sentinel.write_text('keep')
    with pytest.raises(OSError):
        link_directory(occupied, target)
    with pytest.raises(FileExistsError):
        unlink_directory(occupied)
    assert sentinel.read_text() == 'keep'
    with pytest.raises(FileExistsError):
        unlink_directory(sentinel)
    assert sentinel.read_text() == 'keep'
