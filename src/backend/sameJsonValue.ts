/** Value comparison used where a document must be tested for "no change".
 * A canvas document carries its media inline, so `JSON.stringify(a) ===
 * JSON.stringify(b)` allocated two multi-megabyte strings on every save. This
 * walks both values instead and stops at the first difference, which keeps the
 * exact meaning of that comparison: key order counts, members whose value is
 * undefined/function/symbol are omitted from objects and read as null inside
 * arrays, and a non-finite number reads as null. */

const omitted = (value: unknown): boolean =>
  value === undefined ||
  typeof value === "function" ||
  typeof value === "symbol";

/** The text JSON.stringify writes for one non-omitted primitive, tagged with
 * its type: a string must never read the same as the number, boolean or null
 * it happens to spell. Non-finite numbers keep reading as null, as they do
 * once serialized. */
function text(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number")
    return Number.isFinite(value) ? `number:${value}` : "null";
  if (typeof value === "boolean") return `boolean:${value}`;
  return `string:${value}`;
}
const hasToJSON = (value: object): boolean =>
  typeof (value as { toJSON?: unknown }).toJSON === "function";

/** Keys that contribute to the serialized object, in serialization order. */
function serializedKeys(record: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(record))
    if (!omitted(record[key])) keys.push(key);
  return keys;
}

export function sameJsonValue(a: unknown, b: unknown): boolean {
  return same(a, b, []);
}

function same(a: unknown, b: unknown, ancestors: object[]): boolean {
  if (a === b) return true;
  // Only stringify can express what these emit (and it throws, as before).
  if (typeof a === "bigint" || typeof b === "bigint")
    return JSON.stringify(a) === JSON.stringify(b);
  const aIsObject = typeof a === "object" && a !== null;
  const bIsObject = typeof b === "object" && b !== null;
  if (aIsObject !== bIsObject) return false;
  if (!aIsObject) {
    // Two members that stringify omits compare equal; one omitted does not
    // equal a member that is written.
    if (omitted(a) || omitted(b)) return omitted(a) && omitted(b);
    return text(a) === text(b);
  }
  const left = a as object;
  const right = b as object;
  const aIsArray = Array.isArray(left);
  if (aIsArray !== Array.isArray(right)) return false;
  // A toJSON hook or a cycle changes the text, so let stringify decide.
  if (hasToJSON(left) || hasToJSON(right))
    return JSON.stringify(left) === JSON.stringify(right);
  if (ancestors.includes(left) || ancestors.includes(right))
    return JSON.stringify(left) === JSON.stringify(right);
  ancestors.push(left, right);
  const equal = aIsArray
    ? sameArray(left as unknown[], right as unknown[], ancestors)
    : sameRecord(
        left as Record<string, unknown>,
        right as Record<string, unknown>,
        ancestors,
      );
  ancestors.pop();
  ancestors.pop();
  return equal;
}

function sameArray(a: unknown[], b: unknown[], ancestors: object[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    // A hole and an omitted member both serialize as null.
    const left = omitted(a[index]) ? null : a[index];
    const right = omitted(b[index]) ? null : b[index];
    if (!same(left, right, ancestors)) return false;
  }
  return true;
}

function sameRecord(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  ancestors: object[],
): boolean {
  const aKeys = serializedKeys(a);
  const bKeys = serializedKeys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (let index = 0; index < aKeys.length; index++) {
    const key = aKeys[index]!;
    // Key order is part of the serialized text.
    if (key !== bKeys[index]) return false;
    if (!same(a[key], b[key], ancestors)) return false;
  }
  return true;
}
