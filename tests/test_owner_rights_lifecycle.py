"""Real Windows ACL, handle, cross-process and initialization regressions."""
from contextlib import contextmanager
from contextlib import asynccontextmanager
import asyncio
import ctypes as c
from ctypes import wintypes as w
import gc
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import pytest

from opendirector.agent import owner_rights as rights

pytestmark = pytest.mark.skipif(os.name != 'nt', reason='requires native Windows ACL and oplock APIs')
WORLD = bytes.fromhex('010100000000000100000000')


def security(path):
    state = rights._Projection(path if path.is_dir() else path.parent, tree=False)
    child = None
    try:
        handle = state.nodes[-1][0]
        if path.is_file():
            child = state.api.open(handle, path.name)
            handle = child
        return state.api.security(handle)
    finally:
        if child is not None: state.api.kernel.CloseHandle(child)
        state.close()


def handle_count(api):
    api.kernel.GetProcessHandleCount.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
    count = w.DWORD()
    assert api.kernel.GetProcessHandleCount(api.kernel.GetCurrentProcess(), c.byref(count))
    return count.value


def writer_handle(api, parent, name):
    f = api.files
    length = f._validate_component(name)
    text_buffer = c.create_unicode_buffer(name)
    text = f.UnicodeString(length, length + 2, c.cast(text_buffer, w.LPWSTR))
    attrs = f.ObjectAttributes(c.sizeof(f.ObjectAttributes), parent, c.pointer(text), 0x40, None, None)
    handle, status = w.HANDLE(), f.IoStatus()
    # READ_CONTROL | WRITE_DAC, with no data access and its own FILE_OBJECT.
    code = f.native.NtCreateFile(c.byref(handle), 0x60000, c.byref(attrs), c.byref(status),
        None, 0, 7, 1, f.OPEN_REPARSE_POINT, None, 0)
    if code < 0: raise c.WinError(f.native.RtlNtStatusToDosError(code))
    return handle.value


def test_first_root_check_failure_closes_the_actual_created_handle(tmp_path, monkeypatch):
    api = rights._Windows()
    before = handle_count(api)
    failures = []
    def failed(self, handle):
        failures.append(handle)
        raise OSError('first root attribute query failed')
    monkeypatch.setattr(rights._Windows, 'checked', failed)
    for _ in range(32):
        with pytest.raises(OSError, match='first root'):
            rights._Projection(tmp_path)
    assert len(failures) == 32
    assert handle_count(api) == before


@pytest.mark.parametrize('kind', ['ordinary', 'hardlink_after_walk', 'late_file_after_walk'])
def test_initialization_never_changes_an_existing_files_shared_acl(tmp_path, monkeypatch, kind):
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    source = work / 'input.txt'
    if kind != 'late_file_after_walk': source.write_bytes(b'KEEP')
    state = rights._Projection(work)
    writes = []
    setter = rights._Windows.set_acl
    def record(self, handle, value, **options):
        writes.append(self.identity(handle))
        return setter(self, handle, value, **options)
    monkeypatch.setattr(rights._Windows, 'set_acl', record)
    if kind == 'late_file_after_walk': source.write_bytes(b'KEEP')
    outside = tmp_path / 'outside.txt'
    if kind == 'hardlink_after_walk': os.link(source, outside)
    before = {path: security(path) for path in (tmp_path, work, source)}
    try:
        with pytest.raises(OSError): state.apply()
        assert writes == []
        assert {path: security(path) for path in before} == before
        assert source.read_bytes() == b'KEEP'
        if outside.exists():
            assert outside.samefile(source) and outside.read_bytes() == b'KEEP'
            assert security(outside) == before[source]
    finally: state.close()


@pytest.mark.parametrize('stage', ['after_read', 'inside_setter'])
@pytest.mark.parametrize('preopened', [False, True])
def test_concurrent_real_deny_is_preserved_across_descriptor_update(tmp_path, monkeypatch, stage, preopened):
    from opendirector.agent import windows_acl_guard as guard
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    state = rights._Projection(work, tree=False)
    handle = state.nodes[-1][0]
    parent, name = state.locations[handle]
    original_acl = state.api.security(handle)[1]
    denial = rights._ace(1, 0, 2, WORLD)
    other = writer_handle(state.api, parent, name) if preopened else None
    checks, worker_errors, worker_done = [], [], threading.Event()
    actual_guard, actual_set = guard.descriptor_guard, rights._Windows.set_acl
    @contextmanager
    def observed(api, target):
        with actual_guard(api, target) as unchanged:
            checks.append(unchanged)
            yield unchanged
    monkeypatch.setattr(guard, 'descriptor_guard', observed)
    def competing_editor():
        target = other
        try:
            if target is None: target = writer_handle(state.api, parent, name)
            actual_set(state.api, target, rights._acl(original_acl, [denial] + rights._entries(original_acl)))
        except BaseException as error: worker_errors.append(error)
        finally:
            if target is not None: state.api.kernel.CloseHandle(target)
            worker_done.set()
    worker = threading.Thread(target=competing_editor)
    raced = []
    def start_conflict():
        if raced: return
        raced.append(True); worker.start()
        deadline = time.monotonic() + 3
        while True:
            try: checks[-1]()
            except OSError as error:
                assert error.winerror == 995
                break
            assert time.monotonic() < deadline, 'Actual ACL writer did not break the oplock'
            time.sleep(.005)
        assert not worker_done.is_set()  # SET_SECURITY must wait for acknowledgment.
        assert state.api.security(handle)[1] == original_acl
    def transform(owner, acl):
        if stage == 'after_read': start_conflict()
        return rights.owner_entries(acl, owner, writable=True)[0]
    def writing(self, target, acl, **options):
        if stage == 'inside_setter': start_conflict()
        return actual_set(self, target, acl, **options)
    monkeypatch.setattr(rights._Windows, 'set_acl', writing)
    try:
        state.edit(handle, transform)
        worker.join(timeout=3)
        assert not worker.is_alive() and worker_done.is_set() and worker_errors == []
        current = state.api.security(handle)[1]
        assert denial in rights._entries(current)
        assert all(not int.from_bytes(item[4:8], 'little') & 2 for item in rights._entries(current)
                   if item[0] == 0 and item[8:] == state.api.owner)
    finally:
        state.close()
        if worker.ident is not None: worker.join(timeout=3)
        elif other is not None: state.api.kernel.CloseHandle(other)


