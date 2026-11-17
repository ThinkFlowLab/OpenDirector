"""Owner projection keeps the original access policy and confines all ACL edits."""
import asyncio
import os
import struct

import pytest

from opendirector.agent import owner_rights as rights
from process_helpers import directory_link


USER = bytes.fromhex('010100000000000515000000')
WORLD = bytes.fromhex('010100000000000100000000')


def acl(*entries):
    return rights._acl(b'\x02\0', list(entries))


def entries(value):
    return rights._entries(value)


def test_owner_projection_leaves_other_acl_verbatim():
    before = acl(rights._ace(0, 3, 0x1F01FF, USER))
    assert rights.owner_entries(before, USER, writable=True) == (before, [])


def test_owner_projection_keeps_owner_aces_and_excludes_security_authority():
    original = rights._ace(0, 3, 0x1F01FF, rights.OWNER)
    before = acl(original)
    after, added = rights.owner_entries(before, USER, writable=True)
    assert original in entries(after)
    assert all(struct.unpack_from('<I', item, 4)[0] & (0xC0000 | 0x40) == 0 for item in added)
    assert all(item[8:] in {USER, rights.CREATOR} for item in added)
    assert all(not item[1] & 3 for item in added if item[8:] == USER)
    assert all(item[1] == 11 for item in added if item[8:] == rights.CREATOR)


def test_ancestor_projection_never_grants_write_or_inheritance():
    before = acl(rights._ace(0, 3, 0x1F01FF, rights.OWNER))
    _, added = rights.owner_entries(before, USER)
    assert added == [rights._ace(0, 0, rights.READ, USER)]


@pytest.mark.parametrize('flags', [0, 16, 19])
def test_inherited_group_denies_cannot_be_bypassed_by_owner_allow(flags):
    deny = rights._ace(1, flags, 0x2, WORLD)
    owner = rights._ace(0, 3, 0x1F01FF, rights.OWNER)
    after, added = rights.owner_entries(acl(deny, owner), USER, writable=True)
    assert [item for item in entries(after) if item not in added] == [deny, owner]
    assert not any(item[0] == 0 and item[8:] == USER and struct.unpack_from('<I', item, 4)[0] & 2 for item in added)


def test_owner_denial_is_retained_and_materialized_for_the_same_owner():
    deny = rights._ace(1, 3, 2, rights.OWNER)
    before = acl(deny, rights._ace(0, 3, 0x1F01FF, rights.OWNER))
    after, added = rights.owner_entries(before, USER, writable=True)
    assert deny in entries(after)
    assert rights._ace(1, 0, 2, USER) in added
    assert rights._ace(1, 11, 2, rights.CREATOR) in added
    assert all(not struct.unpack_from('<I', item, 4)[0] & 2 for item in added if item[0] == 0)


def test_inherit_only_does_not_become_effective_on_the_parent():
    before = acl(rights._ace(0, 11, 0x1F01FF, rights.OWNER))
    _, added = rights.owner_entries(before, USER, writable=True)
    assert added == [rights._ace(0, 11, rights.MODIFY, rights.CREATOR)]


def test_generic_owner_rights_are_limited_and_repeated_planning_is_idempotent():
    before = acl(rights._ace(0, 3, 0x10000000, rights.OWNER))
    after, added = rights.owner_entries(before, USER, writable=True)
    assert added and all(struct.unpack_from('<I', item, 4)[0] == rights.MODIFY for item in added)
    assert rights.owner_entries(after, USER, writable=True) == (after, [])


@pytest.mark.parametrize('value', [b'', b'\x02\0\x08\0\x01\0\0\0', b'\x02\0\x09\0\0\0\0\0'])
def test_invalid_acl_is_rejected(value):
    with pytest.raises(ValueError): rights.owner_entries(value, USER, writable=True)


def test_unsupported_ace_is_not_reinterpreted():
    before = acl(rights._ace(0, 3, 0x1F01FF, rights.OWNER), rights._ace(9, 0, 2, USER))
    with pytest.raises(ValueError, match='Unsupported'): rights.owner_entries(before, USER, writable=True)


