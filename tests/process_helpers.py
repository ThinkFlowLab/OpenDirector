"""Real child-process fixtures on POSIX and Windows, including spaced paths."""
import os
from pathlib import Path
import sys
from contextlib import contextmanager


@contextmanager
def project_heartbeat(client, project_id: str, session: str, *, interval=15):
    """Drive the same PUT/15-second lease renewal as a visible project window.

    A blocking TestClient stream has no browser timer. Keep its existing caller
    session alive; a refused renewal is a test failure, never a new identity or
    a lease-policy override. Join before the caller explicitly closes a session.
    """
    import threading
    stopped = threading.Event()
    result = {'count': 0, 'failures': []}
    def pulse():
        response = client.put('/api/creation/sessions/' + session, json={'projectId': project_id})
        assert response.status_code == 200, (response.status_code, response.text)
        result['count'] += 1
    pulse()
    def repeat():
        while not stopped.wait(interval):
            try: pulse()
            except Exception as error:
                result['failures'].append(error)
                return
    worker = threading.Thread(target=repeat, daemon=True, name='test-project-heartbeat')
    worker.start()
    try: yield result
    finally:
        stopped.set(); worker.join(timeout=10)
        assert not worker.is_alive(), 'Project heartbeat did not stop'
        assert not result['failures'], result['failures']


def native_user_directory(path: Path):
    """Inspect a fresh caller-owned native fixture without changing its ACL.

    Python's Windows private temporary directories may use OWNER RIGHTS rather
    than an ordinary user directory's concrete owner SID. Keep that distinction
    visible in native-engine failures; never repair permissions for a test.
    """
    import stat
    facts = path.lstat()
    if not stat.S_ISDIR(facts.st_mode) or getattr(facts, 'st_file_attributes', 0) & 0x400:
        raise ValueError('Native fixture must be an ordinary directory')
    if any(path.iterdir()):
        raise ValueError('Native fixture must be empty')
    if os.name != 'nt':
        return None
    import ctypes as c
    from ctypes import wintypes as w
    from contextlib import ExitStack
    for parent in path.parents:
        if getattr(parent.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Native fixture ancestors cannot be reparse points')
    kernel = c.WinDLL('kernel32', use_last_error=True)
    api = c.WinDLL('advapi32', use_last_error=True)
    ptr = c.c_void_p
    kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ptr, w.DWORD, w.DWORD, w.HANDLE]
    kernel.CreateFileW.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.LocalFree.argtypes = [ptr]; kernel.LocalFree.restype = ptr
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.GetFileInformationByHandleEx.argtypes = [w.HANDLE, c.c_int, ptr, w.DWORD]
    api.GetSecurityInfo.argtypes = [w.HANDLE, c.c_int, w.DWORD, ptr, ptr, ptr, ptr, c.POINTER(ptr)]
    api.GetSecurityInfo.restype = w.DWORD
    api.GetSecurityDescriptorOwner.argtypes = [ptr, c.POINTER(ptr), c.POINTER(w.BOOL)]
    api.ConvertSidToStringSidW.argtypes = [ptr, c.POINTER(ptr)]
    api.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [ptr, w.DWORD, w.DWORD, c.POINTER(ptr), ptr]
    api.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)]
    api.GetTokenInformation.argtypes = [w.HANDLE, c.c_int, ptr, w.DWORD, c.POINTER(w.DWORD)]
    api.EqualSid.argtypes = [ptr, ptr]
    def checked(ok):
        if not ok: raise c.WinError(c.get_last_error())
    def text(sd):
        value = ptr()
        checked(api.ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 7, c.byref(value), None))
        try: return c.wstring_at(value)
        finally: kernel.LocalFree(value)
    spelling = str(path.absolute())
    spelling = '\\\\?\\UNC\\' + spelling[2:] if spelling.startswith('\\\\') else '\\\\?\\' + spelling
    with ExitStack() as cleanup:
        handle = kernel.CreateFileW(spelling, 0x20080, 1, None, 3, 0x02200000, None)
        if handle == w.HANDLE(-1).value: raise c.WinError(c.get_last_error())
        cleanup.callback(kernel.CloseHandle, handle)
        attributes = (w.DWORD * 2)()
        checked(kernel.GetFileInformationByHandleEx(handle, 9, attributes, c.sizeof(attributes)))
        if attributes[0] & 0x400 or not attributes[0] & 0x10:
            raise ValueError('Native fixture must be an ordinary directory')
        sd = ptr()
        error = api.GetSecurityInfo(handle, 1, 7, None, None, None, None, c.byref(sd))
        if error: raise c.WinError(error)
        cleanup.callback(kernel.LocalFree, sd)
        owner, defaulted = ptr(), w.BOOL()
        checked(api.GetSecurityDescriptorOwner(sd, c.byref(owner), c.byref(defaulted)))
        token, length = w.HANDLE(), w.DWORD()
        checked(api.OpenProcessToken(kernel.GetCurrentProcess(), 8, c.byref(token)))
        cleanup.callback(kernel.CloseHandle, token)
        api.GetTokenInformation(token, 1, None, 0, c.byref(length))
        buffer = c.create_string_buffer(length.value)
        checked(api.GetTokenInformation(token, 1, buffer, len(buffer), c.byref(length)))
        if not api.EqualSid(owner, ptr.from_buffer(buffer).value):
            raise PermissionError('Native fixture is not owned by the caller')
        sid_text = ptr()
        checked(api.ConvertSidToStringSidW(owner, c.byref(sid_text)))
        cleanup.callback(kernel.LocalFree, sid_text)
        sid = c.wstring_at(sid_text)
        descriptor = text(sd)
        return {'descriptor': descriptor, 'owner': sid, 'ownerRights': ';;;OW)' in descriptor}


def python_cli(path: Path, source: str) -> Path:
    """Build an executable fixture, rather than relying on Windows shebangs."""
    script = path.with_suffix('.py') if os.name == 'nt' else path
    # sys.executable can contain spaces. POSIX uses a shell trampoline just as
    # installers do; Windows uses distlib's native console launcher.
    import shlex
    header = ('#!/bin/sh\n\'\'\'exec\' ' + shlex.quote(sys.executable)
              + ' "$0" "$@"\n\' \'\'\'\n')
    script.write_text(('#!python\n' if os.name == 'nt' else header) + source,
                      encoding='utf-8', newline='\n')
    script.chmod(0o755)
    if os.name != 'nt':
        return script
    from distlib.scripts import ScriptMaker
    maker = ScriptMaker(str(script.parent), str(script.parent))
    maker.executable = sys.executable
    maker.clobber = True
    maker.force = True
    return Path(maker.make(script.name)[0])


def directory_link(path: Path, target: Path) -> None:
    """Make a genuine directory redirection without Windows symlink privilege."""
    if os.name == 'nt':
        import _winapi
        _winapi.CreateJunction(str(target.resolve()), str(path))
    else:
        path.symlink_to(target, target_is_directory=True)


def assert_process_exited(pid: int) -> None:
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE
        if not handle:
            assert ctypes.get_last_error() == 87  # PID no longer exists
            return
        try:
            assert kernel.WaitForSingleObject(handle, 0) == 0
        finally:
            kernel.CloseHandle(handle)
    else:
        import pytest
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