def test_oplock_request_failure_closes_each_edit_handle(tmp_path, monkeypatch):
    # Other integration tests can leave finishing provider/event-loop threads
    # whose handles disappear during this exact process-wide count. Retain the
    # strict equality and all eight native failures in a fresh child process.
    marker = 'OPENDIRECTOR_ACL_HANDLE_COUNT_WORKER'
    if os.environ.get(marker) != 'oplock-request-failure':
        result = subprocess.run([sys.executable, '-m', 'pytest',
            str(Path(__file__)) + '::test_oplock_request_failure_closes_each_edit_handle',
            '--basetemp=' + str(tmp_path / 'isolated'), '-q', '--tb=short'],
            env={**os.environ, marker: 'oplock-request-failure'},
            capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stdout + result.stderr
        return
    from opendirector.agent import windows_acl_guard as guard
    state = rights._Projection(tmp_path, tree=False)
    gc.collect()
    before = handle_count(state.api)
    def rejected(*args):
        c.set_last_error(300)
        return 0
    # Preserve the actual kernel handle creation/close and actual event close.
    monkeypatch.setattr(state.api.kernel, 'DeviceIoControl', rejected)
    try:
        for _ in range(8):
            with pytest.raises(OSError) as error:
                state.edit(state.nodes[-1][0], lambda owner, acl: acl)
            assert error.value.winerror == 300
        gc.collect()
        assert handle_count(state.api) == before
    finally: state.close()


@pytest.mark.parametrize('failure', [RuntimeError, asyncio.CancelledError])
def test_failed_or_cancelled_body_rolls_back_all_initialization_aces(tmp_path, failure):
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    before = {path: security(path) for path in (tmp_path, work)}
    async def check():
        with pytest.raises(failure):
            async with rights.native_owner_access(work):
                raise failure('initialization did not finish')
    asyncio.run(check())
    assert {path: security(path) for path in before} == before


def test_native_setup_failure_initializes_before_files_and_closes_permissions(tmp_path, monkeypatch):
    from uuid import uuid4
    from opendirector.agent import native
    from opendirector.agent.context import RunContext
    original = rights.native_owner_access
    observations = []
    @asynccontextmanager
    async def observing(work):
        assert list(work.iterdir()) == []
        observations.append(('enter', work))
        async with original(work):
            try: yield
            finally: observations.append(('exit', work))
    def fail(work, catalog):
        assert observations == [('enter', work)]
        raise RuntimeError('skill copy failed before spawn')
    class Gateway:
        async def close(self): observations.append(('gateway-close', None))
    monkeypatch.setattr(native, 'native_owner_access', observing)
    monkeypatch.setattr(native, 'prepare_skills', fail)
    run = RunContext(runtime='deepseek', project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
        directory=tmp_path, config=None, messages=[], selected_skills=[])
    before = security(tmp_path)
    async def check():
        with pytest.raises(RuntimeError, match='skill copy failed'):
            async for _ in native.NativeRuntime().stream(run, Gateway()): pytest.fail('must not spawn')
    asyncio.run(check())
    assert [item[0] for item in observations] == ['enter', 'gateway-close', 'exit']
    assert security(tmp_path) == before
    work = observations[0][1]
    # The failed fresh root retains its original OWNER RIGHTS policy only.
    _, acl = security(work)
    assert not any(item[8:] == rights.CREATOR for item in rights._entries(acl))


def test_cleanup_retry_preserves_a_deny_added_during_its_actual_setter(tmp_path, monkeypatch):
    from opendirector.agent import windows_acl_guard as guard
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    before = security(tmp_path)
    actual_guard, actual_set = guard.descriptor_guard, rights._Windows.set_acl
    checks, failures, broken_commits = [], [], []
    denial = rights._ace(1, 0, 2, WORLD)
    @contextmanager
    def observed(api, target):
        with actual_guard(api, target) as unchanged:
            checks.append(unchanged)
            yield unchanged
    async def check():
        async with rights.native_owner_access(work):
            state = rights._Projection(tmp_path, tree=False)
            try:
                target = state.nodes[-1][0]
                identity = state.api.identity(target)
                active_acl = state.api.security(target)[1]
                parent, name = state.locations[target]
                other = writer_handle(state.api, parent, name)
                done = threading.Event()
                def external():
                    try:
                        actual_set(state.api, other, rights._acl(active_acl, [denial] + rights._entries(active_acl)))
                    except BaseException as error: failures.append(error)
                    finally: state.api.kernel.CloseHandle(other); done.set()
                worker = threading.Thread(target=external)
                raced = []
                def setter(self, handle, value, **options):
                    if self.identity(handle) == identity and not raced:
                        raced.append(True); worker.start()
                        deadline = time.monotonic() + 3
                        while True:
                            try: checks[-1]()
                            except OSError as error:
                                assert error.winerror == 995
                                break
                            assert time.monotonic() < deadline
                            time.sleep(.005)
                        assert not done.is_set()
                        committed = options.get('on_write')
                        def record_broken_commit():
                            broken_commits.append(True)
                            if committed is not None: committed()
                        options['on_write'] = record_broken_commit
                    return actual_set(self, handle, value, **options)
                monkeypatch.setattr(guard, 'descriptor_guard', observed)
                monkeypatch.setattr(rights._Windows, 'set_acl', setter)
            finally: state.close()
        worker.join(timeout=3)
        assert raced and done.is_set() and not worker.is_alive() and failures == []
        assert broken_commits == [], 'A broken guard must be rechecked at the native write boundary'
        owner, current = security(tmp_path)
        assert owner == before[0]
        assert rights._entries(current) == [denial] + rights._entries(before[1])
        # No leaked lease prevents another normal initialization.
        async with asyncio.timeout(3):
            async with rights.native_owner_access(work): pass
    asyncio.run(check())


@pytest.mark.parametrize('different_temp', [False, True])
def test_real_processes_share_one_coordinator_across_environment_overrides(tmp_path, different_temp):
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    one_temp = tmp_path / 'temp-one'; one_temp.mkdir(mode=0o700)
    two_temp = tmp_path / 'temp-two' if different_temp else one_temp
    two_temp.mkdir(mode=0o700, exist_ok=True)
    states = [tmp_path / 'first.json', tmp_path / 'second.json']
    processes = []
    script = Path(__file__).parent / 'fixtures/owner_rights_worker.py'
    def wait(path):
        deadline = time.monotonic() + 8
        while not path.exists():
            assert time.monotonic() < deadline, (path, [p.poll() for p in processes])
            time.sleep(.025)
    try:
        for index, temporary in enumerate((one_temp, two_temp)):
            env = {**os.environ, 'TEMP': str(temporary), 'TMP': str(temporary),
                   'USERPROFILE': str(temporary), 'HOME': str(temporary), 'LOCALAPPDATA': str(temporary)}
            processes.append(subprocess.Popen([sys.executable, str(script), str(work), str(states[index])],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
            if index == 0: wait(states[0])
        time.sleep(.25)
        assert not states[1].exists(), 'Second process bypassed the original work lease'
        active = security(tmp_path)
        states[0].with_suffix('.release').write_text('release')
        wait(states[0].with_suffix('.closed')); wait(states[1])
        assert security(tmp_path) == active
        states[1].with_suffix('.release').write_text('release')
        outputs = [process.communicate(timeout=5) for process in processes]
        assert all(process.returncode == 0 for process in processes), outputs
        assert all(value == (b'', b'') for value in outputs), outputs
        a, b = [json.loads(path.read_text()) for path in states]
        assert a['coordinator'] == b['coordinator'] == str(rights._coordination_directory(rights._Windows()))
        assert (a['temp'] != b['temp']) is different_temp
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill(); process.communicate(timeout=5)


@pytest.mark.parametrize('stage', ['before_write', 'after_write'])
@pytest.mark.parametrize('outcome', ['complete', 'body_failure', 'cancel', 'setup_failure'])
def test_real_lease_journal_preserves_an_external_identical_owner_deny(tmp_path, monkeypatch, stage, outcome):
    """Pre-ack retry is safe; an unconfirmed installation retains the writer ACL."""
    from opendirector.agent import windows_acl_guard as guard
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    probe = rights._Projection(tmp_path, tree=False)
    api, root = probe.api, probe.nodes[-1][0]
    owner, original = api.security(root)
    original_work = security(work)
    root_identity = api.identity(root)
    parent, name = probe.locations[root]
    owner_deny = rights._ace(1, 0, 2, rights.OWNER)
    external_deny = rights._ace(1, 0, 2, owner)
    policy = rights._acl(original, [owner_deny] + rights._entries(original))
    probe.edit(root, lambda current_owner, acl: policy)
    other = writer_handle(api, parent, name)
    actual_guard, actual_set, actual_init = guard.descriptor_guard, rights._Windows.set_acl, rights._Projection.__init__
    states, races, errors, checkpoints, setup_failures, writer_policies, entered = [], [], [], [], [], [], []
    done = threading.Event()
    def track(self, path, **options):
        actual_init(self, path, **options)
        if Path(path) == work and options.get('tree', True): states.append(self)
    def external_writer():
        try:
            current_owner, current = api.security(other)
            assert current_owner == owner
            # This writer preserves the installed ACE, but the host cannot
            # distinguish it from a stale replacement after the guard breaks.
            writer_policies.append(rights._acl(current, [external_deny] + rights._entries(current)))
            actual_set(api, other, writer_policies[0])
        except BaseException as error: errors.append(error)
        finally: api.kernel.CloseHandle(other); done.set()
    worker = threading.Thread(target=external_writer)
    @contextmanager
    def observe(self, target):
        with actual_guard(self, target) as unchanged:
            checks = 0
            def check():
                nonlocal checks
                checks += 1
                if (self.identity(target) == root_identity and not races
                        and checks == (1 if stage == 'before_write' else 3)):
                    recorded = [entry for handle, writable, added in states[0].changes
                                if self.identity(handle) == root_identity for entry in added]
                    checkpoints.append(recorded.count(external_deny))
                    races.append(True); worker.start()
                    deadline = time.monotonic() + 3
                    while True:
                        try: unchanged()
                        except OSError as error:
                            assert error.winerror == 995
                            break
                        assert time.monotonic() < deadline, 'Writer did not break the actual RH oplock'
                        time.sleep(.005)
                    assert not done.is_set(), 'Competing SET_SECURITY did not wait for acknowledgment'
                unchanged()
            yield check
    def set_acl(self, target, acl, **options):
        if (outcome == 'setup_failure' and states
                and self.identity(target) == self.identity(states[0].nodes[-1][0])
                and not setup_failures):
            setup_failures.append(True)
            raise OSError('initialization setter denied')
        return actual_set(self, target, acl, **options)
    async def exercise():
        async with rights.native_owner_access(work):
            entered.append(True)
            if outcome == 'body_failure': raise RuntimeError('body failed')
            if outcome == 'cancel': raise asyncio.CancelledError('cancelled body')
            assert outcome == 'complete'
    try:
        with monkeypatch.context() as patch:
            patch.setattr(rights._Projection, '__init__', track)
            patch.setattr(guard, 'descriptor_guard', observe)
            patch.setattr(rights._Windows, 'set_acl', set_acl)
            expected_error = {'body_failure': RuntimeError, 'cancel': asyncio.CancelledError,
                              'setup_failure': OSError}.get(outcome)
            if stage == 'after_write': expected_error = ExceptionGroup
            if expected_error:
                with pytest.raises(expected_error) as error: asyncio.run(exercise())
                if stage == 'after_write':
                    assert all(isinstance(item, rights.InstallationUnconfirmedError) for item in error.value.exceptions)
            else: asyncio.run(exercise())
        worker.join(timeout=3)
        assert races and done.is_set() and not worker.is_alive() and errors == []
        current_owner, current = api.security(root)
        assert current_owner == owner
        if stage == 'after_write':
            assert current == writer_policies[0] and rights._entries(current).count(external_deny) == 2
            assert not entered, 'Unconfirmed installation must never enter the execution body'
        else: assert rights._entries(current) == [external_deny] + rights._entries(policy)
        assert checkpoints == [0 if stage == 'before_write' else 1]
        assert states[0].changes == [] and states[0].nodes == []
        if outcome != 'complete': assert security(work) == original_work
        assert bool(setup_failures) is (outcome == 'setup_failure' and stage == 'before_write')
        if stage == 'after_write':
            # Only the fixture owns the writer's complete intended policy.
            # Product cleanup deliberately leaves ambiguous ACEs untouched.
            probe.edit(root, lambda current_owner, acl: rights._acl(policy, [external_deny] + rights._entries(policy)))
        async def acquire_again():
            async with asyncio.timeout(5):
                async with rights.native_owner_access(work): pass
        asyncio.run(acquire_again())
        assert rights._entries(api.security(root)[1]) == [external_deny] + rights._entries(policy)
    finally:
        if worker.ident is not None: worker.join(timeout=3)
        else: api.kernel.CloseHandle(other)
        probe.edit(root, lambda current_owner, acl: original)
        probe.close()


@pytest.mark.parametrize('stage', ['before_write', 'after_write'])
def test_real_cleanup_retry_keeps_an_external_identical_deny(tmp_path, monkeypatch, stage):
    """An actual writer breaks the cleanup oplock, after apply has completed."""
    from opendirector.agent import windows_acl_guard as guard
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    probe = rights._Projection(tmp_path, tree=False)
    api, root = probe.api, probe.nodes[-1][0]
    owner, original = api.security(root)
    identity = api.identity(root)
    policy = rights._acl(original, [rights._ace(1, 0, 2, rights.OWNER)] + rights._entries(original))
    external = rights._ace(1, 0, 2, owner)
    unrelated = rights._ace(1, 0, 4, WORLD)
    probe.edit(root, lambda current_owner, acl: policy)
    other = writer_handle(api, *probe.locations[root])
    actual_guard, actual_set = guard.descriptor_guard, rights._Windows.set_acl
    cleanup, raced = False, False
    errors, done = [], threading.Event()
    def competing_writer():
        try:
            _, current = api.security(other)
            actual_set(api, other, rights._acl(current, [unrelated] + rights._entries(current)))
        except BaseException as error: errors.append(error)
        finally: api.kernel.CloseHandle(other); done.set()
    worker = threading.Thread(target=competing_writer)
    @contextmanager
    def observe(self, target):
        with actual_guard(self, target) as unchanged:
            checks = 0
            def check():
                nonlocal checks, raced
                checks += 1
                if (cleanup and self.identity(target) == identity and not raced
                        and checks == (1 if stage == 'before_write' else 3)):
                    # Check 2 is now the setter's final pre-write validation;
                    # check 3 must observe the actual committed removal.
                    assert rights._entries(self.security(target)[1]).count(external) == (2 if stage == 'before_write' else 1)
                    raced = True; worker.start()
                    deadline = time.monotonic() + 3
                    while True:
                        try: unchanged()
                        except OSError as error:
                            assert error.winerror == 995
                            break
                        assert time.monotonic() < deadline, 'Cleanup writer did not break the RH oplock'
                        time.sleep(.005)
                    assert not done.is_set(), 'Writer must await oplock acknowledgment'
                unchanged()
            yield check
    async def exercise():
        nonlocal cleanup
        async with rights.native_owner_access(work):
            _, current = api.security(root)
            assert rights._entries(current).count(external) == 1
            actual_set(api, other, rights._acl(current, [external] + rights._entries(current)))
            assert rights._entries(api.security(root)[1]).count(external) == 2
            cleanup = True
    try:
        with monkeypatch.context() as patch:
            patch.setattr(guard, 'descriptor_guard', observe)
            asyncio.run(exercise())
        worker.join(timeout=3)
        assert raced and done.is_set() and not worker.is_alive() and not errors
        assert api.security(root) == (owner, rights._acl(policy, [unrelated, external] + rights._entries(policy)))
        async def acquire_again():
            async with asyncio.timeout(5):
                async with rights.native_owner_access(work): pass
        asyncio.run(acquire_again())
        assert rights._entries(api.security(root)[1]).count(external) == 1
    finally:
        if worker.ident is not None: worker.join(timeout=3)
        else: api.kernel.CloseHandle(other)
        probe.edit(root, lambda current_owner, acl: original)
        probe.close()


@pytest.mark.parametrize('replay_stale', [False, True])
@pytest.mark.parametrize('outcome', ['complete', 'body_failure', 'cancel'])
@pytest.mark.parametrize('stage', ['after_final_check', 'after_final_post_check'])
def test_cleanup_after_final_check_reports_unconfirmed_native_removal(tmp_path, monkeypatch, replay_stale, outcome, stage):
    """Break the real RH guard only AFTER its last successful check returns.

    The interceptor calls the saved, original NtSetSecurityObject. The writer
    has an independent FILE_OBJECT and must be waiting for oplock acknowledgment
    before that call, rather than merely racing an earlier Python check.
    """
    from opendirector.agent import windows_acl_guard as guard
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    probe = rights._Projection(tmp_path, tree=False)
    api, root = probe.api, probe.nodes[-1][0]
    owner, original = api.security(root)
    identity = api.identity(root)
    policy = rights._acl(original, [rights._ace(1, 0, 2, rights.OWNER)] + rights._entries(original))
    external = rights._ace(1, 0, 2, owner)
    unrelated = rights._ace(1, 0, 4, WORLD)
    probe.edit(root, lambda current_owner, acl: policy)
    runner = asyncio.Runner()
    runner.get_loop()  # Keep the Proactor's own handles on both sides of the count.
    gc.collect()
    baseline_handles = handle_count(api)
    other = writer_handle(api, *probe.locations[root])
    actual_guard, actual_set, actual_init = guard.descriptor_guard, rights._Windows.set_acl, rights._Projection.__init__
    original_native = api.files.native.NtSetSecurityObject
    original_cancel, original_result = api.kernel.CancelIoEx, api.kernel.GetOverlappedResult
    cleanup, raced = False, False
    states, active, errors, statuses, receipts, completions, before_cleanup = [], {}, [], [], [], [], []
    snapshot, done = [], threading.Event()
    main_thread = threading.get_ident()
    def track(self, path, **options):
        actual_init(self, path, **options)
        if Path(path) == work and options.get('tree', True): states.append(self)
    def competing_writer():
        try:
            actual_set(api, other, snapshot[0])
        except BaseException as error: errors.append(repr(error))
        finally: api.kernel.CloseHandle(other); done.set()
    worker = threading.Thread(target=competing_writer)
    @contextmanager
    def observe(self, target):
        try:
            with actual_guard(self, target) as unchanged:
                checks = []
                def check():
                    unchanged()
                    checks.append('returned')
                active[target] = (unchanged, checks)
                yield check
        finally: active.pop(target, None)
    def start_writer(target):
        nonlocal raced
        unchanged, checks = active[target]
        assert checks == ['returned'] * (2 if stage == 'after_final_check' else 3)
        _, current = api.security(target)
        assert rights._entries(current).count(external) == (2 if stage == 'after_final_check' else 1)
        saved = before_cleanup[0] if replay_stale else current
        entries = rights._entries(saved)
        if not replay_stale and stage == 'after_final_check':
            # Simulate an independent writer preserving the intended
            # removal, while still introducing its unrelated deny.
            _, additions = rights.owner_entries(policy, owner)
            for item in additions: entries.remove(item)
        snapshot.append(rights._acl(current, [unrelated] + entries))
        raced = True; worker.start()
        deadline = time.monotonic() + 3
        while True:
            try: unchanged()
            except OSError as error:
                assert error.winerror == 995
                break
            assert time.monotonic() < deadline, 'Writer did not break the actual RH oplock'
            time.sleep(.005)
        assert not done.is_set(), 'Writer must still await oplock acknowledgment'
    def selected(target):
        return threading.get_ident() == main_thread and cleanup and api.identity(target) == identity
    def native(target, information, descriptor):
        chosen = selected(target)
        if chosen and not raced and stage == 'after_final_check': start_writer(target)
        result = original_native(target, information, descriptor)
        if chosen: statuses.append(result)
        return result
    def cancel(target, operation):
        if selected(target) and not raced and stage == 'after_final_post_check': start_writer(target)
        return original_cancel(target, operation)
    def completed(target, operation, size, wait):
        result = original_result(target, operation, size, wait)
        if selected(target): completions.append(dict(result=bool(result), error=c.get_last_error()))
        return result
    def setter(self, target, acl, **options):
        callback = options.get('on_write')
        if cleanup and self.identity(target) == identity and callback is not None:
            before_cleanup.append(self.security(target)[1])
            def committed():
                receipts.append('native-success')
                callback()
            options['on_write'] = committed
        return actual_set(self, target, acl, **options)
    async def exercise():
        nonlocal cleanup
        async with rights.native_owner_access(work):
            _, current = api.security(root)
            actual_set(api, other, rights._acl(current, [external] + rights._entries(current)))
            cleanup = True
            if outcome == 'body_failure': raise RuntimeError('body failed')
            if outcome == 'cancel': raise asyncio.CancelledError('cancelled body')
    caught = None
    # Count the exact FILE_OBJECT/oplock/lease handles owned by this operation.
    # The process-wide count also includes asyncio/pytest runtime handles.
    owned, opened, closed = {other}, [], []
    bookkeeping = threading.RLock()
    actual_close = api.kernel.CloseHandle
    actual_create = api.files.native.NtCreateFile
    actual_file, actual_event = api.kernel.CreateFileW, api.kernel.CreateEventW
    def register(value):
        value = value.value if hasattr(value, 'value') else value
        with bookkeeping:
            if value not in (None, w.HANDLE(-1).value):
                assert value not in owned
                owned.add(value); opened.append(value)
        return value
    def close(value):
        with bookkeeping:
            result = actual_close(value)
            value = value.value if hasattr(value, 'value') else value
            if value in owned:
                assert result, 'A native operation handle was not closed'
                owned.remove(value); closed.append(value)
        return result
    def create(*arguments):
        result = actual_create(*arguments)
        if result >= 0: register(c.cast(arguments[0], c.POINTER(w.HANDLE))[0])
        return result
    try:
        with monkeypatch.context() as patch:
            patch.setattr(api.kernel, 'CloseHandle', close)
            patch.setattr(api.kernel, 'CreateFileW', lambda *args: register(actual_file(*args)))
            patch.setattr(api.kernel, 'CreateEventW', lambda *args: register(actual_event(*args)))
            patch.setattr(api.files.native, 'NtCreateFile', create)
            patch.setattr(rights._Projection, '__init__', track)
            patch.setattr(guard, 'descriptor_guard', observe)
            patch.setattr(rights._Windows, 'set_acl', setter)
            patch.setattr(api.files.native, 'NtSetSecurityObject', native)
            patch.setattr(api.kernel, 'CancelIoEx', cancel)
            patch.setattr(api.kernel, 'GetOverlappedResult', completed)
            try: runner.run(exercise())
            except BaseException as error: caught = error
        assert worker.ident is not None, repr(caught)
        worker.join(timeout=3)
        current_owner, current = api.security(root)
        gc.collect()
        evidence = dict(stage=stage, replayStale=replay_stale, outcome=outcome,
            nativeStatus=statuses, receipts=receipts, completions=completions, owner=current_owner.hex(),
            originalOwner=owner.hex(), acl=current.hex(), aclEntries=[item.hex() for item in rights._entries(current)],
            writerErrors=errors, writerDone=done.is_set(), writerAlive=worker.is_alive(),
            error=repr(caught), nodesClosed=not states[0].nodes, journalClosed=not states[0].changes,
            baselineHandles=baseline_handles, finalHandles=handle_count(api),
            operationOpened=len(opened) + 1, operationClosed=len(closed), remainingHandles=list(owned))
        if destination := os.environ.get('OPENDIRECTOR_ACL_EVIDENCE'):
            with Path(destination).open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(evidence) + '\n')
        assert raced and done.is_set() and not worker.is_alive() and errors == []
        assert statuses == [0] and receipts == ['native-success']
        assert completions[0]['result'], 'The native guard must report the independent writer break'
        assert current_owner == owner and current == snapshot[0]
        assert rights._entries(current).count(external) == (2 if replay_stale else 1)
        assert unrelated in rights._entries(current)
        assert not states[0].nodes and not states[0].changes
        assert not owned and len(opened) + 1 == len(closed)
        if replay_stale:
            assert isinstance(caught, BaseExceptionGroup), 'Unconfirmed cleanup must not return success'
            assert 'cannot be confirmed' in str(caught.exceptions[0])
            if outcome != 'complete':
                assert isinstance(caught.__context__, RuntimeError if outcome == 'body_failure' else asyncio.CancelledError)
        elif outcome == 'complete': assert caught is None
        else: assert isinstance(caught, RuntimeError if outcome == 'body_failure' else asyncio.CancelledError)
        # Remove ONLY the test writer's replay under the fixture's own policy,
        # then prove the failed close released its cross-process lease too.
        probe.edit(root, lambda current_owner, acl: rights._acl(policy, [unrelated, external] + rights._entries(policy)))
        async def acquire_again():
            async with asyncio.timeout(5):
                async with rights.native_owner_access(work): pass
        runner.run(acquire_again())
        assert rights._entries(api.security(root)[1]).count(external) == 1
        if destination:
            with Path(destination).open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(dict(stage=stage, outcome=outcome, replayStale=replay_stale,
                    leaseReacquired=True)) + '\n')
    finally:
        if worker.ident is not None: worker.join(timeout=3)
        else: api.kernel.CloseHandle(other)
        probe.edit(root, lambda current_owner, acl: original)
        probe.close()
        runner.close()


def test_guard_release_break_preserves_the_original_body_error(tmp_path, monkeypatch):
    from opendirector.agent import windows_acl_guard as guard
    state = rights._Projection(tmp_path, tree=False)
    api, root = state.api, state.nodes[-1][0]
    owner, original = api.security(root)
    denial = rights._ace(1, 0, 4, WORLD)
    other = writer_handle(api, *state.locations[root])
    original_cancel = api.kernel.CancelIoEx
    pending, done, errors, raced = [], threading.Event(), [], []
    def writer():
        try: api.set_acl(other, rights._acl(original, [denial] + rights._entries(original)))
        except BaseException as error: errors.append(error)
        finally: api.kernel.CloseHandle(other); done.set()
    worker = threading.Thread(target=writer)
    def cancel(target, operation):
        if not raced:
            raced.append(True); worker.start()
            deadline = time.monotonic() + 3
            while True:
                try: pending[0]()
                except OSError as error:
                    assert error.winerror == 995
                    break
                assert time.monotonic() < deadline
                time.sleep(.005)
            assert not done.is_set()
        return original_cancel(target, operation)
    try:
        target = api.open(*state.locations[root], maximum=True)
        with monkeypatch.context() as patch:
            patch.setattr(api.kernel, 'CancelIoEx', cancel)
            with pytest.raises(RuntimeError, match='original body error'):
                with guard.descriptor_guard(api, target) as unchanged:
                    pending.append(unchanged)
                    raise RuntimeError('original body error')
        worker.join(timeout=3)
        assert done.is_set() and not worker.is_alive() and errors == []
        assert api.security(root) == (owner, rights._acl(original, [denial] + rights._entries(original)))
    finally:
        if worker.ident is None: api.kernel.CloseHandle(other)
        else: worker.join(timeout=3)
        state.edit(root, lambda current_owner, acl: original)
        state.close()


@pytest.mark.parametrize(('stage', 'writer_policy'), [
    ('after_final_check', 'stale_without_read'),
    ('after_final_check', 'stale_equal_counts'),
    *[(stage, policy) for stage in ('after_native_ack', 'after_final_post_check', 'after_ack_exception')
      for policy in ('stale_without_read', 'stale_equal_counts', 'additive')],
])
def test_installation_guard_failure_preserves_the_independent_writer_policy(tmp_path, monkeypatch, stage, writer_policy):
    """An acknowledged install cannot establish ACE ownership after a break."""
    from opendirector.agent import windows_acl_guard as guard
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    probe = rights._Projection(tmp_path, tree=False)
    api, root = probe.api, probe.nodes[-1][0]
    owner, original = api.security(root)
    identity = api.identity(root)
    entries = rights._entries(original)
    # Declare the READ projection this fixture exercises rather than depending
    # on a particular Python temporary-directory OWNER RIGHTS policy. Keep all
    # original ACEs and insert the explicit allow before inherited entries.
    inherited = next((index for index, item in enumerate(entries) if item[1] & 16), len(entries))
    entries.insert(inherited, rights._ace(0, 0, rights.READ, rights.OWNER))
    policy = rights._acl(original, [rights._ace(1, 0, 2, rights.OWNER)] + entries)
    external = rights._ace(1, 0, 2, owner)
    read = rights._ace(0, 0, rights.READ, owner)
    probe.edit(root, lambda current_owner, acl: policy)
    # The external writer's saved original descriptor predates installation.
    stale = rights._acl(policy, [external] + rights._entries(policy)
                        + ([read] if writer_policy == 'stale_equal_counts' else []))
    other = writer_handle(api, *probe.locations[root])
    runner = asyncio.Runner()
    runner.get_loop()
    actual_guard, actual_set, actual_init = guard.descriptor_guard, rights._Windows.set_acl, rights._Projection.__init__
    original_native, original_cancel = api.files.native.NtSetSecurityObject, api.kernel.CancelIoEx
    states, active, snapshots, errors, receipts, statuses, entered = [], {}, [], [], [], [], []
    done = threading.Event()
    main_thread = threading.get_ident()
    raced = False
    def track(self, path, **options):
        actual_init(self, path, **options)
        if Path(path) == work and options.get('tree', True): states.append(self)
    def selected(target):
        return threading.get_ident() == main_thread and states and api.identity(target) == identity
    def writer():
        try: actual_set(api, other, snapshots[0])
        except BaseException as error: errors.append(repr(error))
        finally: api.kernel.CloseHandle(other); done.set()
    worker = threading.Thread(target=writer)
    @contextmanager
    def observe(self, target):
        try:
            with actual_guard(self, target) as unchanged:
                checks = []
                def check():
                    unchanged()
                    checks.append('returned')
                active[target] = (unchanged, checks)
                yield check
        finally: active.pop(target, None)
    def start_writer(target):
        nonlocal raced
        unchanged, checks = active[target]
        assert checks == ['returned'] * (3 if stage == 'after_final_post_check' else 2)
        current_owner, current = api.security(target)
        assert current_owner == owner
        assert rights._entries(current).count(external) == (0 if stage == 'after_final_check' else 1)
        snapshots.append(rights._acl(current, [external] + rights._entries(current))
                         if writer_policy == 'additive' else stale)
        raced = True; worker.start()
        deadline = time.monotonic() + 3
        while True:
            try: unchanged()
            except OSError as error:
                assert error.winerror == 995
                break
            assert time.monotonic() < deadline, 'Writer did not break the actual RH oplock'
            time.sleep(.005)
        assert not done.is_set(), 'Independent writer must wait for acknowledgment'
    def native(target, information, descriptor):
        chosen = selected(target)
        if chosen and not raced and stage == 'after_final_check': start_writer(target)
        result = original_native(target, information, descriptor)
        if chosen: statuses.append(result)
        return result
    def cancel(target, operation):
        if selected(target) and not raced and stage == 'after_final_post_check': start_writer(target)
        return original_cancel(target, operation)
    def setter(self, target, acl, **options):
        chosen = selected(target)
        callback = options.get('on_write')
        if chosen and callback is not None:
            def committed():
                receipts.append('native-success')
                callback()
            options['on_write'] = committed
        result = actual_set(self, target, acl, **options)
        if chosen and not raced and stage in {'after_native_ack', 'after_ack_exception'}:
            start_writer(target)
            if stage == 'after_ack_exception':
                raise OSError('setter instrumentation failed after native acknowledgment')
        return result
    async def exercise():
        async with rights.native_owner_access(work): entered.append(True)
    # Track this operation's actual Win32 handles rather than unrelated pytest
    # or asyncio process-wide activity. Include the preopened writer handle.
    owned, opened, closed = {other}, [], []
    bookkeeping = threading.RLock()
    actual_close, actual_create = api.kernel.CloseHandle, api.files.native.NtCreateFile
    actual_file, actual_event = api.kernel.CreateFileW, api.kernel.CreateEventW
    def register(value):
        value = value.value if hasattr(value, 'value') else value
        with bookkeeping:
            if value not in (None, w.HANDLE(-1).value):
                assert value not in owned
                owned.add(value); opened.append(value)
        return value
    def close(value):
        with bookkeeping:
            result = actual_close(value)
            value = value.value if hasattr(value, 'value') else value
            if value in owned:
                assert result, 'A native operation handle was not closed'
                owned.remove(value); closed.append(value)
        return result
    def create(*arguments):
        result = actual_create(*arguments)
        if result >= 0: register(c.cast(arguments[0], c.POINTER(w.HANDLE))[0])
        return result
    caught = None
    try:
        projected, additions = rights.owner_entries(policy, owner)
        assert set(additions) == {external, read}, 'Fixture must project both the owner deny and READ grant'
        if writer_policy == 'stale_equal_counts': assert stale == projected
        with monkeypatch.context() as patch:
            patch.setattr(api.kernel, 'CloseHandle', close)
            patch.setattr(api.kernel, 'CreateFileW', lambda *args: register(actual_file(*args)))
            patch.setattr(api.kernel, 'CreateEventW', lambda *args: register(actual_event(*args)))
            patch.setattr(api.files.native, 'NtCreateFile', create)
            patch.setattr(rights._Projection, '__init__', track)
            patch.setattr(guard, 'descriptor_guard', observe)
            patch.setattr(rights._Windows, 'set_acl', setter)
            patch.setattr(api.files.native, 'NtSetSecurityObject', native)
            patch.setattr(api.kernel, 'CancelIoEx', cancel)
            try: runner.run(exercise())
            except BaseException as error: caught = error
            finally:
                # Keep the close interceptor installed until the writer closes
                # its own FILE_OBJECT; otherwise accounting races patch teardown.
                if worker.ident is not None: worker.join(timeout=3)
        assert worker.ident is not None, repr(caught)
        worker.join(timeout=3)
        current_owner, current = api.security(root)
        evidence = dict(stage=stage, writerPolicy=writer_policy, nativeStatus=statuses,
            receipts=receipts, owner=current_owner.hex(), originalOwner=owner.hex(), acl=current.hex(),
            aclEntries=[item.hex() for item in rights._entries(current)], writerErrors=errors,
            writerDone=done.is_set(), writerAlive=worker.is_alive(), error=repr(caught), bodyEntered=bool(entered),
            operationOpened=len(opened) + 1, operationClosed=len(closed), remainingHandles=list(owned),
            nodesClosed=not states[0].nodes, journalClosed=not states[0].changes)
        destination = os.environ.get('OPENDIRECTOR_ACL_EVIDENCE')
        if destination:
            with Path(destination).open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(evidence) + '\n')
        assert raced and done.is_set() and not worker.is_alive() and errors == []
        assert statuses == [0] and receipts == ['native-success']
        assert isinstance(caught, ExceptionGroup)
        assert all(isinstance(error, rights.InstallationUnconfirmedError) for error in caught.exceptions)
        assert isinstance(caught.__context__, rights.InstallationUnconfirmedError)
        assert not entered, 'Unconfirmed installation must not begin execution'
        assert current_owner == owner and current == snapshots[0]
        assert rights._entries(current).count(external) == (2 if writer_policy == 'additive' else 1)
        assert not owned and len(opened) + 1 == len(closed)
        assert not states[0].nodes and not states[0].changes and not states[0].unconfirmed
        # The fixture can establish the writer's intended final policy. The
        # product must not infer it, even if a replay retained the same counts.
        probe.edit(root, lambda current_owner, acl: rights._acl(policy, [external] + rights._entries(policy)))
        async def acquire_again():
            async with asyncio.timeout(5):
                async with rights.native_owner_access(work): pass
        runner.run(acquire_again())
        assert rights._entries(api.security(root)[1]) == [external] + rights._entries(policy)
        if destination:
            with Path(destination).open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(dict(stage=stage, writerPolicy=writer_policy, leaseReacquired=True)) + '\n')
    finally:
        if worker.ident is not None: worker.join(timeout=3)
        else: api.kernel.CloseHandle(other)
        probe.edit(root, lambda current_owner, acl: original)
        probe.close()
        runner.close()
