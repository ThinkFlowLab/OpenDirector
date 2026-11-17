"""Native host operations for isolated browser tests, never user processes.

The runner creates its child suspended and assigns it to a private unnamed job
before resuming. Closing stdin requests termination of that job only. Closing
the runner also kills the job; descendants cannot outlive a crashed controller.
https://learn.microsoft.com/windows/win32/procthread/job-objects
"""
import ctypes as c
from ctypes import wintypes as w
import json
import os
import subprocess
import sys
import threading
import time


def kernel_api():
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    kernel.QueryInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
    kernel.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
    kernel.ResumeThread.argtypes = [w.HANDLE]
    kernel.ResumeThread.restype = w.DWORD
    kernel.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
    kernel.GetProcessTimes.argtypes = [w.HANDLE, c.POINTER(w.FILETIME), c.POINTER(w.FILETIME),
        c.POINTER(w.FILETIME), c.POINTER(w.FILETIME)]
    kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    kernel.WaitForSingleObject.restype = w.DWORD
    return kernel


def checked(value):
    if not value: raise c.WinError(c.get_last_error())
    return value


class BasicLimits(c.Structure):
    _fields_ = [('ProcessTime', c.c_int64), ('JobTime', c.c_int64),
        ('Flags', w.DWORD), ('MinimumWorkingSet', c.c_size_t), ('MaximumWorkingSet', c.c_size_t),
        ('ActiveProcessLimit', w.DWORD), ('Affinity', c.c_size_t),
        ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]


class ExtendedLimits(c.Structure):
    _fields_ = [('Basic', BasicLimits), ('IoCounters', c.c_uint64 * 6),
        ('ProcessMemory', c.c_size_t), ('JobMemory', c.c_size_t),
        ('PeakProcessMemory', c.c_size_t), ('PeakJobMemory', c.c_size_t)]


class Accounting(c.Structure):
    _fields_ = [('UserTime', c.c_int64), ('KernelTime', c.c_int64),
        ('PeriodUserTime', c.c_int64), ('PeriodKernelTime', c.c_int64),
        ('PageFaults', w.DWORD), ('TotalProcesses', w.DWORD),
        ('ActiveProcesses', w.DWORD), ('TerminatedProcesses', w.DWORD)]


def run_owned(arguments):
    import _winapi
    import msvcrt
    kernel = kernel_api()
    job = checked(kernel.CreateJobObjectW(None, None))
    process = thread = None
    stopped = threading.Event()
    try:
        limits = ExtendedLimits(Basic=BasicLimits(Flags=0x2000))  # KILL_ON_JOB_CLOSE
        checked(kernel.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)))
        with open(os.devnull, 'rb') as stdin:
            handles = [msvcrt.get_osfhandle(stream.fileno()) for stream in (stdin, sys.stdout, sys.stderr)]
            inherit = [os.get_handle_inheritable(handle) for handle in handles]
            info = subprocess.STARTUPINFO()
            info.dwFlags = subprocess.STARTF_USESTDHANDLES
            info.hStdInput, info.hStdOutput, info.hStdError = handles
            info.lpAttributeList = {'handle_list': handles}
            try:
                for handle in handles: os.set_handle_inheritable(handle, True)
                process, thread, _, _ = _winapi.CreateProcess(arguments[0],
                    subprocess.list2cmdline(arguments), None, None, True,
                    4 | subprocess.CREATE_NO_WINDOW, None, None, info)
            finally:
                for handle, previous in zip(handles, inherit): os.set_handle_inheritable(handle, previous)
        try:
            checked(kernel.AssignProcessToJobObject(job, process))
        except BaseException:
            # This exact suspended child has not executed or spawned anything.
            checked(kernel.TerminateProcess(process, 1))
            if kernel.WaitForSingleObject(process, 5000) != 0:
                raise TimeoutError('Suspended child did not terminate')
            raise
        if kernel.ResumeThread(thread) == 0xFFFFFFFF: raise c.WinError(c.get_last_error())
        def control():
            # A daemon blocked on Python's buffered stdin can hold its lock
            # during interpreter shutdown. Read the control pipe unbuffered.
            os.read(sys.stdin.fileno(), 4096)
            stopped.set()
        threading.Thread(target=control, daemon=True).start()
        while True:
            accounting = Accounting()
            checked(kernel.QueryInformationJobObject(job, 1, c.byref(accounting), c.sizeof(accounting), None))
            if accounting.ActiveProcesses == 0:
                code = w.DWORD()
                checked(kernel.GetExitCodeProcess(process, c.byref(code)))
                return code.value
            if stopped.wait(.025):
                checked(kernel.TerminateJobObject(job, 0))
                deadline = time.monotonic() + 5
                while accounting.ActiveProcesses:
                    if time.monotonic() >= deadline: raise TimeoutError('Owned browser job did not terminate')
                    checked(kernel.QueryInformationJobObject(job, 1, c.byref(accounting), c.sizeof(accounting), None))
                    time.sleep(.01)
                return 0
    finally:
        kernel.CloseHandle(job)
        if thread is not None: kernel.CloseHandle(thread)
        if process is not None: kernel.CloseHandle(process)


