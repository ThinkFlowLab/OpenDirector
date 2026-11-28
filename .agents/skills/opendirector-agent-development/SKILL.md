---
name: opendirector-agent-development
description: Route OpenDirector Agent development and review to bundled skills. Use for runtime architecture, tool and model contracts, trace diagnosis, trust boundaries, workflow orchestration, and behavior evals.
---

# OpenDirector Agent development and review

## Load the matching skills

Read [AGENTS.md](../../../AGENTS.md) and the relevant [development lessons](../../../docs/development/lessons.md). Before changing or reviewing the Agent, read the named sections in each matching reference. Apply them within OpenDirector's architecture and contracts. Follow supplementary links only when the task needs more detail, and treat upstream setup and self-update instructions as background. See the [source revisions and licenses](references/upstream-sources.md).

Read the upstream files at the revisions pinned by OpenDirector. If a matching checkout is missing, initialize its submodule from the repository root with `git submodule update --init --` followed by its path under `.agents/upstream/`.

- **Layer ownership or workflow architecture** → [langchain-build-agent](../../upstream/langchain-skills/skills/langchain-build-agent/SKILL.md#implement-at-the-right-layer). Read **Implement at the right layer** and **Verify the requested behavior**.
- **Tool inputs, receipts, or failure recovery** → [agent-harness-construction](../../upstream/ecc/skills/agent-harness-construction/SKILL.md#action-space-design). Read **Action Space Design**, **Observation Design**, and **Error Recovery Contract**.
- **Provider and tool capability differences** → [agents-best-practices](../../upstream/agents-best-practices/SKILL.md#core-stance). Read **Core stance** and **Non-negotiable principles**, plus **Environment-Adaptive Tool Mode** when capabilities vary at runtime.
- **Cross-layer regressions or bypassed checks** → [agent-architecture-audit](../../upstream/ecc/skills/agent-architecture-audit/SKILL.md#audit-workflow). Use the failure mapping and fix strategy to trace the earliest failing layer and the code that owns the rule.
- **One run stalls, loops, or loses state** → [agent-introspection-debugging](../../upstream/ecc/skills/agent-introspection-debugging/SKILL.md#four-phase-loop). Identify the last successful operation, isolate the failure, and probe before retrying. Read the [OpenDirector runtime and job lineage](../../../docs/architecture/agent-runtime.md) to locate authoritative receipts.
- **Shared tool schema, event, or receipt changes** → [contract-first](../../upstream/ecc/skills/contract-first/SKILL.md#the-boundary-artifact). Use **The Boundary Artifact** and **Verify the Provider** with OpenDirector's existing contracts and generated types. Check actual serialized success and error responses.
- **Changes to Agent behavior or reliability** → [eval-harness](../../upstream/ecc/skills/eval-harness/SKILL.md#eval-types). Use **Eval Types** and the grader and repeat-run guidance in **Product Evals**. Grade observable effects through OpenDirector's test entry points and apply the project’s acceptance criteria.
- **Tool scope, workspace isolation, or sensitive trace output** → [agent-security-hardening](../../upstream/ecc/skills/agent-security-hardening/SKILL.md#hardening-workflow). Use **Map Trust Boundaries** and **Bound and Sanitize Tool Output** when reviewing the affected boundary.
- **Formal pull request review** → [opendirector-review](../opendirector-review/SKILL.md) for the review procedure. Apply the matching development references and the constraints below to the Agent change.

## OpenDirector constraints

1. **Adapt by capability.** Resolve inputs from the current project state and declared model and tool capabilities. Case-specific patches are prohibited. Keep fixture IDs, asset names, and fixed workflow topologies in examples and tests. Fix recurring failures at the layer that owns the rule. Changing a copied builder or disabling validation to pass one run is a review blocker.
2. **Use the shared business contract.** Route equivalent Agent, CLI, and UI operations through the same application service and rules. Apply mandatory checks at admission through every supported entry point, including batch and direct submission. Skill text, examples, adapters, and prompts cannot waive them.
3. **Return actionable failures.** A rejection identifies the operation, affected object or step, and the unmet condition. Indicate the input to correct when recovery is possible. If submission status is uncertain, reconcile the operation ID with the receipt and job state. Replay only with the original ID and input where the contract allows it. Stop if a required input or capability is unavailable.
4. **Verify different scenarios.** Replay the reported failure when available. Run two materially different valid scenarios and an invalid or unsupported scenario through the real Agent and affected entry points. Check tool inputs, receipts, persisted state, and the absence of a new job when admission rejects a request. Follow the [validation guide](../../../docs/development/validation.md) and state where dependencies were mocked.

In review, trace each finding from the entry point to the rule owner, receipt, and affected project state. Block case-specific production paths, validation bypasses, and changes without the required cross-scenario evidence.
