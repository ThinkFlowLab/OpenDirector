"""Fail-closed NTFS security updates protected by a short RH oplock.

SET_SECURITY on another FILE_OBJECT breaks HANDLE_CACHING and waits for an
acknowledgment. Keep the oplock until the update finishes, then close the
handle. New hard links do NOT reliably break an oplock: never use this guard
to modify existing file ACLs.

https://learn.microsoft.com/openspecs/windows_protocols/ms-fsa/306239fb-cb60-49fe-b293-df4d1a5f757a
"""
from contextlib import contextmanager
import ctypes as c
from ctypes import wintypes as w
import struct


class Overlapped(c.Structure):
    _fields_ = [('Internal', c.c_size_t), ('InternalHigh', c.c_size_t),
                ('Offset', w.DWORD), ('OffsetHigh', w.DWORD), ('Event', w.HANDLE)]


@contextmanager
def descriptor_guard(api, handle):
    """Own and close an asynchronous handle, including on request failure."""
    kernel, event, requested, body_returned = api.kernel, None, False, False
    kernel.CreateEventW.argtypes = [c.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR]
    kernel.CreateEventW.restype = w.HANDLE
    kernel.DeviceIoControl.argtypes = [w.HANDLE, w.DWORD, c.c_void_p, w.DWORD,
        c.c_void_p, w.DWORD, c.c_void_p, c.POINTER(Overlapped)]
    kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    kernel.WaitForSingleObject.restype = w.DWORD
    kernel.CancelIoEx.argtypes = [w.HANDLE, c.POINTER(Overlapped)]
    kernel.GetOverlappedResult.argtypes = [w.HANDLE, c.POINTER(Overlapped), c.POINTER(w.DWORD), w.BOOL]
    try:
        event = kernel.CreateEventW(None, True, False, None)
        if not event: raise c.WinError(c.get_last_error())
        request = c.create_string_buffer(struct.pack('<HHII', 1, 12, 3, 1))  # READ=1 | HANDLE=2
        output = c.create_string_buffer(24)
        operation = Overlapped(Event=event)
        success = kernel.DeviceIoControl(handle, 0x90240, request, 12, output, 24, None, c.byref(operation))
        error = c.get_last_error()
        if success or error != 997:  # Only ERROR_IO_PENDING means granted.
            raise c.WinError(error if not success else 300)
        requested = True
        def unchanged():
            status = kernel.WaitForSingleObject(event, 0)
            if status != 258:  # WAIT_TIMEOUT means no oplock break.
                raise c.WinError(c.get_last_error() if status == 0xFFFFFFFF else 995)
        unchanged()
        yield unchanged
        body_returned = True
    finally:
        try:
            if requested:
                if not kernel.CancelIoEx(handle, c.byref(operation)) and c.get_last_error() != 1168:
                    raise c.WinError(c.get_last_error())
                size = w.DWORD()
                if not kernel.GetOverlappedResult(handle, c.byref(operation), c.byref(size), True):
                    error = c.get_last_error()
                    if error != 995: raise c.WinError(error)
                elif body_returned:
                    # Successful completion means an independent writer broke
                    # the original request, even if the final body check had
                    # just returned. Our own cancellation completes with 995.
                    # Release first, then let edit recompute/confirm against
                    # that writer. Never replace an existing body exception.
                    raise c.WinError(995)
        finally:
            kernel.CloseHandle(handle)
            if event: kernel.CloseHandle(event)
