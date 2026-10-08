const fs = require('fs');

function patchPlanner() {
    const file = 'agents/planner.md';
    let content = fs.readFileSync(file, 'utf8');

    const p4Steps = `
## Phase 0.8 — Implementation Planning & Validation (Phase 4)
(TRIGGER: After traceability links are generated)

1. **Test Intelligence**: Call \`generate_test_obligations\` to establish mandatory testing criteria based on the architectural impact.
2. **Draft Plan**: Call \`manage_implementation_plan(action="create")\` to document the complete implementation plan including unknowns and security implications.
3. **Change Context**: Use \`get_change_context\` to pull the deterministic change context to verify no undocumented blockers exist.
4. **Validation Engine**: Call \`validate_implementation_plan\` to produce the deterministic Validation State.
5. **Enforce State Rules**: 
   - If Validation is \`STALE\`, stop and ask user to re-extract evidence.
   - If Validation is \`BLOCKED\` (e.g. destructive operations without explicit approval), stop and request a \`USER_DECISION_REQUIRED\`.
   - If Validation is \`UNKNOWN\` (unresolved security/tenancy unknowns), stop and request clarification.
   - Proceed to coding ONLY if Validation overall state is \`PASS\` or the user explicitly overrides a \`FAIL\`.
`;

    if (!content.includes('Phase 0.8 — Implementation Planning')) {
        content = content + "\n" + p4Steps;
        fs.writeFileSync(file, content);
        console.log("Patched planner.md for Phase 4");
    }
}

function patchReviewer() {
    const file = 'agents/reviewer.md';
    let content = fs.readFileSync(file, 'utf8');

    const p4Flags = `
### Execution Loop Validation (Phase 4)
Reviewers must validate the final state before closing a task.
- \`STALE_PLAN\`: The implementation plan evidence became stale during coding.
- \`MISSING_TEST_EVIDENCE\`: The code does not fulfill the \`test_obligations\` identified in the implementation plan.
- \`DESTRUCTIVE_VIOLATION\`: Code performs a literal or semantic destruction without explicit \`CONFIRMED\` requirement approval.

### Engineering Experience (Phase 4)
After successful review, the Reviewer MUST evaluate if a durable engineering lesson was learned.
- Call \`record_engineering_experience\` to save explicit decisions, anti-patterns, or architectural constraints discovered during the task.
- NEVER record specific file locations or variable names as durable experience; only record architectural or semantic lessons.
`;

    if (!content.includes('Execution Loop Validation (Phase 4)')) {
        content = content + "\n" + p4Flags;
        fs.writeFileSync(file, content);
        console.log("Patched reviewer.md for Phase 4");
    }
}

patchPlanner();
patchReviewer();
