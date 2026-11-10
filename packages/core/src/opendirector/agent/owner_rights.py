"""Owner access for Windows restricted tokens, without changing their write SIDs.

OWNER RIGHTS is not an ordinary enabled SID in a restricted token. Materialize
only rights already assigned to the owner, and keep the original ACEs (including
their suppression of implicit WRITE_DAC). Ancestors get temporary, noninheriting
read access. Initialize owned directories before copying skills or creating
execution files; those files inherit owner access. Never repair an existing
file's ACL: hard links can be added without breaking an oplock. The sandbox
still requires its separate workspace capability, never WRITE_DAC/OWNER.
"""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import os
from pathlib import Path, PureWindowsPath
import struct
import time

OWNER = bytes.fromhex('010100000000000304000000')
CREATOR = bytes.fromhex('010100000000000300000000')
READ = 0x1200A9
MODIFY = 0x1301BF  # no WRITE_DAC, WRITE_OWNER, or FILE_DELETE_CHILD


class CleanupUnconfirmedError(OSError):
    """A committed removal was followed by an indistinguishable ACL replay."""


class InstallationUnconfirmedError(CleanupUnconfirmedError):
    """A native installation succeeded without a confirmed guard release."""


def _specific(mask):
    for generic, specific in ((0x80000000, 0x120089), (0x40000000, 0x120116),
                              (0x20000000, 0x1200A0), (0x10000000, 0x1F01FF)):
        if mask & generic:
            mask = (mask & ~generic) | specific
    return mask


def _entries(acl):
    if len(acl) < 8:
        raise ValueError('Invalid ACL')
    size, count = struct.unpack_from('<HH', acl, 2)
    if size != len(acl):
        raise ValueError('Invalid ACL size')
    entries, offset = [], 8
    for _ in range(count):
        if offset + 4 > size:
            raise ValueError('Invalid ACE')
        length = struct.unpack_from('<H', acl, offset + 2)[0]
        if length < 4 or offset + length > size:
            raise ValueError('Invalid ACE size')
        entries.append(acl[offset:offset + length]); offset += length
    return entries


def _ace(kind, flags, mask, sid):
    return struct.pack('<BBHI', kind, flags, 8 + len(sid), mask) + sid


def _acl(original, entries):
    length = 8 + sum(map(len, entries))
    if length > 65535 or len(entries) > 65535:
        raise ValueError('ACL budget exceeded')
    return original[:2] + struct.pack('<HHH', length, len(entries), 0) + b''.join(entries)


def owner_entries(acl, owner, *, writable=False, directory=True):
    """Add a conservative owner projection; never remove or reorder old ACEs.

    Subtract ALL applicable deny bits, even those for unrelated principals.
    Thus explicit owner entries cannot jump ahead of an inherited group deny.
    CREATOR OWNER maps new children to their own owner, not the parent's user.
    """
    entries = _entries(acl)
    if not any(item[0] in (0, 1) and item[8:] == OWNER for item in entries):
        return acl, []
    if any(item[0] not in (0, 1) or len(item) < 20 for item in entries):
        raise ValueError('Unsupported owner ACL')
    denied = inherited_denied = 0
    for item in entries:
        if item[0] == 1:
            mask = _specific(struct.unpack_from('<I', item, 4)[0])
            if not item[1] & 8: denied |= mask
            if item[1] & 3: inherited_denied |= mask
    additions = []
    for item in entries:
        if item[8:] != OWNER:
            continue
        kind, flags = item[:2]
        mask = _specific(struct.unpack_from('<I', item, 4)[0])
        if not flags & 8:
            bits = mask if kind else mask & (MODIFY if writable else READ) & ~denied
            if bits: additions.append(_ace(kind, 0, bits, owner))
        if writable and directory and flags & 3:
            bits = mask if kind else mask & MODIFY & ~inherited_denied
            if bits: additions.append(_ace(kind, (flags & 7) | 8, bits, CREATOR))
    added = []
    for item in additions:
        if item not in entries and item not in added: added.append(item)
    # New denies precede allows. New allows are conservative subsets with all
    # applicable deny bits removed, so no inherited deny is bypassed.
    result = [a for a in added if a[0] == 1] + entries + [a for a in added if a[0] == 0]
    return _acl(acl, result), added


