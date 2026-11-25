import type { Translate } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";

const messages: Readonly<Record<string, MessageKey>> = {
  reusable: "generationImpact.reusable",
  stale: "generationImpact.stale",
  pending_upstream: "generationImpact.pending_upstream",
  unavailable: "generationImpact.unavailable",
  unknown: "generationImpact.unknown",
  no_result: "generationImpact.no_result",
  equal: "generationImpact.equal",
  changed: "generationImpact.changed",
  unresolved: "generationImpact.unresolved",
  no_baseline: "generationImpact.no_baseline",
  root: "generationImpact.root",
  downstream: "generationImpact.downstream",
  independent: "generationImpact.independent",
  inputs_changed: "generationImpact.inputs_changed",
  upstream_pending: "generationImpact.upstream_pending",
  output_unavailable: "generationImpact.output_unavailable",
  baseline_missing: "generationImpact.baseline_missing",
  input_unresolved: "generationImpact.input_unresolved",
  model_unresolved: "generationImpact.model_unresolved",
  dependency_unresolved: "generationImpact.dependency_unresolved",
  execution_basis_incomplete: "generationImpact.execution_basis_incomplete",
  dependency_cycle: "generationImpact.dependency_cycle",
  impact_scope_exceeded: "generationImpact.impact_scope_exceeded",
  clip: "generationImpact.clip",
  text_overlay: "generationImpact.text_overlay",
};

/** Localize stable codes without rendering unknown provider or user content. */
export function generationImpactText(code: string, t: Translate): string {
  return t(Object.hasOwn(messages, code) ? messages[code]! : "generationImpact.fallback");
}
