import { spawnSync } from "node:child_process";
import { options, ROOT, select, unitCatalog } from "./pre-commit/test-marks.ts";

try {
  const { selection, list, forwarded } = options(process.argv.slice(2), { passthrough: true });
  if (selection.lane) throw new Error("Unit tests have no browser lane");
  const entries = select(unitCatalog(), selection);
  if (list) console.log(JSON.stringify(entries, null, 2));
  else {
    if (!entries.length) throw new Error("No matching unit files");
    const result = spawnSync(process.execPath, ["--test", ...forwarded, ...entries.map((entry) => entry.script)], {
      cwd: ROOT, stdio: "inherit", env: process.env,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
