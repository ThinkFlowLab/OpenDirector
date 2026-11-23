import assert from "node:assert/strict";
import test from "node:test";
import { chatTurnTiming, formatTurnDuration, turnTiming, turnTimingLabel, type TurnStatus } from "../src/canvas/turnTiming.ts";
import { traceRuntime, type ConversationTurn } from "../src/canvas/traceTurns.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";
import { translateNow } from "../src/canvas/assistantTranslate.ts";

test("durations use ms below a second, seconds below a minute, then minutes and hours", () => {
  assert.equal(formatTurnDuration(0), "0 ms");
  assert.equal(formatTurnDuration(820), "820 ms");
  assert.equal(formatTurnDuration(999), "999 ms");
  assert.equal(formatTurnDuration(1000), "1.0 s");
  assert.equal(formatTurnDuration(12400), "12.4 s");
  assert.equal(formatTurnDuration(59949), "59.9 s");
  assert.equal(formatTurnDuration(59999), "1m 0s");
  assert.equal(formatTurnDuration(60000), "1m 0s");
  assert.equal(formatTurnDuration(125000), "2m 5s");
  assert.equal(formatTurnDuration(3_599_000), "59m 59s");
  assert.equal(formatTurnDuration(3_725_000), "1h 2m");
});

test("zero is a real duration, unknown and invalid values are not", () => {
  assert.equal(formatTurnDuration(0), "0 ms");
  for (const value of [null, undefined, Number.NaN, -1, Infinity, "12" as unknown as number])
    assert.equal(formatTurnDuration(value), null);
});

test("fractional milliseconds round instead of showing 1000 ms", () => {
  assert.equal(formatTurnDuration(999.6), "1.0 s");
});

test("Chat and Trace render the same duration for every runtime", () => {
  const t = (key: string) => key;
  for (const runtime of ["default", "codex", "claude", "deepseek", "jiuwenswarm"]) {
    const turn: ConversationTurn = { id: "a", number: 1, text: "", runtime, model: null, status: "complete", durationMs: 12400 };
    assert.equal(traceRuntime(runtime).length > 0, true);
    assert.equal(turnTiming(turn, t as never).duration, "12.4 s");
    assert.equal(turnTimingLabel({ status: turn.status, durationMs: turn.durationMs }, t as never), "trace.turn.status.complete · 12.4 s");
  }
});

test("running turns and turns without a recorded duration show no duration", () => {
  const t = (key: string) => key;
  assert.equal(turnTimingLabel({ status: "streaming", durationMs: 5 }, t as never), null);
  for (const status of ["complete", "stopped", "interrupted"] as TurnStatus[]) {
    assert.equal(turnTimingLabel({ status }, t as never), null);
    assert.equal(turnTimingLabel({ status, durationMs: null }, t as never), null);
    assert.equal(turnTiming({ status, durationMs: null }, t as never).duration, null);
  }
});

test("status wording is localized from the shared keys", () => {
  for (const [locale, word] of [["en-US", "Completed"], ["zh-CN", "已完成"]] as const) {
    setActiveLocale(locale);
    assert.equal(turnTimingLabel({ status: "complete", durationMs: 12400 }, translateNow), `${word} · 12.4 s`);
  }
});

setActiveLocale("en-US");

test("chat line does not repeat the stopped or interrupted word the panel already shows", () => {
  const t = ((key: string) => key) as never;
  assert.equal(chatTurnTiming({ status: "complete", durationMs: 12400 }, t), "trace.turn.status.complete · 12.4 s");
  assert.equal(chatTurnTiming({ status: "stopped", durationMs: 3100 }, t), "3.1 s");
  assert.equal(chatTurnTiming({ status: "interrupted", durationMs: 820 }, t), "820 ms");
  assert.equal(chatTurnTiming({ status: "stopped" }, t), null);
  assert.equal(chatTurnTiming({ status: "streaming", durationMs: 5 }, t), null);
});
