"""Real initialized-session ACLs stay immutable while ancestors are leased."""
import asyncio
import ctypes as c
from ctypes import wintypes as w
import os
import shutil

import pytest

from opendirector.agent import owner_rights as rights
from test_owner_rights_lifecycle import security
from process_helpers import directory_link

pytestmark = pytest.mark.skipif(os.name != 'nt', reason='requires native Windows ACL and file identity APIs')


def initialized_work(tmp_path):
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    async def first():
        async with rights.native_owner_access(work):
            skill = work / '.agents/skills/example'; skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('original skill', encoding='utf-8')
            (work / 'retained.txt').write_text('中文 existing result', encoding='utf-8')
    asyncio.run(first())
    return work


@pytest.mark.parametrize('outcome', ['complete', 'failure', 'cancel'])
def test_initialized_lease_preserves_file_acls_across_skill_replacement_and_exit(tmp_path, outcome):
    work = initialized_work(tmp_path)
    retained = work / 'retained.txt'
    before = {path: security(path) for path in (tmp_path, work, retained)}
    async def resumed():
        async with rights.native_owner_access(work, initialized=True):
            assert security(retained) == before[retained]
            # NativeRuntime refreshes the snapshot in its validated session.
            skills = work / '.agents/skills'
            assert skills.resolve().is_relative_to(work.resolve())
            shutil.rmtree(skills)
            (work / '.agents/skills/example').mkdir(parents=True)
            (work / '.agents/skills/example/SKILL.md').write_text('new skill', encoding='utf-8')
            assert retained.read_text(encoding='utf-8') == '中文 existing result'
            if outcome == 'failure': raise RuntimeError('after skill refresh')
            if outcome == 'cancel': raise asyncio.CancelledError('after skill refresh')
    if outcome == 'complete': asyncio.run(resumed())
    else:
        with pytest.raises(RuntimeError if outcome == 'failure' else asyncio.CancelledError):
            asyncio.run(resumed())
    assert {path: security(path) for path in before} == before
    assert retained.read_text(encoding='utf-8') == '中文 existing result'
    # A failed resumed operation must not leave the shared ancestor lease held.
    async def again():
        async with asyncio.timeout(5):
            async with rights.native_owner_access(work, initialized=True): pass
    asyncio.run(again())


@pytest.mark.parametrize('alias', ['work', 'child-directory', 'hardlink'])
def test_initialized_lease_keeps_link_and_identity_rejection(tmp_path, alias):
    work = initialized_work(tmp_path)
    outside = tmp_path / 'outside'; outside.mkdir()
    sentinel = outside / 'keep.txt'; sentinel.write_bytes(b'KEEP')
    before = security(sentinel)
    moved = tmp_path / 'moved'
    link = work / 'alias'
    if alias == 'work':
        work.rename(moved); directory_link(work, outside); link = work
    elif alias == 'child-directory': directory_link(link, outside)
    else: os.link(sentinel, work / 'hard.txt')
    async def rejected():
        with pytest.raises(OSError):
            async with rights.native_owner_access(work, initialized=True): pytest.fail('must not run')
    try:
        asyncio.run(rejected())
        assert sentinel.read_bytes() == b'KEEP' and security(sentinel) == before
    finally:
        if alias != 'hardlink': link.rmdir()


def test_initialized_lease_never_writes_a_worktree_descriptor(tmp_path, monkeypatch):
    work = initialized_work(tmp_path)
    state = rights._Projection(work)
    identities = {state.api.identity(handle) for handle, writable in state.nodes if writable}
    state.close()
    setter = rights._Windows.set_acl
    writes = []
    def observed(self, handle, acl, **options):
        writes.append(self.identity(handle))
        return setter(self, handle, acl, **options)
    monkeypatch.setattr(rights._Windows, 'set_acl', observed)
    async def resumed():
        async with rights.native_owner_access(work, initialized=True): pass
    asyncio.run(resumed())
    assert not identities.intersection(writes)
    # Existing files remain rejected for a new/unverified initialization.
    async def unverified():
        with pytest.raises(OSError):
            async with rights.native_owner_access(work): pytest.fail('must not run')
    asyncio.run(unverified())


def test_initialized_file_probes_do_not_block_an_exclusive_read_share_writer(tmp_path):
    work = initialized_work(tmp_path)
    retained = work / 'retained.txt'
    before = retained.read_bytes(), security(retained)
    api = rights._Windows()
    async def edit_existing():
        async with rights.native_owner_access(work, initialized=True):
            # PowerShell Add-Content uses a writer that does not share reads.
            # Inspection-only READ_DATA handles must not block ordinary editing.
            handle = api.kernel.CreateFileW(str(retained), 0x40000000, 2, None, 3, 0x80, None)
            if handle == w.HANDLE(-1).value: raise c.WinError(c.get_last_error())
            api.kernel.CloseHandle(handle)
    asyncio.run(edit_existing())
    assert (retained.read_bytes(), security(retained)) == before
