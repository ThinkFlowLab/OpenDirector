import assert from "node:assert/strict";
import test from "node:test";
import { delimiter, dirname, join } from "node:path";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { OwnedProcess } from "./browser/host.mjs";
import {
  executable,
  installedServerEnv,
  pythonExecutable,
  sampleProcessRss,
  sourcePythonPath,
  spawnOwned,
  stopOwned,
} from "./browser/host.mjs";

function line<T>(child: OwnedProcess): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let value = "",
      errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.stdout.on("data", (chunk) => {
      value += chunk;
      if (value.includes("\n")) resolve(JSON.parse(value.split("\n")[0]));
    });
    child.once("error", reject);
    child.once("exit", () => {
      if (!value.includes("\n"))
        reject(new Error(errors || "No child receipt"));
    });
  });
}

function assertExited(pid: number) {
  if (process.platform === "win32") {
    const [row] = sampleProcessRss([pid]);
    assert.equal(row.exited, true, JSON.stringify(row));
    assert.equal(row.rssKiB, 0);
  } else {
    try {
      const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      assert.match(state, /^Z/, "Exited orphan may await its OS reaper");
    } catch (error) {
      if (!(error instanceof Error && "status" in error && error.status === 1))
        throw error;
    }
  }
}

test("Python discovery supports PATH-only installs and preserves explicit and venv selection", () => {
  const python = pythonExecutable();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser Python 中文 ")));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: dirname(python) };
  delete env.PYTHON;
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "PATH" && key !== "PATH") delete env[key];
  const script = `
    import { pythonExecutable } from ${JSON.stringify(new URL("./browser/host.mjs", import.meta.url).href)};
    import { execFileSync } from 'node:child_process';
    const python = pythonExecutable();
    const prefix = execFileSync(python, ['-c', 'import sys; print(sys.prefix)'], {encoding:'utf8'}).trim();
    console.log(JSON.stringify({python, prefix}));
  `;
  const discover = (environment: NodeJS.ProcessEnv) => JSON.parse(execFileSync(
    process.execPath, ["--input-type=module", "-e", script],
    { cwd: root, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ));
  try {
    const expectedPrefix = execFileSync(python, ["-c", "import sys; print(sys.prefix)"], {encoding:"utf8"}).trim();
    assert.equal(realpathSync(discover(env).prefix), realpathSync(expectedPrefix));
    const venv = join(root, ".venv");
    execFileSync(python, ["-m", "venv", "--without-pip", venv], { timeout: 15000 });
    const local = discover(env);
    assert.equal(local.python, join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
    assert.equal(realpathSync(local.prefix), realpathSync(venv));
    assert.equal(discover({ ...env, PYTHON: python }).python, python);
    assert.throws(() => discover({ ...env, PYTHON: join(root, "missing-python") }), /executable unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source search path uses native separators and executable lookup retains a venv spelling", () => {
  const entries = sourcePythonPath("tests").split(delimiter);
  assert.equal(entries.length, 3);
  assert(entries.every((entry) => entry.includes(dirname(process.cwd()))));
  assert.equal(executable("node"), process.execPath);
  assert.equal(executable(pythonExecutable()), pythonExecutable());
});

test("installed server env removes source imports, ambient Node PATH and agent credentials", () => {
  const python = pythonExecutable();
  const env = installedServerEnv(python, "isolated-root", {
    ...process.env,
    PythonPath: "untrusted-source",
    PYTHONHOME: "foreign-home",
    OPENDIRECTOR_AGENT_TOKEN: "fixture-token",
    OPENDIRECTOR_AGENT_SOCKET: "fixture-socket",
    PATH: dirname(process.execPath),
  });
  assert(
    !Object.keys(env).some((key) =>
      ["PYTHONPATH", "PYTHONHOME"].includes(key.toUpperCase()),
    ),
  );
  assert(
    !Object.keys(env).some((key) => key.startsWith("OPENDIRECTOR_AGENT_")),
  );
  const probe = execFileSync(
    python,
    ["-c", "import json,shutil; print(json.dumps(shutil.which('node')))"],
    { env, encoding: "utf8" },
  );
  assert.equal(JSON.parse(probe), null);
  if (process.platform === "win32") {
    const shell = execFileSync(
      python,
      ["-c", "import shutil; assert shutil.which('powershell.exe')"],
      { env, encoding: "utf8" },
    );
    assert.equal(shell, "");
  }
  assert.equal(env.OPENDIRECTOR_ROOT, "isolated-root");
});

test(
  "owned native launch preserves spaced Unicode arguments and the real exit status",
  { timeout: 15000 },
  async () => {
    const arguments_ = [
      "中文 𠮷 path with spaces",
      'literal "quotes" & symbols',
    ];
    const child = spawnOwned(
      pythonExecutable(),
      [
        "-c",
        "import json,sys; print(json.dumps(sys.argv[1:]),flush=True); raise SystemExit(17)",
        ...arguments_,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const ended = once(child, "close");
    assert.deepEqual(await line<string[]>(child), arguments_);
    assert.equal((await ended)[0], 17);
    await stopOwned(child);
  },
);

test(
  "cleanup terminates the owned tree, keeps an unrelated owned sentinel, and is repeatable",
  { timeout: 20000 },
  async () => {
    const script =
      "import json,os,subprocess,sys,time; " +
      "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); " +
      "print(json.dumps({'root':os.getpid(),'descendant':child.pid}),flush=True); time.sleep(60)";
    const sentinel = spawnOwned(
      pythonExecutable(),
      [
        "-c",
        "import json,os,time; print(json.dumps(os.getpid()),flush=True); time.sleep(60)",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const child = spawnOwned(pythonExecutable(), ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const [sentinelPid, receipt] = await Promise.all([
        line<number>(sentinel),
        line<{ root: number; descendant: number }>(child),
      ]);
      assert(
        sampleProcessRss([receipt.root, receipt.descendant]).every(
          (row) => row.rssKiB > 0,
        ),
      );
      await stopOwned(child);
      await stopOwned(child);
      assertExited(receipt.root);
      assertExited(receipt.descendant);
      assert(sampleProcessRss([sentinelPid])[0].rssKiB > 0);
      assert.equal(sentinel.exitCode, null);
    } finally {
      await stopOwned(child);
      await stopOwned(sentinel);
    }
  },
);

test(
  "cleanup owns descendants even after the launched root exits",
  { timeout: 15000 },
  async () => {
    const child = spawnOwned(
      pythonExecutable(),
      [
        "-c",
        "import json,subprocess,sys; " +
          "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(json.dumps(child.pid),flush=True)",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const pid = await line<number>(child);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await stopOwned(child);
      assertExited(pid);
    } finally {
      await stopOwned(child);
    }
  },
);

test("cleanup refuses foreign process objects and memory sampling rejects invalid PID lists", async () => {
  await assert.rejects(
    stopOwned({ pid: process.pid } as ChildProcess),
    /not created by spawnOwned/,
  );
  for (const ids of [[], [-1], [1.5], Array(129).fill(process.pid)])
    assert.throws(() => sampleProcessRss(ids), /bounded positive/);
  const [row] = sampleProcessRss([process.pid]);
  assert.equal(row.pid, process.pid);
  assert(row.rssKiB > 0);
});
