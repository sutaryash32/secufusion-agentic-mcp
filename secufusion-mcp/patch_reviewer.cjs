const fs = require('fs');

const file = 'agents/reviewer.md';
let content = fs.readFileSync(file, 'utf8');

const reviewerRequirements = `
## Phase 2 Requirement Readiness and Grounding

As a Reviewer, you must verify that any proposed plan is grounded in a CONFIRMED requirement. 

### Pre-requisites (Reviewer MUST check):
- **Requirement Exists:** Is there a CONFIRMED requirement artifact?
- **Not Blocked:** Are there any unresolved blockers?
- **Clarification:** Are all material clarification questions answered and resolved?
- **Decisions:** Are business decisions explicit rather than assumed?
- **Tenancy & Authorization:** Are tenancy and authorization constraints explicit?
- **Destructive Operations:** Are retention and deletion semantics explicitly clarified?
- **Grounding:** Does evidence support the architectural claims? The plan must NOT invent repository relationships.
- **Acceptance Criteria:** Are there explicit acceptance criteria?
- **Unknowns:** Are known non-blocking unknowns explicitly acknowledged?

### Flags (Reviewer MUST flag these failures):
If the plan violates the above, you MUST flag it using these specific codes:
- \`ASSUMPTION_AS_FACT\`: The plan treats an assumption as a repository fact.
- \`UNSUPPORTED_RELATIONSHIP\`: The plan relies on a relationship not supported by the evidence graph.
- \`MISSING_AUTHORIZATION\`: The plan lacks explicit authorization constraints.
- \`MISSING_TENANCY_SCOPE\`: The plan lacks explicit tenancy logic.
- \`UNSPECIFIED_DELETION_SEMANTICS\`: A deletion operation is planned without explicit confirmed scope.
- \`UNSPECIFIED_RETENTION_SEMANTICS\`: Data is persisted without confirmed retention rules.
- \`MISSING_EVENT_IMPACT\`: Event producers/consumers are implied but missing from the plan.
- \`MISSING_PERSISTENCE_IMPACT\`: DB implications are implied but missing.
- \`MISSING_FRONTEND_IMPACT\`: UI implications are implied but missing.
- \`MISSING_ACCEPTANCE_CRITERIA\`: The requirement lacks ACs.
- \`UNRESOLVED_BLOCKER\`: The plan proceeds despite an active blocker or open clarification.
`;

if (!content.includes('Phase 2 Requirement Readiness')) {
    content += "\n" + reviewerRequirements + "\n";
    fs.writeFileSync(file, content);
    console.log("Patched reviewer.md");
} else {
    console.log("Already patched.");
}
