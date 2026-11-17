"""Deterministic journaling checks; native races live in lifecycle tests."""
from contextlib import contextmanager
import asyncio
from types import SimpleNamespace
import sys

import pytest

from opendirector.agent import owner_rights as rights


def failure(code):
    error = OSError('controlled native failure')
    error.winerror = code
    return error


def projection(monkeypatch, stage):
    owner = bytes.fromhex('010100000000000515000000')
    ancestor = rights._acl(b'\x02\0', [rights._ace(1, 0, 2, rights.OWNER),
        rights._ace(0, 3, 0x1F01FF, rights.OWNER)])
    work = rights._acl(b'\x02\0', [rights._ace(0, 3, 0x1F01FF, rights.OWNER)])
    external = rights._ace(1, 0, 2, owner)
    acls, writes, closed, races = {1: ancestor, 2: work}, [], [], []
    def write(handle, acl, *, before_write=None, on_write=None):
        if before_write is not None: before_write()
        if stage == 'setter_failure': raise failure(5)
        acls[handle % 100] = acl
        writes.append((handle % 100, acl))
        if on_write is not None: on_write()
    api = SimpleNamespace(owner=owner, c=SimpleNamespace(WinError=failure),
        kernel=SimpleNamespace(CloseHandle=closed.append),
        checked=lambda handle: True, children=lambda handle: (),
        identity=lambda handle: bytes([handle % 100]),
        security=lambda handle: (owner, acls[handle % 100]),
        open=lambda parent, name, **options: name + 100,
        set_acl=write)
    @contextmanager
    def guard(api, handle):
        # Read/transform check, native pre-write check, then post-write check.
        checks = 0
        def unchanged():
            nonlocal checks
            checks += 1
            if (handle % 100 == 1 and not races
                    and checks == (1 if stage == 'before_write' else 3)
                    and stage != 'setter_failure'):
                races.append({'writesBeforeConflict': len(writes)})
                current = acls[1]
                acls[1] = rights._acl(current, [external] + rights._entries(current))
                raise failure(995)
        try: yield unchanged
        finally: closed.append(handle)
    monkeypatch.setitem(sys.modules, 'opendirector.agent.windows_acl_guard',
        SimpleNamespace(descriptor_guard=guard))
    state = object.__new__(rights._Projection)
    state.api, state.nodes, state.changes = api, [(1, False), (2, True)], []
    state.unconfirmed = {}
    state.locations, state.applied = {1: (0, 1), 2: (0, 2)}, False
    state.initialized = False
    return state, acls, ancestor, work, external, races, closed


@pytest.mark.parametrize('stage', ['before_write', 'after_write'])
@pytest.mark.parametrize('completed', [False, True])
def test_journal_distinguishes_unwritten_retry_from_unconfirmed_installation(monkeypatch, stage, completed):
    state, acls, ancestor, work, external, races, closed = projection(monkeypatch, stage)
    if stage == 'after_write':
        with pytest.raises(rights.InstallationUnconfirmedError): state.apply()
    else: state.apply()
    assert races == [{'writesBeforeConflict': 0 if stage == 'before_write' else 1}]
    recorded = [entry for handle, writable, added in state.changes if not writable for entry in added]
    assert recorded.count(external) == (0 if stage == 'before_write' else 1)
    if stage == 'after_write':
        # Post-ack installation conflicts now reject execution, even when this
        # particular writer happened to preserve the original installation.
        # The host cannot distinguish that from an identical replacement.
        before_close = acls[1]
        with pytest.raises(ExceptionGroup) as error: state.close()
        assert all(isinstance(item, rights.InstallationUnconfirmedError) for item in error.value.exceptions)
        assert acls[1] == before_close and rights._entries(acls[1]).count(external) == 2
        assert acls[2] == work and not state.applied
    else:
        state.applied = completed
        state.close()
        assert rights._entries(acls[1]) == [external] + rights._entries(ancestor)
        if completed: assert acls[2] != work
        else: assert acls[2] == work
    assert closed.count(1) == closed.count(2) == 1
    assert not state.changes and not state.nodes