class _Windows:
    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        from opendirector.infrastructure import windows_execution_files as files
        self.c, self.w, self.files = c, w, files
        self.api = c.WinDLL('advapi32', use_last_error=True)
        self.kernel = files.kernel
        ptr = c.c_void_p
        self.api.GetSecurityInfo.argtypes = [w.HANDLE, c.c_int, w.DWORD, c.POINTER(ptr), ptr, c.POINTER(ptr), ptr, c.POINTER(ptr)]
        self.api.GetSecurityInfo.restype = w.DWORD
        self.api.SetSecurityInfo.argtypes = [w.HANDLE, c.c_int, w.DWORD, ptr, ptr, ptr, ptr]
        self.api.SetSecurityInfo.restype = w.DWORD
        self.api.InitializeSecurityDescriptor.argtypes = [ptr, w.DWORD]
        self.api.SetSecurityDescriptorDacl.argtypes = [ptr, w.BOOL, ptr, w.BOOL]
        self.api.GetSecurityDescriptorControl.argtypes = [ptr, c.POINTER(w.WORD), c.POINTER(w.DWORD)]
        self.api.SetSecurityDescriptorControl.argtypes = [ptr, w.WORD, w.WORD]
        files.native.NtSetSecurityObject.argtypes = [w.HANDLE, w.DWORD, ptr]
        files.native.NtSetSecurityObject.restype = w.LONG
        class SecurityDescriptor(c.Structure):
            _fields_ = [('Revision', w.BYTE), ('Reserved', w.BYTE), ('Control', w.WORD),
                        ('Owner', ptr), ('Group', ptr), ('Sacl', ptr), ('Dacl', ptr)]
        self.descriptor_type = SecurityDescriptor
        self.api.GetLengthSid.argtypes = [ptr]; self.api.GetLengthSid.restype = w.DWORD
        self.api.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)]
        self.api.GetTokenInformation.argtypes = [w.HANDLE, c.c_int, ptr, w.DWORD, c.POINTER(w.DWORD)]
        profile_api = c.WinDLL('userenv', use_last_error=True)
        profile_api.GetUserProfileDirectoryW.argtypes = [w.HANDLE, w.LPWSTR, c.POINTER(w.DWORD)]
        self.kernel.LocalFree.argtypes = [ptr]; self.kernel.LocalFree.restype = ptr
        self.kernel.LockFileEx.argtypes = [w.HANDLE, w.DWORD, w.DWORD, w.DWORD, w.DWORD, ptr]
        self.kernel.UnlockFileEx.argtypes = [w.HANDLE, w.DWORD, w.DWORD, w.DWORD, ptr]
        token, size = w.HANDLE(), w.DWORD()
        if not self.api.OpenProcessToken(self.kernel.GetCurrentProcess(), 8, c.byref(token)):
            raise c.WinError(c.get_last_error())
        try:
            self.api.GetTokenInformation(token, 1, None, 0, c.byref(size))
            data = c.create_string_buffer(size.value)
            if not self.api.GetTokenInformation(token, 1, data, len(data), c.byref(size)):
                raise c.WinError(c.get_last_error())
            self.owner = self.sid(ptr.from_buffer(data).value)
            length = w.DWORD()
            profile_api.GetUserProfileDirectoryW(token, None, c.byref(length))
            if not length.value: raise c.WinError(c.get_last_error())
            profile = c.create_unicode_buffer(length.value)
            if not profile_api.GetUserProfileDirectoryW(token, profile, c.byref(length)):
                raise c.WinError(c.get_last_error())
            self.profile = Path(profile.value)
        finally:
            self.kernel.CloseHandle(token)

    def sid(self, pointer):
        length = self.api.GetLengthSid(pointer)
        if not length: raise self.c.WinError(self.c.get_last_error())
        return self.c.string_at(pointer, length)

    def security(self, handle):
        c = self.c
        owner, dacl, descriptor = c.c_void_p(), c.c_void_p(), c.c_void_p()
        result = self.api.GetSecurityInfo(handle, 1, 5, c.byref(owner), None, c.byref(dacl), None, c.byref(descriptor))
        if result: raise c.WinError(result)
        try:
            acl = None if not dacl.value else c.string_at(dacl, struct.unpack('<H', c.string_at(dacl.value + 2, 2))[0])
            return self.sid(owner), acl
        finally:
            self.kernel.LocalFree(descriptor)

    def set_acl(self, handle, acl, *, before_write=None, on_write=None):
        # Use this exact FILE_OBJECT, without SetSecurityInfo's user-mode
        # directory reopens/recursive inheritance (which break our own oplock).
        # Only DACL_SECURITY_INFORMATION is changed, never owner/group/SACL.
        data = self.c.create_string_buffer(acl)
        descriptor = self.descriptor_type()
        if not self.api.InitializeSecurityDescriptor(self.c.byref(descriptor), 1):
            raise self.c.WinError(self.c.get_last_error())
        if not self.api.SetSecurityDescriptorDacl(self.c.byref(descriptor), True, data, False):
            raise self.c.WinError(self.c.get_last_error())
        # Native setters take the DACL inheritance/protection controls from
        # the supplied descriptor. Preserve protection and inherited ACEs.
        current, control, revision = self.c.c_void_p(), self.w.WORD(), self.w.DWORD()
        result = self.api.GetSecurityInfo(handle, 1, 4, None, None, None, None, self.c.byref(current))
        if result: raise self.c.WinError(result)
        try:
            if not self.api.GetSecurityDescriptorControl(current, self.c.byref(control), self.c.byref(revision)):
                raise self.c.WinError(self.c.get_last_error())
        finally: self.kernel.LocalFree(current)
        flags = control.value & 0x1500
        if any(item[1] & 16 for item in _entries(acl)): flags |= 0x400
        if not self.api.SetSecurityDescriptorControl(self.c.byref(descriptor), 0x1500, flags):
            raise self.c.WinError(self.c.get_last_error())
        # Descriptor preparation and caller instrumentation can outlive the
        # edit loop's first guard check. Refuse an already broken oplock at
        # the actual write boundary; no removal delta is consumed on refusal.
        if before_write is not None: before_write()
        result = self.files.native.NtSetSecurityObject(handle, 4, self.c.byref(descriptor))
        if result < 0: raise self.c.WinError(self.files.native.RtlNtStatusToDosError(result))
        # Record the native commit before any caller-side post-write checks or
        # instrumentation can raise. A failed native setter owns no entries.
        if on_write is not None: on_write()

    def checked(self, handle):
        attributes = self.files._attributes(handle)
        if self.kernel.GetFileType(handle) != 1: raise self.c.WinError(5)
        return bool(attributes & 0x10)

    def open(self, parent, name, *, maximum=False, lock=False):
        c, w, f = self.c, self.w, self.files
        length = f._validate_component(name)
        buffer = c.create_unicode_buffer(name)
        text = f.UnicodeString(length, length + 2, c.cast(buffer, w.LPWSTR))
        attrs = f.ObjectAttributes(c.sizeof(f.ObjectAttributes), parent, c.pointer(text), 0x40, None, None)
        handle, status = w.HANDLE(), f.IoStatus()
        access = 0xC0100000 if lock else 0x02100000 if maximum else READ
        result = f.native.NtCreateFile(c.byref(handle), access, c.byref(attrs), c.byref(status),
            None, 0, 3 if lock else 7, 3 if lock else 1,
            f.OPEN_REPARSE_POINT | (0 if maximum else f.SYNCHRONOUS_IO) | (0x40 if lock else 0), None, 0)
        if result < 0: raise c.WinError(f.native.RtlNtStatusToDosError(result))
        try:
            self.checked(handle)
            return handle.value
        except BaseException:
            self.kernel.CloseHandle(handle); raise

    def lock(self, handle, *, release=False):
        position = self.c.create_string_buffer(32)  # zero-offset OVERLAPPED
        success = (self.kernel.UnlockFileEx(handle, 0, 1, 0, position) if release else
                   self.kernel.LockFileEx(handle, 3, 0, 1, 0, position))
        if success: return True
        error = self.c.get_last_error()
        if not release and error == 33: return False
        raise self.c.WinError(error)

    def single_link(self, handle):
        info = self.c.create_string_buffer(24)  # FILE_STANDARD_INFO
        if not self.kernel.GetFileInformationByHandleEx(handle, 1, info, len(info)):
            raise self.c.WinError(self.c.get_last_error())
        if struct.unpack_from('<I', info, 16)[0] != 1: raise self.c.WinError(5)

    def identity(self, handle):
        data = self.c.create_string_buffer(24)
        if not self.kernel.GetFileInformationByHandleEx(handle, 18, data, len(data)):
            raise self.c.WinError(self.c.get_last_error())
        return data.raw

    def children(self, handle):
        data = self.c.create_string_buffer(65536)
        info = 15  # FileFullDirectoryRestartInfo, then FileFullDirectoryInfo
        while True:
            if not self.kernel.GetFileInformationByHandleEx(handle, info, data, len(data)):
                error = self.c.get_last_error()
                if error == 18: return
                raise self.c.WinError(error)
            info, offset = 14, 0
            while True:
                next_offset = struct.unpack_from('<I', data, offset)[0]
                size = struct.unpack_from('<I', data, offset + 60)[0]
                if size % 2 or offset + 68 + size > len(data): raise self.c.WinError(13)
                name = data.raw[offset + 68:offset + 68 + size].decode('utf-16-le')
                if name not in ('.', '..'): yield name
                if not next_offset: break
                if next_offset < 68 or offset + next_offset + 68 > len(data): raise self.c.WinError(13)
                offset += next_offset


