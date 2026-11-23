/// <reference lib="es2023.intl" />
import type { SpendQuote } from "../contracts/generated.ts";
import type { Locale } from "../i18n/types.ts";

export function money(value: string, currency: string, locale: Locale): string {
  // Intl accepts decimal strings without first rounding them to JavaScript numbers.
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency,
    currencyDisplay: locale === "zh-CN" ? "name" : "code", maximumFractionDigits: 24,
  }).formatToParts(value as `${number}`);
  return parts.map(part => locale === "zh-CN" && part.type === "currency" ? " " + part.value : part.value).join("");
}

/** A workflow flattens all quoted provider calls; one piece of music may use two. */
export function generationOutput(quote: SpendQuote) {
  const operation = quote.lines.at(-1)?.operation;
  if (quote.candidates != null && (quote.lines.length !== quote.candidates ||
      !quote.lines.every(line => line.operation === operation))) return "tasks";
  switch (operation) {
    case "image": case "video": case "music": case "speech": return operation;
    default: return "tasks";
  }
}

/** Only a single fixed-price call per output can be summarized as a unit price. */
export function uniformOutputPrice(quote: SpendQuote) {
  const first = quote.lines[0];
  if (!first?.price || first.amount == null || quote.lines.length !== (quote.candidates ?? 1)) return;
  const { currency } = first.price;
  if (quote.lines.every(line => line.quantityBasis !== "maximum" && line.operation === first.operation &&
      line.modelId === first.modelId && line.price?.currency === currency && line.amount === first.amount)) {
    return {amount: first.amount, currency, model: first.modelId};
  }
}