@pytest.mark.parametrize('replay_stale', [False, True])
@pytest.mark.parametrize('completed', [False, True])
def test_cleanup_after_final_check_cannot_silently_accept_a_replayed_grant(monkeypatch, replay_stale, completed):
    state, acls, ancestor, work, external, _, closed = projection(monkeypatch, 'setter_failure')
    unrelated = rights._ace(1, 0, 4, bytes.fromhex('010100000000000516000000'))
    cleanup, raced, broken = False, False, False
    queued, events, removals = [], [], []
    def write(handle, acl, *, before_write=None, on_write=None):
        nonlocal raced, broken
        if before_write is not None: before_write()
        if cleanup and handle % 100 == 1 and not raced:
            events.append('after_final_check')
            snapshot = acls[1] if replay_stale else acl
            queued.append(rights._acl(snapshot, [unrelated] + rights._entries(snapshot)))
            raced = broken = True
        acls[handle % 100] = acl
        if cleanup and handle % 100 == 1: removals.append(acl)
        if on_write is not None: on_write()
        if broken: events.append('native_success')
    @contextmanager
    def guard(api, handle):
        nonlocal broken
        def unchanged():
            if broken: raise failure(995)
        try: yield unchanged
        finally:
            closed.append(handle)
            if broken:
                # A real writer waits for acknowledgment, then writes its
                # saved descriptor. Do not replay it before native removal.
                acls[1] = queued.pop()
                broken = False
                events.append('writer_replayed')
    state.api.set_acl = write
    monkeypatch.setitem(sys.modules, 'opendirector.agent.windows_acl_guard', SimpleNamespace(descriptor_guard=guard))
    state.apply()
    acls[1] = rights._acl(acls[1], [external] + rights._entries(acls[1]))
    before = acls[1]
    state.applied, cleanup = completed, True
    if replay_stale:
        with pytest.raises(ExceptionGroup) as error: state.close()
        assert len(error.value.exceptions) == 1
        assert isinstance(error.value.exceptions[0], rights.CleanupUnconfirmedError)
    else: state.close()
    assert events == ['after_final_check', 'native_success', 'writer_replayed']
    assert len(removals) == 1, 'A committed removal must not be spent twice'
    expected = before if replay_stale else rights._acl(ancestor, [external] + rights._entries(ancestor))
    assert acls[1] == rights._acl(expected, [unrelated] + rights._entries(expected))
    assert (acls[2] != work) is completed
    assert closed.count(1) == closed.count(2) == 1
    assert not state.changes and not state.nodes


def test_failed_setter_does_not_commit_a_proposed_change(monkeypatch):
    state, acls, ancestor, work, _, _, _ = projection(monkeypatch, 'setter_failure')
    try:
        with pytest.raises(OSError) as error: state.apply()
        assert error.value.winerror == 5
        assert state.changes == []
    finally: state.close()
    assert acls == {1: ancestor, 2: work}


@pytest.mark.parametrize('failure_type', [OSError, asyncio.CancelledError, KeyboardInterrupt])
def test_post_ack_setter_error_with_confirmed_guard_still_rolls_back(monkeypatch, failure_type):
    state, acls, ancestor, work, _, _, closed = projection(monkeypatch, 'setter_failure')
    failed = False
    def write(handle, acl, *, before_write=None, on_write=None):
        nonlocal failed
        if before_write is not None: before_write()
        acls[handle % 100] = acl
        if on_write is not None: on_write()
        if handle % 100 == 2 and not failed:
            failed = True
            raise failure_type('injected after actual ACL write')
    state.api.set_acl = write
    with pytest.raises(failure_type, match='injected after actual ACL write'): state.apply()
    state.close()
    assert failed and acls == {1: ancestor, 2: work}
    assert closed.count(1) == closed.count(2) == 1
    assert not state.changes and not state.nodes and not state.unconfirmed


def test_unconfirmed_workspace_does_not_block_confirmed_ancestor_cleanup(monkeypatch):
    state, acls, ancestor, _, _, _, closed = projection(monkeypatch, 'setter_failure')
    receipts, replay = [], []
    def write(handle, acl, *, before_write=None, on_write=None):
        if before_write is not None: before_write()
        acls[handle % 100] = acl
        if on_write is not None: on_write()
        receipts.append(handle % 100)
    @contextmanager
    def guard(api, handle):
        def unchanged():
            if handle % 100 == 2 and 2 in receipts and not replay:
                replay.append(acls[2])
                raise failure(995)
        try: yield unchanged
        finally: closed.append(handle)
    state.api.set_acl = write
    monkeypatch.setitem(sys.modules, 'opendirector.agent.windows_acl_guard', SimpleNamespace(descriptor_guard=guard))
    with pytest.raises(rights.InstallationUnconfirmedError): state.apply()
    with pytest.raises(ExceptionGroup) as error: state.close()
    assert len(error.value.exceptions) == 1 and isinstance(error.value.exceptions[0], rights.InstallationUnconfirmedError)
    assert acls == {1: ancestor, 2: replay[0]}
    assert receipts == [1, 2, 1], 'Only the confirmed ancestor installation may be removed'
    assert closed.count(1) == closed.count(2) == 1
    assert not state.changes and not state.nodes and not state.unconfirmed


