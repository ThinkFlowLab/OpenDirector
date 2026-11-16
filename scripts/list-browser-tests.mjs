import { browserCatalog, options, select } from "./pre-commit/test-marks.ts";

try {
  const { selection, forwarded } = options(process.argv.slice(2));
  if (forwarded.length) throw new Error("Unsupported browser arguments");
  // An inventory query only: never starts browsers, providers or fixture servers.
  console.log(JSON.stringify(select(browserCatalog(), selection), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
