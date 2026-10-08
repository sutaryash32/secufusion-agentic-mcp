const fs = require('fs');

function patchPlanner() {
    const file = 'agents/planner.md';
    let content = fs.readFileSync(file, 'utf8');

    const p5Steps = `
## Phase 0.9 — Test Intelligence & Feedback (Phase 5)
(TRIGGER: After implementation and testing are complete)

1. **Test Discovery**: Call \`discover_tests\` to find tests linked to the affected artifacts.
2. **Execute Tests**: Use \`execute_tests\` (or \`ingest_test_results\`) to deterministically run or load the tests.
3. **Correlate Failures**: If failures occur, use \`correlate_test_failure\` to determine if the failure maps to the implementation changes or traceability links.
4. **Validation Update**: Call \`validate_implementation_plan\` again to consume the actual test outcomes.
5. **Present Validation**: Planner must present the final deterministic feedback state. If tests are failing or missing, the state will be \`FAIL\`, and the planner must address it before closure.
`;

    if (!content.includes('Test Intelligence & Feedback (Phase 5)')) {
        content = content + "\n" + p5Steps;
        fs.writeFileSync(file, content);
        console.log("Patched planner.md for Phase 5");
    }
}

function patchReviewer() {
    const file = 'agents/reviewer.md';
    let content = fs.readFileSync(file, 'utf8');

    const p5Flags = `
### Actual Execution Validation (Phase 5)
Reviewers must validate the ACTUAL execution state, not just the plan.
- Check that \`validate_implementation_plan\` produced a \`PASS\`.
- \`MISSING_TEST_EXECUTION\`: Required tests were identified but not executed.
- \`FAILED_EXECUTION_EVIDENCE\`: Test results show \`FAIL\` for a requirement constraint.
- Reviewer is blocked from closing tasks if execution evidence prevents a \`PASS\`.
`;

    if (!content.includes('Actual Execution Validation (Phase 5)')) {
        content = content + "\n" + p5Flags;
        fs.writeFileSync(file, content);
        console.log("Patched reviewer.md for Phase 5");
    }
}

patchPlanner();
patchReviewer();