@pytest.mark.parametrize('stage', ['after_native_ack', 'after_final_post_check', 'after_ack_exception'])
@pytest.mark.parametrize('writer_policy', ['stale_without_read', 'stale_equal_counts', 'additive'])
def test_installation_break_after_ack_never_spends_uncertain_ownership(monkeypatch, stage, writer_policy):
    state, acls, ancestor, work, external, _, closed = projection(monkeypatch, 'setter_failure')
    receipts, events, snapshots = [], [], []
    broken = False
    def compete():
        nonlocal broken
        entries = rights._entries(acls[1] if writer_policy == 'additive' else ancestor)
        entries.insert(0, external)
        if writer_policy == 'stale_equal_counts':
            entries.append(rights._ace(0, 0, rights.READ, state.api.owner))
        snapshots.append(rights._acl(ancestor, entries))
        broken = True
        events.append(stage)
    def write(handle, acl, *, before_write=None, on_write=None):
        if before_write is not None: before_write()
        acls[handle % 100] = acl
        if on_write is not None: on_write()
        receipts.append(handle % 100)
        if handle % 100 == 1 and not events and stage == 'after_ack_exception':
            compete()
            raise OSError('setter instrumentation failed after native acknowledgment')
    @contextmanager
    def guard(api, handle):
        nonlocal broken
        returned = False
        def unchanged():
            if handle % 100 == 1 and receipts and not events and stage == 'after_native_ack':
                compete()
            if broken: raise failure(995)
        try:
            yield unchanged
            returned = True
        finally:
            if handle % 100 == 1 and receipts and not events and stage == 'after_final_post_check':
                compete()
            closed.append(handle)
            if broken:
                # The single independent writer commits only after the guard
                # is released. Its saved descriptor can replace our receipt's
                # ACEs, including an indistinguishable same-count replacement.
                acls[1] = snapshots[0]
                broken = False
                if returned: raise failure(995)
    state.api.set_acl = write
    monkeypatch.setitem(sys.modules, 'opendirector.agent.windows_acl_guard', SimpleNamespace(descriptor_guard=guard))
    application_error = cleanup_error = None
    try: state.apply()
    except BaseException as error: application_error = error
    recorded = [item for handle, writable, added in state.changes if handle == 1 for item in added]
    try: state.close()
    except BaseException as error: cleanup_error = error
    assert isinstance(application_error, rights.InstallationUnconfirmedError)
    assert isinstance(cleanup_error, ExceptionGroup)
    assert all(isinstance(error, rights.InstallationUnconfirmedError) for error in cleanup_error.exceptions)
    assert recorded.count(external) == 1, 'Preserve the actual native install receipt'
    assert receipts == [1], 'Unconfirmed installation must not retry or attempt removal'
    assert events == [stage]
    assert acls[1] == snapshots[0], 'Never remove an ACE from the independent writer'
    assert rights._entries(acls[1]).count(external) == (2 if writer_policy == 'additive' else 1)
    assert acls[2] == work and not state.applied
    assert closed.count(1) == closed.count(2) == 1
    assert not state.changes and not state.nodes


@pytest.mark.parametrize('stage', ['before_write', 'after_write', 'setter_conflict'])
@pytest.mark.parametrize('completed', [False, True])
def test_cleanup_consumes_only_its_committed_removal(monkeypatch, stage, completed):
    # Exercise the real apply/edit/close loop; only WinAPI/oplock boundaries
    # are controlled here. Native lifecycle coverage lives in its own module.
    state, acls, ancestor, work, external, _, closed = projection(monkeypatch, 'setter_failure')
    cleanup, raced = False, False
    unrelated = rights._ace(1, 0, 4, bytes.fromhex('010100000000000516000000'))
    writes = []
    def compete():
        nonlocal raced
        raced = True
        acls[1] = rights._acl(acls[1], [unrelated] + rights._entries(acls[1]))
        raise failure(995)
    def write(handle, acl, *, before_write=None, on_write=None):
        if before_write is not None: before_write()
        acls[handle % 100] = acl
        if on_write is not None: on_write()
        if cleanup and handle % 100 == 1:
            writes.append(rights._entries(acl).count(external))
            if stage == 'setter_conflict' and not raced: compete()
    @contextmanager
    def guard(api, handle):
        # Keep after_write injection after the native acknowledgment, not the
        # additional validation immediately preceding that native write.
        checks = 0
        def unchanged():
            nonlocal checks
            checks += 1
            if (cleanup and handle % 100 == 1 and not raced
                    and stage != 'setter_conflict'
                    and checks == (1 if stage == 'before_write' else 3)):
                compete()
        try: yield unchanged
        finally: closed.append(handle)
    state.api.set_acl = write
    monkeypatch.setitem(sys.modules, 'opendirector.agent.windows_acl_guard',
        SimpleNamespace(descriptor_guard=guard))
    state.apply()
    acls[1] = rights._acl(acls[1], [external] + rights._entries(acls[1]))
    assert rights._entries(acls[1]).count(external) == 2
    state.applied, cleanup = completed, True
    state.close()
    assert raced
    assert rights._entries(acls[1]) == [unrelated, external] + rights._entries(ancestor)
    assert writes == [1], 'A successful removal must never run a second time'
    assert (acls[2] != work) is completed
    assert closed.count(1) == closed.count(2) == 1
    assert not state.changes and not state.nodes
