import { browserCatalog, unitCatalog } from "./test-marks.ts";

try {
  const units = unitCatalog();
  const browser = browserCatalog();
  console.log(`Test marks OK: unit=${units.length}, browser=${browser.length}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