@pytest.mark.skipif(os.name != 'nt', reason='requires Windows security descriptors')
class TestWindowsOwnerRights:
    @pytest.fixture
    def prepared(self, tmp_path):
        work = tmp_path / 'work'; work.mkdir()
        nested = work / 'nested'; nested.mkdir(mode=0o700)
        outside = tmp_path / 'outside'; outside.mkdir()
        (outside / 'keep.txt').write_bytes(b'KEEP')
        return work, nested, outside

    def security(self, path):
        directory = path if path.is_dir() else path.parent
        probe = rights._Projection(directory, tree=False)
        try:
            handle = probe.nodes[-1][0]
            if directory == path: return probe.api.security(handle)
            child = probe.api.open(handle, path.name)
            try: return probe.api.security(child)
            finally: probe.api.kernel.CloseHandle(child)
        finally: probe.close()

    def test_original_root_and_outside_acl_survive(self, tmp_path, prepared):
        work, nested, outside = prepared
        before = {p: self.security(p) for p in (tmp_path, outside, outside / 'keep.txt', work, nested)}
        inode = work.stat().st_ino
        async def check():
            async with rights.native_owner_access(work):
                # Files are created after directory initialization, as in the
                # production runtime; their shared ACL is never rewritten.
                (nested / 'existing.txt').write_text('中文 existing', encoding='utf-8')
                assert work.stat().st_ino == inode
                for path in (work, nested):
                    owner, current = self.security(path)
                    assert owner == before[path][0]
                    assert all(item in entries(current) for item in entries(before[path][1]))
                    assert any(item[8:] == rights.OWNER for item in entries(current))
                assert self.security(outside) == before[outside]
                assert self.security(outside / 'keep.txt') == before[outside / 'keep.txt']
                assert (nested / 'existing.txt').read_text(encoding='utf-8') == '中文 existing'
            assert self.security(tmp_path) == before[tmp_path]
            assert self.security(outside) == before[outside]
        asyncio.run(check())

    def test_partial_preparation_is_rolled_back(self, tmp_path, prepared, monkeypatch):
        work, nested, outside = prepared
        before = {p: self.security(p) for p in (tmp_path, work, nested, outside)}
        setter = rights._Windows.set_acl
        calls = 0
        def fail(self, handle, value, **options):
            nonlocal calls
            setter(self, handle, value, **options)
            calls += 1
            if calls == 2: raise OSError('injected after actual ACL write')
        monkeypatch.setattr(rights._Windows, 'set_acl', fail)
        async def check():
            with pytest.raises(OSError, match='injected'):
                async with rights.native_owner_access(work): pytest.fail('must not execute')
        asyncio.run(check())
        assert {p: self.security(p) for p in before} == before

    @pytest.mark.parametrize('where', ['root', 'ancestor', 'child'])
    def test_reparse_points_are_never_granted(self, tmp_path, prepared, where):
        work, _, outside = prepared
        before = self.security(outside)
        alias = work / 'alias' if where == 'child' else tmp_path / 'alias'
        directory_link(alias, outside)
        target = work if where == 'child' else alias if where == 'root' else alias / 'unused'
        try:
            async def check():
                with pytest.raises(OSError):
                    async with rights.native_owner_access(target): pytest.fail('must not execute')
            asyncio.run(check())
            assert self.security(outside) == before
            assert (outside / 'keep.txt').read_bytes() == b'KEEP'
        finally: alias.rmdir()

    def test_hard_link_does_not_edit_outside_acl(self, prepared):
        work, _, outside = prepared
        before = self.security(outside / 'keep.txt')
        os.link(outside / 'keep.txt', work / 'linked')
        async def check():
            with pytest.raises(OSError):
                async with rights.native_owner_access(work): pytest.fail('must not execute')
        asyncio.run(check())
        assert self.security(outside / 'keep.txt') == before

    def test_foreign_owner_is_rejected_before_any_edit(self, prepared, monkeypatch):
        work, _, _ = prepared
        security = rights._Windows.security
        writes = []
        def foreign(self, handle):
            _, value = security(self, handle)
            return USER, value
        monkeypatch.setattr(rights._Windows, 'security', foreign)
        monkeypatch.setattr(rights._Windows, 'set_acl', lambda *args: writes.append(args))
        async def check():
            with pytest.raises(OSError):
                async with rights.native_owner_access(work): pytest.fail('must not execute')
        asyncio.run(check())
        assert writes == []

    def test_cancelled_waiter_does_not_revoke_active_ancestor_access(self, tmp_path, prepared):
        work, _, _ = prepared
        before = self.security(tmp_path)
        async def wait():
            async with rights.native_owner_access(work): pytest.fail('first lease is still active')
        async def normal_waiter():
            async with rights.native_owner_access(work): return True
        async def check():
            async with rights.native_owner_access(work):
                active = self.security(tmp_path)
                task = asyncio.create_task(wait())
                await asyncio.sleep(.15)
                assert not task.done()
                task.cancel()
                with pytest.raises(asyncio.CancelledError): await task
                assert self.security(tmp_path) == active
                third = asyncio.create_task(normal_waiter())
                await asyncio.sleep(.15)
                assert not third.done()
            assert await asyncio.wait_for(third, 5) is True
            assert self.security(tmp_path) == before
        asyncio.run(check())

    def test_failed_tree_enumeration_does_not_leak_handles(self, tmp_path, prepared):
        import ctypes as c
        from ctypes import wintypes as w
        work, _, outside = prepared
        directory_link(work / 'alias', outside)
        api = rights._Windows()
        api.kernel.GetProcessHandleCount.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
        def count():
            value = w.DWORD()
            assert api.kernel.GetProcessHandleCount(api.kernel.GetCurrentProcess(), c.byref(value))
            return value.value
        try:
            with pytest.raises(OSError): rights._Projection(work)
            before = count()
            samples = []
            for _ in range(50):
                with pytest.raises(OSError): rights._Projection(work)
                samples.append(count())
            assert max(samples) <= before
        finally: (work / 'alias').rmdir()

    def test_replacement_between_lookup_and_edit_never_changes_outside_acl(self, tmp_path, prepared, monkeypatch):
        work, _, outside = prepared
        before = self.security(outside)
        moved = tmp_path / 'moved'
        opener = rights._Windows.open
        changed = False
        attempted = False
        def replace(self, parent, name, **options):
            nonlocal changed, attempted
            if options.get('maximum') and name == 'work' and not changed:
                attempted = True
                work.rename(moved)
                directory_link(work, outside)
                changed = True
            return opener(self, parent, name, **options)
        monkeypatch.setattr(rights._Windows, 'open', replace)
        async def check():
            with pytest.raises((OSError, ExceptionGroup)):
                async with rights.native_owner_access(work): pytest.fail('must not execute')
        try:
            asyncio.run(check())
            assert attempted and self.security(outside) == before
            assert (outside / 'keep.txt').read_bytes() == b'KEEP'
        finally:
            if changed: work.rmdir()

    def test_replacement_before_root_lookup_is_rejected(self, tmp_path, prepared, monkeypatch):
        work, _, outside = prepared
        before = self.security(outside)
        opener = rights._Windows.open
        changed = False
        def replace(self, parent, name, **options):
            nonlocal changed
            if name == 'work' and not changed:
                work.rename(tmp_path / 'moved')
                directory_link(work, outside)
                changed = True
            return opener(self, parent, name, **options)
        monkeypatch.setattr(rights._Windows, 'open', replace)
        async def check():
            with pytest.raises(OSError):
                async with rights.native_owner_access(work): pytest.fail('must not execute')
        try:
            asyncio.run(check())
            assert changed and self.security(outside) == before
        finally:
            if changed: work.rmdir()

    def test_different_file_identity_cannot_receive_owner_grant(self, prepared, monkeypatch):
        work, _, _ = prepared
        state = rights._Projection(work)
        try:
            target = state.nodes[-1][0]
            identity = state.api.identity
            writes = []
            monkeypatch.setattr(state.api, 'identity', lambda handle: b'changed' if handle != target else identity(handle))
            monkeypatch.setattr(state.api, 'set_acl', lambda *args: writes.append(args))
            with pytest.raises(OSError): state.edit(target, lambda owner, acl: acl)
            assert writes == []
        finally: state.close()

    def test_cleanup_keeps_other_acl_updates(self, tmp_path, prepared):
        work, _, _ = prepared
        owner, before = self.security(tmp_path)
        denial = rights._ace(1, 0, 2, WORLD)
        async def check():
            async with rights.native_owner_access(work):
                probe = rights._Projection(tmp_path, tree=False)
                try:
                    handle = probe.nodes[-1][0]
                    _, active = probe.api.security(handle)
                    probe.edit(handle, lambda owner, current: rights._acl(current, [denial] + entries(current)))
                finally: probe.close()
            current_owner, current = self.security(tmp_path)
            assert current_owner == owner
            assert entries(current) == [denial] + entries(before)
        asyncio.run(check())

    @pytest.mark.parametrize('alias', ['directory', 'lock-hardlink'])
    def test_coordination_aliases_cannot_change_outside_bytes_or_acl(self, tmp_path, prepared, monkeypatch, alias):
        work, _, outside = prepared
        base = tmp_path / 'coordination'; base.mkdir()
        directory = base / '.opendirector-owner-rights'
        before = self.security(outside / 'keep.txt')
        if alias == 'directory': directory_link(directory, outside)
        else:
            directory.mkdir(mode=0o700)
            probe = rights._Projection(work)
            try: key = probe.keys()[0]
            finally: probe.close()
            os.link(outside / 'keep.txt', directory / (key + '.lock'))
        monkeypatch.setattr(rights, '_coordination_directory', lambda api: directory)
        async def check():
            with pytest.raises(OSError):
                async with rights.native_owner_access(work): pytest.fail('must not execute')
        try:
            asyncio.run(check())
            assert (outside / 'keep.txt').read_bytes() == b'KEEP'
            assert self.security(outside / 'keep.txt') == before
        finally:
            if alias == 'directory': directory.rmdir()

    @pytest.mark.parametrize('name', ['work.', 'work ', 'work:stream'])
    def test_dos_aliases_are_rejected_before_normalization(self, tmp_path, prepared, name):
        work, _, _ = prepared
        before = self.security(work)
        with pytest.raises(OSError): rights._Projection(tmp_path / name)
        assert self.security(work) == before


