import assert from "node:assert/strict";
import test from "node:test";
import { sameJsonValue } from "../src/backend/sameJsonValue.ts";

/** What the previous implementation compared: the serialized text. */
function serialized(value: unknown): string {
  try {
    return `text:${String(JSON.stringify(value))}`;
  } catch (error) {
    return `threw:${(error as Error).name}`;
  }
}

/** Deterministic PRNG so a failure is reproducible from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const scalars = [
  null,
  0,
  -0,
  1,
  -1,
  1.5,
  1e21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  "",
  "a",
  "图片",
  'quote" and \\ backslash',
  "\n\t\u0000",
  "\ud800",
  // Strings that spell another type: a comparator that reads "1" as 1, or
  // "null" as null, silently treats a real change as no change.
  "1",
  "0",
  "-0",
  "1.5",
  "1e+21",
  "true",
  "false",
  "null",
  "undefined",
  undefined,
];

/** Random JSON-ish value; `hole` inserts a sparse array slot. */
function value(next: () => number, depth: number): unknown {
  const roll = next();
  if (depth <= 0 || roll < 0.55)
    return scalars[Math.floor(next() * scalars.length)];
  if (roll < 0.8) {
    const length = Math.floor(next() * 4);
    const items: unknown[] = [];
    for (let index = 0; index < length; index++)
      items.push(next() < 0.1 ? undefined : value(next, depth - 1));
    return items;
  }
  const record: Record<string, unknown> = {};
  const count = Math.floor(next() * 4);
  for (let index = 0; index < count; index++)
    record[`key${Math.floor(next() * 5)}`] = value(next, depth - 1);
  return record;
}

/** A copy that differs in at most one property, order or omitted member. */
function variant(next: () => number, input: unknown): unknown {
  if (input === null || typeof input !== "object") {
    return next() < 0.5 ? input : scalars[Math.floor(next() * scalars.length)];
  }
  if (Array.isArray(input)) {
    const copy = input.slice();
    if (next() < 0.3) copy.push(value(next, 0));
    if (next() < 0.3 && copy.length) copy[0] = value(next, 0);
    if (next() < 0.2) copy.length = Math.max(0, copy.length - 1);
    return copy;
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (next() < 0.25 && entries.length > 1) {
    const reordered = entries.slice().reverse();
    return Object.fromEntries(reordered);
  }
  if (next() < 0.25) {
    return Object.fromEntries(entries.filter((_, index) => index > 0));
  }
  const mutated = Object.fromEntries(entries);
  if (entries.length && next() < 0.5) {
    const key = entries[Math.floor(next() * entries.length)]![0];
    mutated[key] = value(next, 0);
  }
  return mutated;
}

test("matches JSON.stringify on randomized structures", () => {
  const next = random(20261107);
  let equal = 0;
  for (let round = 0; round < 4000; round++) {
    const subject = value(next, 2);
    const other = next() < 0.5 ? variant(next, subject) : value(next, 2);
    assert.equal(
      sameJsonValue(subject, other),
      serialized(subject) === serialized(other),
      `round ${round}: ${JSON.stringify(subject)} vs ${JSON.stringify(other)}`,
    );
    if (serialized(subject) === serialized(other)) equal++;
  }
  // Not vacuous: the sample must contain both outcomes.
  assert.ok(equal > 200, `only ${equal} equal pairs`);
});

test("key order and omitted members read exactly like JSON.stringify", () => {
  assert.equal(sameJsonValue({ a: 1, b: 2 }, { a: 1, b: 2 }), true);
  assert.equal(sameJsonValue({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
  assert.equal(sameJsonValue({ a: 1 }, { a: 1, b: undefined }), true);
  assert.equal(sameJsonValue({ a: 1 }, { a: 1, b: () => 0 }), true);
  assert.equal(sameJsonValue({ a: 1 }, { a: 1, b: null }), false);
  assert.equal(sameJsonValue([1, undefined], [1, null]), true);
  assert.equal(sameJsonValue([, 1], [null, 1]), true);
  assert.equal(sameJsonValue([undefined], {}), false);
  assert.equal(sameJsonValue(NaN, null), true);
  assert.equal(sameJsonValue(0, -0), true);
  assert.equal(sameJsonValue(undefined, "undefined"), false);
  assert.equal(sameJsonValue("undefined", "undefined"), true);
});

test("no value reads the same as another type that spells it", () => {
  // Node and layer data mix numbers, strings and nulls under the same keys, so
  // conflating them would drop a real edit instead of persisting it.
  assert.equal(sameJsonValue(1, "1"), false);
  assert.equal(sameJsonValue(0, "0"), false);
  assert.equal(sameJsonValue(1.5, "1.5"), false);
  assert.equal(sameJsonValue(true, "true"), false);
  assert.equal(sameJsonValue(false, "false"), false);
  assert.equal(sameJsonValue(null, "null"), false);
  assert.equal(sameJsonValue({ opacity: 100 }, { opacity: "100" }), false);
  assert.equal(sameJsonValue({ text: null }, { text: "null" }), false);
  assert.equal(sameJsonValue({ fontSize: 24 }, { fontSize: 24 }), true);
});

test("media-heavy documents compare without serializing them", () => {
  const src = `data:image/png;base64,${"A".repeat(200_000)}`;
  const node = (title: string) => ({
    id: "node-1",
    data: { title, src, media: { width: 1, height: 2 } },
  });
  assert.equal(sameJsonValue(node("图片"), node("图片")), true);
  assert.equal(sameJsonValue(node("图片"), node("图片 2")), false);
});

test("a toJSON hook or a cycle keeps the previous stringify behaviour", () => {
  const dated = { at: new Date(0) };
  assert.equal(sameJsonValue(dated, { at: new Date(0) }), true);
  assert.equal(sameJsonValue(dated, { at: new Date(1) }), false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const other: Record<string, unknown> = {};
  other.self = other;
  // Two distinct self-references cannot be compared without serializing.
  assert.throws(() => sameJsonValue(cycle, other), /circular|Converting/i);
});
