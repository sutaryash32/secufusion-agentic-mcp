import { PHASES } from "./gates.js";
import { displayRef } from "./work_item_ref.js";
/**
 * The /sfn-spec deliverable. Assembled deterministically from recorded state (requirement,
 * confirmed decisions, validated plan, gate ledger). Nothing here is invented: an absent
 * section says so instead of being filled in.
 */
const list = (items, empty = "None recorded.") => items && items.length ? items.map((i) => `- ${i}`).join("\n") : empty;
export function renderSpecDocument(id, req, plan, ledger, exploration) {
    const ref = displayRef(id);
    const gates = PHASES.map((p) => {
        const g = ledger.phases[p];
        return `| ${p} | ${g ? g.status : "not done"} | ${g ? g.source : "-"} | ${g ? g.summary.replace(/\|/g, "/") : "-"} |`;
    }).join("\n");
    const impact = [
        ["Services", plan.affected_services],
        ["API changes", plan.api_changes],
        ["Database changes", plan.database_changes],
        ["Event changes", plan.event_changes],
        ["Frontend changes", plan.frontend_changes],
        ["Extension changes", plan.extension_changes],
    ].filter(([, v]) => v.length > 0)
        .map(([k, v]) => `**${k}**\n${list(v)}`).join("\n\n") || "No cross-service impact recorded.";
    const ui = exploration?.ui_reference
        ? `UI reference \`${exploration.ui_reference.design_id}\` r${exploration.ui_reference.revision}: **${exploration.ui_reference.review_status}** · implementation: ${exploration.ui_reference.implementation_status}. ` +
            `Affected components: ${(exploration.ui_reference.affected_components || []).join(", ") || "n/a"}. It is design intent, not a pixel spec.`
        : exploration?.ui_impact?.status === "NONE" ? "No UI impact (assessed)." : "UI impact not applicable / not recorded.";
    const userDecisions = exploration?.user_decisions?.length
        ? exploration.user_decisions.map((d) => `- **${d.id}** ${d.question} → **${d.answer}**`).join("\n")
        : "None recorded.";
    return `# Implementation Specification — ${ref}: ${req.title ?? "Untitled"}

> Generated from recorded state. Requirement **${req.status}**, plan **${plan.status}**. Implement exactly this; anything outside it needs a spec change first.

## Gates
| Gate | Status | Judged by | Summary |
|---|---|---|---|
${gates}

## 1. Requirement
${req.raw_request ?? "Not recorded."}

## 2. Current state (investigation findings)
${list(req.facts)}

## 3. Root cause
${req.root_cause ?? "Not recorded (acceptable for a new feature; for a bug this is a gap)."}

## 4. Scope
${req.scope ?? "Not recorded."}

**Constraints / out of scope**
${list(req.constraints)}

## 5. Impact and dependencies
${impact}

**Security implications**
${list(plan.security_implications)}

## 6. Decisions
${userDecisions}

${ui}

## 7. Implementation strategy
${plan.summary || "No summary recorded."}

${(plan.implementation_steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n") || "No steps recorded."}

## 8. Expected file changes
${list(plan.affected_files, "Not recorded.")}

## 9. Acceptance criteria
${(req.acceptance_criteria || []).map((a) => `- [ ] ${a}`).join("\n") || "None recorded."}

## 10. Tests and validation
**Test obligations**
${list(plan.test_obligations)}

**Validation requirements**
${list(plan.validation_requirements)}

## 11. Risks
${list(plan.risks)}

## 12. Assumptions, inferences and unknowns
**Assumptions**
${list([...(req.assumptions || []), ...(plan.assumptions || [])])}

**Inferences** (not verified facts)
${list(req.inferences)}

**Unknowns**
${list([...(req.unknowns || []), ...(plan.unknowns || [])])}

**Conflicts**
${list(req.conflicts)}
`;
}
