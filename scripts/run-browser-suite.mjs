#!/usr/bin/env node
/**
 * Runs the isolated browser workflows in order and reports every result.
 *
 * One failing workflow must not hide the ones after it (issue #160), so each
 * script runs to completion and the job fails only after the summary. The
 * caller starts the isolated API and Vite first; see
 * docs/development/validation.md.
 *
 * Usage:
 *   node scripts/run-browser-suite.mjs
 */
import { spawnSync } from "node:child_process";

const workflows = [
  { name: "locale", script: "tests/browser/locale.mjs" },
  { name: "creation closure", script: "scripts/verify_creation_browser.mjs" },
  { name: "assistant activity", script: "tests/browser/assistant_activity.mjs" },
  {
    name: "generation reference",
    script: "tests/browser/canvas_generation_reference.mjs",
  },
  { name: "minimax h3", script: "tests/browser/minimax_h3.mjs" },
  { name: "provider settings", script: "tests/browser/provider_settings.mjs" },
  { name: "created node focus", script: "tests/browser/created_node_focus.mjs" },
  { name: "cross canvas paste", script: "tests/browser/cross_canvas_paste.mjs" },
  { name: "reference reconnect", script: "tests/browser/reference_reconnect.mjs" },
  {
    name: "context menu dismissal",
    script: "tests/browser/context_menu_dismissal.mjs",
  },
  {
    name: "project list overflow",
    script: "tests/browser/project_list_overflow.mjs",
  },
  { name: "mp4 export", script: "tests/browser/mp4_export.mjs" },
  { name: "editor save", script: "tests/browser/editor_save.mjs" },
  { name: "canvas crop", script: "tests/browser/canvas_crop.mjs" },
  {
    name: "canvas layers",
    script: "tests/browser/canvas_layers.mjs",
    args: ["--generated"],
  },
  {
    name: "canvas switch",
    script: "tests/browser/canvas_switch.mjs",
  },
  {
    name: "structured editors",
    script: "tests/browser/structured_editors.mjs",
    args: ["--publish"],
  },
  {
    name: "local output delivery",
    script: "tests/browser/local_output_delivery.mjs",
  },
  {
    name: "timeline workflow",
    script: "tests/browser/timeline_workflow.mjs",
    args: ["--full-creation"],
    env: { PYTHON: "python" },
  },
];

const failures = [];
const started = Date.now();
for (const workflow of workflows) {
  console.log(`\n=== ${workflow.name}: ${workflow.script} ===`);
  const begin = Date.now();
  const result = spawnSync(
    process.execPath,
    [workflow.script, ...(workflow.args ?? [])],
    {
      stdio: "inherit",
      env: { ...process.env, ...(workflow.env ?? {}) },
    },
  );
  const seconds = ((Date.now() - begin) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`PASS ${workflow.name} (${seconds}s)`);
  } else {
    const exit = result.signal ?? `exit ${result.status}`;
    failures.push(`${workflow.name} (${exit})`);
    console.error(`FAIL ${workflow.name} (${exit}, ${seconds}s)`);
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n${workflows.length - failures.length}/${workflows.length} browser workflows passed in ${total}s`,
);
if (failures.length > 0) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
