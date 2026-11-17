"""Windows handle-relative execution file access (imported only on Windows).

NtCreateFile's RootDirectory binds each single-component lookup to an already
opened directory. FILE_OPEN_REPARSE_POINT opens links themselves; inspect the
returned handle and reject every reparse tag. No check-then-open path fallback.
Directory/file sharing excludes delete and write, pinning opened objects during
the operation. Failed output writes delete the created object by handle.

API contracts: https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntcreatefile
https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle
"""
from contextlib import ExitStack, contextmanager
import ctypes as c
from ctypes import wintypes as w
import msvcrt
import os
from pathlib import PureWindowsPath

from opendirector.domain.projects import ProjectError


class UnicodeString(c.Structure):
    _fields_ = [('Length', w.USHORT), ('MaximumLength', w.USHORT), ('Buffer', w.LPWSTR)]


class ObjectAttributes(c.Structure):
    _fields_ = [('Length', w.ULONG), ('RootDirectory', w.HANDLE),
                ('ObjectName', c.POINTER(UnicodeString)), ('Attributes', w.ULONG),
                ('SecurityDescriptor', w.LPVOID), ('SecurityQualityOfService', w.LPVOID)]


class IoStatus(c.Structure):
    _fields_ = [('Status', c.c_void_p), ('Information', c.c_size_t)]


class AttributeTag(c.Structure):
    _fields_ = [('Attributes', w.DWORD), ('Tag', w.DWORD)]


class Disposition(c.Structure):
    _fields_ = [('DeleteFile', c.c_ubyte)]


kernel = c.WinDLL('kernel32', use_last_error=True)
native = c.WinDLL('ntdll')
kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
kernel.CreateFileW.restype = w.HANDLE
kernel.CloseHandle.argtypes = [w.HANDLE]
kernel.CloseHandle.restype = w.BOOL
kernel.GetFileInformationByHandleEx.argtypes = [w.HANDLE, c.c_int, w.LPVOID, w.DWORD]
kernel.GetFileInformationByHandleEx.restype = w.BOOL
kernel.GetFileType.argtypes = [w.HANDLE]
kernel.GetFileType.restype = w.DWORD
kernel.SetFileInformationByHandle.argtypes = [w.HANDLE, c.c_int, w.LPVOID, w.DWORD]
kernel.SetFileInformationByHandle.restype = w.BOOL
kernel.GetCurrentProcess.restype = w.HANDLE
kernel.DuplicateHandle.argtypes = [w.HANDLE, w.HANDLE, w.HANDLE, c.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD]
kernel.DuplicateHandle.restype = w.BOOL
native.NtCreateFile.argtypes = [c.POINTER(w.HANDLE), w.DWORD, c.POINTER(ObjectAttributes),
    c.POINTER(IoStatus), w.LPVOID, w.ULONG, w.ULONG, w.ULONG, w.ULONG, w.LPVOID, w.ULONG]
native.NtCreateFile.restype = w.LONG
native.RtlNtStatusToDosError.argtypes = [w.LONG]
native.RtlNtStatusToDosError.restype = w.ULONG

DIRECTORY = 0x10
REPARSE_POINT = 0x400
OPEN_REPARSE_POINT = 0x00200000
SYNCHRONOUS_IO = 0x20
SYNCHRONIZE = 0x00100000
READ_ATTRIBUTES = 0x80
SHARE_READ = 1


def _attributes(handle):
    info = AttributeTag()
    if not kernel.GetFileInformationByHandleEx(handle, 9, c.byref(info), c.sizeof(info)):
        raise c.WinError(c.get_last_error())
    if info.Attributes & REPARSE_POINT:
        raise c.WinError(1920)  # ERROR_CANT_ACCESS_FILE; never follow a reparse tag.
    return info.Attributes


def _validate_component(name):
    # NT names must be individual ordinary filenames: no ADS, Win32 device
    # aliases, trailing-dot/space normalization, wildcards or embedded NULs.
    if (not name or name in {'.', '..'} or name[-1] in ' .'
            or any(ch in name for ch in '\\/:*?"<>|') or any(ord(ch) < 32 for ch in name)
            or PureWindowsPath(name).is_reserved()):
        raise c.WinError(123)
    length = len(name.encode('utf-16-le'))
    if length > 65532:
        raise c.WinError(206)
    return length


