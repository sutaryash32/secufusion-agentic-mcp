const fs = require('fs');

function patchPlanner() {
    const file = 'agents/planner.md';
    let content = fs.readFileSync(file, 'utf8');

    const traceSteps = `
## Phase 0.7 — Traceability and Impact Analysis
(TRIGGER: after requirement is CONFIRMED and before implementation plan is generated)

1. **Load Requirement**: Read the confirmed specification.
2. **Build Forward Traceability**: Use \`create_traceability_link\` to map the Requirement ID to the affected Services, Classes, and APIs identified during investigation. Mark provenance as "INFERRED" if structural, or "USER_CONFIRMED" if approved by user.
3. **Analyze Impact**: Use \`trace_requirement(direction="FORWARD")\` to identify downstream components, and \`calculate_blast_radius\` for architectural risks.
4. **Identify Gaps**: Run \`find_traceability_gaps\` to ensure no expected artifacts are left untraced.
5. **Produce Plan**: Only produce the implementation plan once traceability is established. Ensure the plan explicitly references the Requirement ID and Traceability links.

### Traceability Rules:
❌ Do NOT fabricate traceability links (e.g. mapping to a DB table that does not exist).
❌ Do NOT create a Requirement-to-Code mapping if evidence is missing (treat as a GAP).
`;

    if (!content.includes('Phase 0.7 — Traceability')) {
        content = content + "\n" + traceSteps;
        fs.writeFileSync(file, content);
        console.log("Patched planner.md for Phase 3");
    }
}

function patchReviewer() {
    const file = 'agents/reviewer.md';
    let content = fs.readFileSync(file, 'utf8');

    const traceFlags = `
### Traceability Validation (Phase 3)
The Reviewer MUST ensure the Plan is fully traced.
Flag these if the plan violates traceability constraints:
- \`REQUIREMENT_NOT_TRACED\`: The plan does not link the implementation back to the confirmed Requirement ID.
- \`IMPLEMENTATION_NOT_TRACED\`: The plan introduces new code/APIs without a traceability link back to the requirement.
- \`UNSUPPORTED_IMPACT\`: The plan claims to affect a downstream system but trace analysis does not show a relationship.
- \`MISSING_API_IMPACT\`: The plan modifies an API without tracing its frontend or consumer impact.
- \`MISSING_EVENT_IMPACT\`: The plan adds an event producer without tracing it to a consumer.
- \`MISSING_DATABASE_IMPACT\`: The plan changes DB semantics without tracing repository flow.
- \`STALE_TRACEABILITY\`: The plan relies on a traceability link that is stale or no longer matches the current repository graph.
`;

    if (!content.includes('Traceability Validation (Phase 3)')) {
        content = content + "\n" + traceFlags;
        fs.writeFileSync(file, content);
        console.log("Patched reviewer.md for Phase 3");
    }
}

patchPlanner();
patchReviewer();