class _Projection:
    def __init__(self, work, *, tree=True, initialized=False):
        self.api = _Windows()
        self.nodes, self.changes = [], []
        self.unconfirmed = {}
        self.locations = {}
        self.applied = False
        self.initialized = initialized
        c, w, files = self.api.c, self.api.w, self.api.files
        files.validate_path(PureWindowsPath(work))
        path = PureWindowsPath(os.path.abspath(work))
        files.validate_path(path)
        root = path.anchor
        if not root.startswith('\\\\?\\'):
            root = '\\\\?\\UNC\\' + root[2:] if root.startswith('\\\\') else '\\\\?\\' + root
        handle = self.api.kernel.CreateFileW(root, READ, 7, None, 3, 0x02200000, None)
        if handle == w.HANDLE(-1).value: raise c.WinError(c.get_last_error())
        try:
            self.nodes.append((handle, False))
            if not self.api.checked(handle): raise c.WinError(267)
            for name in path.parts[1:]:
                parent = handle
                handle = self.api.open(parent, name)
                self.locations[handle] = (parent, name)
                self.nodes.append((handle, False))
                if not self.api.checked(handle): raise c.WinError(267)
            self.nodes[-1] = (handle, True)
            if tree: self._tree(handle)
        except BaseException:
            self.close(); raise

    def _tree(self, parent):
        for name in self.api.children(parent):
            handle = self.api.open(parent, name)
            self.locations[handle] = (parent, name)
            self.nodes.append((handle, True))
            if self.api.checked(handle): self._tree(handle)
            else: self.api.single_link(handle)

    def keys(self):
        keys = []
        for handle, _ in self.nodes:
            owner, acl = self.api.security(handle)
            if acl and any(a[0] in (0, 1) and a[8:] == OWNER for a in _entries(acl)):
                if owner != self.api.owner: raise self.api.c.WinError(5)
                keys.append(hashlib.sha256(owner + self.api.identity(handle)).hexdigest())
        return sorted(set(keys))

    def apply(self):
        # Fresh initialization precedes execution files. An initialized session
        # may contain files, but neither mode edits their shared descriptors.
        # Keep alias, single-link and identity checks when resuming as well.
        for handle, writable in self.nodes:
            if writable and not self.api.checked(handle):
                if not self.initialized: raise self.api.c.WinError(5)
                self.api.single_link(handle)
        known = {self.api.identity(handle) for handle, writable in self.nodes if writable}
        for handle, writable in self.nodes:
            if not writable or not self.api.checked(handle): continue
            for name in self.api.children(handle):
                child = self.api.open(handle, name)
                try:
                    if self.api.identity(child) not in known:
                        raise self.api.c.WinError(5)
                    if not self.api.checked(child):
                        if not self.initialized: raise self.api.c.WinError(5)
                        self.api.single_link(child)
                finally: self.api.kernel.CloseHandle(child)
        for handle, writable in self.nodes:
            # A validated resumed session already has its standing projection.
            # Recheck its tree but never rewrite any writable object, including
            # skill directories that preparation may delete and recreate.
            if writable and self.initialized: continue
            planned = []
            def prepare(owner, acl):
                nonlocal planned
                planned = []
                if acl is None: return None
                updated, additions = owner_entries(acl, owner, writable=writable)
                if additions:
                    if owner != self.api.owner: raise self.api.c.WinError(5)
                    planned = additions
                return updated
            def installed():
                # A proposal from an abandoned attempt owns no ACEs. Keep a
                # separate snapshot for each setter that actually succeeded.
                self.changes.append((handle, writable, planned.copy()))
            def unconfirmed(error):
                failure = InstallationUnconfirmedError(
                    'Owner access installation was committed but cannot be confirmed; cleanup was not attempted')
                self.unconfirmed[handle] = failure
                raise failure from error
            # Avoid requesting write access on unrelated system ancestors.
            owner, acl = self.api.security(handle)
            if acl is not None and owner_entries(acl, owner, writable=writable)[1]:
                self.edit(handle, prepare, on_write=installed, on_unconfirmed=unconfirmed)
        self.applied = True

    def release_file_probes(self):
        # Resumed files are inspection-only: no ACL changes refer to them.
        # Keeping READ_DATA handles would prevent writers such as Add-Content
        # that intentionally omit FILE_SHARE_READ. Keep directory bindings and
        # ancestor leases pinned; release only fully validated ordinary files.
        if not self.initialized: return
        for index in range(len(self.nodes) - 1, -1, -1):
            handle, writable = self.nodes[index]
            if writable and not self.api.checked(handle):
                self.nodes.pop(index)
                self.locations.pop(handle, None)
                self.api.kernel.CloseHandle(handle)

    def edit(self, handle, transform, *, on_write=None, on_unconfirmed=None):
        from opendirector.agent.windows_acl_guard import descriptor_guard
        parent, name = self.locations[handle]
        deadline = time.monotonic() + .5
        while True:
            committed, confirmed, setter_error = False, False, None
            def wrote():
                nonlocal committed
                committed = True
                if on_write is not None: on_write()
            try:
                changed = self.api.open(parent, name, maximum=True)
                with descriptor_guard(self.api, changed) as unchanged:
                    if self.api.identity(changed) != self.api.identity(handle): raise self.api.c.WinError(5)
                    if not self.api.checked(changed): raise self.api.c.WinError(5)
                    owner, acl = self.api.security(changed)
                    updated = transform(owner, acl)
                    unchanged()
                    if updated is not None and updated != acl:
                        try:
                            self.api.set_acl(changed, updated, before_write=unchanged, on_write=wrote)
                        except BaseException as error:
                            if not committed or on_unconfirmed is None: raise
                            # A wrapper can fail after the native acknowledgment.
                            # Finish checking/releasing this guard before deciding
                            # whether ordinary rollback still owns those ACEs.
                            setter_error = error
                        # Removal may retry against its committed postcondition;
                        # installation must reject a post-ack guard failure.
                        unchanged()
                confirmed = True
                if setter_error is not None: raise setter_error
                return
            except BaseException as error:
                # An installation receipt proves that we wrote, not that the
                # current identical ACEs are still ours after a guard failure.
                # Even equal counts can be an external replacement. Retain the
                # receipt, refuse execution and never spend that ownership.
                if committed and not confirmed and on_unconfirmed is not None:
                    if setter_error is not None and error is not setter_error:
                        error = BaseExceptionGroup('Owner access setter and guard failed', [setter_error, error])
                    on_unconfirmed(error)
                # Release the oplock before retrying so a pending editor can
                # finish. Recompute against its actual new DACL, never replay
                # the old descriptor. Persistent conflicts remain failures.
                if confirmed or not isinstance(error, OSError) or getattr(error, 'winerror', None) not in {995, 300} or time.monotonic() >= deadline: raise
                time.sleep(.01)

    def close(self):
        failures = []
        for handle, writable, added in reversed(self.changes):
            if handle in self.unconfirmed:
                failures.append(self.unconfirmed[handle])
                continue
            # A successful execution tree keeps the owner projection, just as
            # dsh keeps its standing workspace grant. Ancestors are restored;
            # a failed preparation rolls back every change before any spawn.
            if writable and self.applied: continue
            try:
                committed_counts = None
                proposed_counts = None
                def remove(owner, acl):
                    nonlocal proposed_counts
                    if owner != self.api.owner or acl is None: raise self.api.c.WinError(5)
                    entries = _entries(acl)
                    if committed_counts is not None:
                        # The native removal already succeeded. A writer may
                        # then have replayed a snapshot containing our grant.
                        # Do not spend the delta again: identical ACEs have no
                        # owner identity. Confirm the committed postcondition
                        # under this fresh guard, or explicitly fail cleanup.
                        if any(entries.count(item) != count for item, count in committed_counts.items()):
                            raise CleanupUnconfirmedError(
                                'Owner access cleanup cannot be confirmed after a concurrent ACL update')
                        return acl
                    for item in added:
                        if item in entries: entries.remove(item)
                    proposed_counts = {item: entries.count(item) for item in added}
                    return _acl(acl, entries)
                def removed():
                    nonlocal committed_counts
                    committed_counts = proposed_counts
                    added.clear()
                # Cleanup has the same commit boundary as installation. Once
                # the setter succeeds, a post-write conflict must not remove a
                # second, externally owned copy of an identical ACE on retry.
                self.edit(handle, remove, on_write=removed)
            except BaseException as error: failures.append(error)
        self.changes.clear()
        self.unconfirmed.clear()
        for handle, _ in reversed(self.nodes): self.api.kernel.CloseHandle(handle)
        self.nodes.clear()
        if failures: raise BaseExceptionGroup('Owner access cleanup failed', failures)


