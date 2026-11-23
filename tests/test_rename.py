import pytest
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.rename import rename_path


pytestmark = pytest.mark.cpu


def test_native_rename_never_replaces_even_an_empty_destination(tmp_path):
    source, target = tmp_path / "source", tmp_path / "target"
    source.mkdir()
    target.mkdir()
    (source / "keep").write_text("original")
    with pytest.raises((ProjectError, OSError)):
        rename_path(source, target)
    assert (source / "keep").read_text() == "original"
    assert target.is_dir()


@pytest.mark.parametrize("directory", [False, True])
def test_rename_without_noreplace_support_still_never_replaces(tmp_path, monkeypatch, directory):
    """NFS rejects RENAME_NOREPLACE with EINVAL; files fall back to link+unlink, directories to a checked rename."""
    import ctypes
    import errno

    from opendirector.infrastructure import rename

    class Library:
        def __init__(self, *args, **kwargs):
            def unsupported(*arguments):
                ctypes.set_errno(errno.EINVAL)
                return -1
            self.renameat2 = self.renamex_np = unsupported

    monkeypatch.setattr(rename.ctypes, "CDLL", Library)
    source, target = tmp_path / "source", tmp_path / "target"
    if directory:
        source.mkdir()
        (source / "keep").write_text("original")
    else:
        source.write_text("original")
    rename_path(source, target)
    assert not source.exists() and ((target / "keep") if directory else target).read_text() == "original"
    if directory:
        source.mkdir()
    else:
        source.write_text("new")
    with pytest.raises(ProjectError, match="已存在"):
        rename_path(source, target)
    assert source.exists() and ((target / "keep") if directory else target).read_text() == "original"