class MemoryCounters(c.Structure):
    _fields_ = [('cb', w.DWORD), ('PageFaultCount', w.DWORD)] + [
        (name, c.c_size_t) for name in ('PeakWorkingSet', 'WorkingSet',
        'PeakPagedPool', 'PagedPool', 'PeakNonPagedPool', 'NonPagedPool',
        'Pagefile', 'PeakPagefile')]


def working_sets(pids):
    if not 0 < len(pids) <= 128 or any(not 0 < pid <= 0xFFFFFFFF for pid in pids):
        raise ValueError('Expected a bounded positive CDP PID list')
    kernel = kernel_api()
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    psapi = c.WinDLL('psapi', use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, c.POINTER(MemoryCounters), w.DWORD]
    rows = []
    for pid in pids:
        handle = kernel.OpenProcess(0x1000 | 0x100000, False, pid)  # QUERY_LIMITED | SYNCHRONIZE
        if not handle:
            error = c.get_last_error()
            if error != 87: raise c.WinError(error)
            rows.append(dict(pid=pid, parentPid=None, rssKiB=0, exited=True, verifiedWinerror=error))
            continue
        try:
            if kernel.WaitForSingleObject(handle, 0) == 0:
                rows.append(dict(pid=pid, parentPid=None, rssKiB=0, exited=True))
                continue
            counters = MemoryCounters(cb=c.sizeof(MemoryCounters))
            if not psapi.GetProcessMemoryInfo(handle, c.byref(counters), c.sizeof(counters)):
                error = c.get_last_error()
                # A PID from CDP can exit between the snapshot and this read.
                # Only an actually signaled process handle justifies zero RSS.
                if kernel.WaitForSingleObject(handle, 0) != 0: raise c.WinError(error)
                rows.append(dict(pid=pid, parentPid=None, rssKiB=0, exited=True))
            else:
                created, exited, system, user = w.FILETIME(), w.FILETIME(), w.FILETIME(), w.FILETIME()
                checked(kernel.GetProcessTimes(handle, c.byref(created), c.byref(exited), c.byref(system), c.byref(user)))
                creation_time = (created.dwHighDateTime << 32) | created.dwLowDateTime
                rows.append(dict(pid=pid, parentPid=None, rssKiB=counters.WorkingSet / 1024,
                    exited=False, creationTime=str(creation_time)))
        finally: kernel.CloseHandle(handle)
    return rows


if __name__ == '__main__':
    if os.name != 'nt': raise RuntimeError('Native Windows host API required')
    if sys.argv[1] == 'run': raise SystemExit(run_owned(sys.argv[2:]))
    if sys.argv[1] == 'rss': print(json.dumps(working_sets([int(pid) for pid in sys.argv[2:]])))
    else: raise ValueError('Unknown browser host operation')