def validate_path(path):
    # GetFullPathName (used by abspath) strips final dots/spaces and can map
    # DOS devices to a different namespace. Reject aliases BEFORE normalization.
    if path.drive and not path.root:
        raise c.WinError(123)
    for part in path.parts[1:] if path.anchor else path.parts:
        if part != '..':
            _validate_component(part)


def _open_relative(parent, name, *, directory=False, create=False):
    length = _validate_component(name)
    buffer = c.create_unicode_buffer(name)
    text = UnicodeString(length, length + 2, c.cast(buffer, w.LPWSTR))
    attributes = ObjectAttributes(c.sizeof(ObjectAttributes), parent, c.pointer(text), 0x40, None, None)
    handle, status = w.HANDLE(), IoStatus()
    access = (READ_ATTRIBUTES | 0x21) if directory else (0x40000000 | READ_ATTRIBUTES | 0x10000 if create else 0x80000000)
    result = native.NtCreateFile(c.byref(handle), access | SYNCHRONIZE, c.byref(attributes),
        c.byref(status), None, 0, SHARE_READ, 2 if create else 1,
        OPEN_REPARSE_POINT | SYNCHRONOUS_IO | (1 if directory else 0), None, 0)
    if result < 0:
        raise c.WinError(native.RtlNtStatusToDosError(result))
    return handle.value


def _delete_created(handle):
    disposition = Disposition(True)
    if not kernel.SetFileInformationByHandle(handle, 4, c.byref(disposition), c.sizeof(disposition)):
        raise c.WinError(c.get_last_error())


@contextmanager
def open_file(work, parts, create):
    with ExitStack() as stack:
        # Start at the volume/share root, never at a possibly replaced work
        # path. Each ancestor and the execution root itself is opened relative
        # to its pinned parent and checked for every reparse tag.
        root_name = work.anchor
        if not root_name.startswith('\\\\?\\'):
            root_name = ('\\\\?\\UNC\\' + root_name[2:]) if root_name.startswith('\\\\') else '\\\\?\\' + root_name
        with ExitStack() as ancestry:
            parent = kernel.CreateFileW(root_name, READ_ATTRIBUTES | 0x21, SHARE_READ, None, 3,
                                        0x02000000 | OPEN_REPARSE_POINT, None)
            if parent == w.HANDLE(-1).value:
                raise c.WinError(c.get_last_error())
            ancestry.callback(kernel.CloseHandle, parent)
            if not _attributes(parent) & DIRECTORY:
                raise c.WinError(267)
            for part in work.parts[1:]:
                parent = _open_relative(parent, part, directory=True)
                ancestry.callback(kernel.CloseHandle, parent)
                _attributes(parent)
            root = w.HANDLE()
            process = kernel.GetCurrentProcess()
            if not kernel.DuplicateHandle(process, parent, process, c.byref(root), 0, False, 2):
                raise c.WinError(c.get_last_error())
            stack.callback(kernel.CloseHandle, root)
        # The execution root is now pinned without delete/write sharing. All
        # remaining I/O is handle-relative to it, so the lookup ancestors can
        # close. Keeping project ancestors open would block manifest replacement
        # during normal asset registration; no sharing protections are relaxed.
        parent = root.value
        for part in parts[:-1]:
            parent = _open_relative(parent, part, directory=True)
            stack.callback(kernel.CloseHandle, parent)
            _attributes(parent)
        handle = _open_relative(parent, parts[-1], create=create)
        stack.callback(kernel.CloseHandle, handle)
        try:
            if _attributes(handle) & DIRECTORY or kernel.GetFileType(handle) != 1:
                raise ProjectError('发布产物必须是非空普通文件。')
            duplicate = w.HANDLE()
            process = kernel.GetCurrentProcess()
            if not kernel.DuplicateHandle(process, handle, process, c.byref(duplicate), 0, False, 2):
                raise c.WinError(c.get_last_error())
            try:
                fd = msvcrt.open_osfhandle(duplicate.value,
                    os.O_BINARY | os.O_NOINHERIT | (os.O_WRONLY if create else os.O_RDONLY))
            except BaseException:
                kernel.CloseHandle(duplicate)
                raise
            try:
                stream = os.fdopen(fd, 'wb' if create else 'rb')
            except BaseException:
                os.close(fd)
                raise
            with stream:
                yield stream
        except BaseException:
            if create:
                _delete_created(handle)
            raise