def test_generic_execute_projection_never_adds_data_or_ea_reads():
    owner = bytes.fromhex('010100000000000515000000')
    before = rights._acl(b'\x02\0', [rights._ace(0, 11, 0x20000000, rights.OWNER)])
    _, added = rights.owner_entries(before, owner, writable=True)
    assert rights._specific(0x20000000) == 0x1200A0
    assert added == [rights._ace(0, 11, 0x1200A0, rights.CREATOR)]
    assert all(not struct.unpack_from('<I', item, 4)[0] & 9 for item in added)


@pytest.mark.skipif(os.name != 'nt', reason='requires native Windows ACL inheritance')
def test_execute_only_inheritance_does_not_become_readable_after_initialization(tmp_path):
    async def check():
        for projected in (False, True):
            root = tmp_path / str(projected); root.mkdir(mode=0o700)
            state = rights._Projection(root, tree=False)
            try:
                target = state.nodes[-1][0]
                def policy(owner, acl):
                    original = rights._entries(acl)
                    assert any(item[8:] == rights.OWNER for item in original)
                    assert all(item[0] == 0 for item in original)
                    # Full access on this newly owned fixture root only.
                    # New files inherit only the owner's execute permission;
                    # SYSTEM/Administrators do not mask the check via a grant.
                    entries = [rights._ace(0, 0, int.from_bytes(item[4:8], 'little'), item[8:]) for item in original]
                    entries.append(rights._ace(0, 11, 0x20000000, rights.OWNER))
                    return rights._acl(acl, entries)
                state.edit(target, policy)
            finally: state.close()
            file = root / 'execute-only.txt'
            if projected:
                async with rights.native_owner_access(root):
                    assert file.write_bytes(b'KEEP') == 4
                    with pytest.raises(PermissionError): file.read_bytes()
            else:
                assert file.write_bytes(b'KEEP') == 4
                with pytest.raises(PermissionError): file.read_bytes()
    asyncio.run(check())
