/** Host-only adapters for the isolated browser fixtures. No user PIDs/profiles. */
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const nativeHelper = fileURLToPath(
  new URL("./windows_host.py", import.meta.url),
);
const owned = new WeakMap();
const checkedPython = new Set();

export function executable(name, env = process.env) {
  if (name === "node") return process.execPath;
  const path =
    Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ??
    "";
  const candidates =
    isAbsolute(name) || name.includes("/") || name.includes("\\")
      ? [resolve(name)]
      : path
          .split(delimiter)
          .flatMap((directory) =>
            (process.platform === "win32"
              ? [name, `${name}.exe`, `${name}.com`]
              : [name]
            ).map((value) => join(directory, value)),
          );
  for (const candidate of candidates) {
    try {
      accessSync(
        candidate,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      // Preserve a venv's Python symlink spelling; resolving it selects the
      // base interpreter and defeats installed-wheel isolation on POSIX.
      return resolve(candidate);
    } catch {}
  }
  throw new Error(`Browser host executable unavailable: ${name}`);
}

export function pythonExecutable(env = process.env) {
  let python;
  if (env.PYTHON !== undefined) {
    // An explicit interpreter is a requirement, never silently substituted.
    python = executable(env.PYTHON, env);
  } else {
    const candidates = [
      process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
      "python3",
      "python",
    ];
    for (const candidate of candidates) {
      try { python = executable(candidate, env); break; } catch {}
    }
    if (!python) throw new Error("Browser host Python unavailable; set PYTHON or install Python on PATH");
  }
  if (process.platform === "win32" && !checkedPython.has(python)) {
    // Packaged Python activation can start descendants outside a caller's job.
    // Reject it before launching the test application; never report that job
    // termination contained such a tree. Python.org venvs keep job ownership.
    const packaged = execFileSync(
      python,
      [
        "-c",
        "import ctypes; from ctypes import wintypes as w; k=ctypes.WinDLL('kernel32'); n=w.UINT(); code=k.GetCurrentPackageFullName(ctypes.byref(n),None); assert code in (122,15700),code; print(int(code!=15700))",
      ],
      { env, encoding: "utf8", windowsHide: true, timeout: 5000 },
    ).trim();
    if (packaged !== "0")
      throw new Error(
        "Owned browser processes require an unpackaged Python.org environment; packaged Python activation does not retain job ownership",
      );
    checkedPython.add(python);
  }
  return python;
}

export function sourcePythonPath(...extra) {
  return ["packages/core/src", "apps/api/src", ...extra]
    .map((part) => resolve(part))
    .join(delimiter);
}

export function installedServerEnv(python, root, inherited = process.env) {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([key]) => {
      const upper = key.toUpperCase();
      return (
        !upper.startsWith("OPENDIRECTOR_") &&
        !["PYTHONPATH", "PYTHONHOME", "PATH"].includes(upper)
      );
    }),
  );
  env.PYTHON = python;
  env.PYTHONNOUSERSITE = "1";
  env.OPENDIRECTOR_ROOT = root;
  // The installed font/editor service needs Python, not the host's Node/tools.
  // Windows also needs its system directories; never inherit a source PATH.
  env.PATH = [
    dirname(python),
    ...(process.platform === "win32"
      ? [
          join(env.SystemRoot ?? env.SYSTEMROOT, "System32"),
          join(env.SystemRoot ?? env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0"),
          env.SystemRoot ?? env.SYSTEMROOT,
        ]
      : []),
  ].join(delimiter);
  return env;
}

export function spawnOwned(command, args, options = {}) {
  const env = options.env ?? process.env;
  const binary = executable(command, env);
  const windows = process.platform === "win32";
  if (
    windows &&
    /^python(?:w|[\d.]*)?\.exe$/i.test(binary.split(/[\\/]/).at(-1))
  )
    pythonExecutable({ ...env, PYTHON: binary });
  const child = windows
    ? spawn(pythonExecutable(env), [nativeHelper, "run", binary, ...args], {
        ...options,
        windowsHide: true,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
      })
    : spawn(binary, args, { ...options, detached: true });
  const record = { windows, error: undefined, exited: false, stopped: false };
  child.on("error", (error) => {
    record.error = error;
  });
  child.on("exit", () => {
    record.exited = true;
  });
  if (windows)
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") record.error = error;
    });
  owned.set(child, record);
  return child;
}

export async function stopOwned(child) {
  if (!child) return;
  const record = owned.get(child);
  if (!record)
    throw new Error("Refusing to stop a process not created by spawnOwned");
  if (record.error) throw record.error;
  if (record.stopped) return;
  const requestedStop = !record.exited;
  if (record.windows) {
    if (!record.exited) child.stdin.end("stop\n");
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 8000;
  const killAfter = Date.now() + 2000;
  let escalated = false;
  while (!record.exited) {
    if (record.error) throw record.error;
    if (!record.windows && !escalated && Date.now() >= killAfter) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      escalated = true;
    }
    if (Date.now() >= deadline)
      throw new Error("Owned browser process did not close");
    await delay(20);
  }
  if (!record.windows) {
    // A detached root can exit before its descendants; finish its private group.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  // exit and close are distinct: inherited pipes can remain open after the
  // controller exits. The Windows controller has already drained its owned
  // job; close only our pipe endpoints instead of waiting on another process.
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream?.destroy();
  record.stopped = true;
  if (record.windows && requestedStop && child.exitCode !== 0)
    throw new Error(`Owned browser controller failed during cleanup: ${child.exitCode ?? child.signalCode}`);
}

export const rssDefinition =
  process.platform === "win32"
    ? "Sum of native Windows working sets for CDP-reported isolated Chrome PIDs; shared pages may be counted more than once; sampled peak is not private or instantaneous memory"
    : "Sum of ps RSS for CDP-reported isolated Chrome PIDs; shared pages may be counted more than once; sampled peak is not private or instantaneous memory";

export function sampleProcessRss(ids) {
  if (
    !ids.length ||
    ids.length > 128 ||
    ids.some(
      (pid) => !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff,
    )
  )
    throw new Error("Expected a bounded positive CDP PID list");
  if (process.platform === "win32")
    return JSON.parse(
      execFileSync(
        pythonExecutable(),
        [nativeHelper, "rss", ...ids.map(String)],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      ),
    );
  if (!["linux", "darwin"].includes(process.platform))
    throw new Error("Host RSS sampling unavailable on this platform");
  return execFileSync("ps", ["-o", "pid=,ppid=,rss=", "-p", ids.join(",")], {
    encoding: "utf8",
    timeout: 3000,
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, parentPid, rssKiB] = line.trim().split(/\s+/).map(Number);
      return { pid, parentPid, rssKiB };
    });
}