@asynccontextmanager
async def native_owner_access(work, *, initialized=False):
    """Lease ancestors; initialize a fresh tree or verify a saved session tree.

    Only the host's validated native-session record selects initialized=True.
    Its standing workspace projection is retained without writable ACL edits.
    """
    if os.name != 'nt':
        yield
        return
    state = _Projection(work, initialized=initialized)
    locks = []
    probe = None
    try:
        keys = state.keys()
        if keys:
            directory = _coordination_directory(state.api)
            directory.mkdir(mode=0o700, exist_ok=True)
            # Check the actual directory, including every ancestor. A lock
            # directory writable by other principals cannot coordinate edits.
            probe = _Projection(directory, tree=False)
            parent = probe.nodes[-1][0]
            owner, acl = probe.api.security(parent)
            allowed = {owner, OWNER, bytes.fromhex('010100000000000512000000'),
                       bytes.fromhex('01020000000000052000000020020000')}
            if (owner != state.api.owner or acl is None or any(
                    item[0] not in (0, 1) or item[0] == 0 and item[8:] not in allowed
                    for item in _entries(acl))):
                raise state.api.c.WinError(5)
            for key in keys:
                # Handle-relative open/create: no pathname reopen, no links,
                # truncation, or writes to the lock file's contents.
                handle = probe.api.open(parent, key + '.lock', lock=True)
                record = [handle, False]; locks.append(record)
                probe.api.single_link(handle)
                if probe.api.security(handle)[0] != owner: raise state.api.c.WinError(5)
                while not probe.api.lock(handle): await asyncio.sleep(.05)
                record[1] = True
        state.apply()
        state.release_file_probes()
        try:
            yield
        except BaseException:
            # Failed setup, spawn and cancellation must not report a completed
            # workspace initialization. Roll back our directory additions too.
            state.applied = False
            raise
    finally:
        try: state.close()
        finally:
            failures = []
            for handle, locked in reversed(locks):
                try:
                    if locked: probe.api.lock(handle, release=True)
                except BaseException as error: failures.append(error)
                finally: state.api.kernel.CloseHandle(handle)
            if probe: probe.close()
            if failures: raise BaseExceptionGroup('Owner access lease cleanup failed', failures)


def _coordination_directory(api):
    # Query the actual token's OS profile, independent of TEMP/TMP, HOME,
    # USERPROFILE or APPDATA overrides in individual backend processes.
    return api.profile / '.opendirector-owner-rights'
