const fs = require('fs');
const path = require('path');

const plannerPath = path.join(__dirname, 'agents', 'planner.md');
let plannerContent = fs.readFileSync(plannerPath, 'utf8');

if (!plannerContent.includes('Phase 0.77 — Continuous Engineering Intelligence & Regression Prevention (Phase 7)')) {
    const p7Block = `
## Phase 0.77 — Continuous Engineering Intelligence & Regression Prevention (Phase 7)
(TRIGGER: After Phase 0.75 and before creating the Implementation Plan)

1. **Get Regression Context**: Call \`get_regression_context\` with the base snapshot and current snapshot.
2. **Review Context**: Evaluate the returned regression context. Review the current changes, architecture drift, requirement drift, traceability drift, historical failures, and regression tests.
3. **Analyze Risk**: Review the provided \`risk_indicators\` (e.g. \`CROSS_SERVICE_CHANGE\`, \`HISTORICAL_FAILURE_MATCH\`). Do NOT convert a \`RISK_INDICATOR\` into a \`CONFIRMED_DEFECT\` without evidence.
4. **Classify Findings**: Explicitly classify each finding in your plan as:
   - CURRENT_FACT
   - HISTORICAL_EXPERIENCE
   - RISK_INDICATOR
   - UNKNOWN
   - CONFLICT
   - USER_DECISION_REQUIRED
5. **Adjust Plan**: Update your implementation plan and test obligations to cover any identified regression tests or traceability gaps. Ensure cross-service or security boundaries are tested.
`;
    plannerContent = plannerContent.replace(
        '## Phase 0.8 — Implementation Planning & Validation (Phase 4)',
        p7Block + '\n## Phase 0.8 — Implementation Planning & Validation (Phase 4)'
    );
    
    fs.writeFileSync(plannerPath, plannerContent, 'utf8');
    console.log("Patched planner.md for Phase 7");
}

const reviewerPath = path.join(__dirname, 'agents', 'reviewer.md');
if (fs.existsSync(reviewerPath)) {
    let reviewerContent = fs.readFileSync(reviewerPath, 'utf8');
    if (!reviewerContent.includes('Phase 7 Regression & Drift Verification')) {
        const r7Block = `
### Phase 7 Regression & Drift Verification
When reviewing an implementation plan or code changes, verify:
- Current repository snapshot was considered.
- Architecture drift and requirement drift were evaluated.
- Traceability drift and regression tests were considered.
- Cross-service impacts and security-sensitive changes were evaluated.
- Risk indicators have evidence and are NOT presented as confirmed defects.
- No historical lesson became an implicit requirement.

Flag the following if found:
- \`HISTORICAL_RISK_NOT_REVIEWED\`
- \`REGRESSION_TEST_GAP\`
- \`TRACEABILITY_DRIFT\`
- \`ARCHITECTURE_DRIFT\`
- \`REQUIREMENT_DRIFT\`
- \`UNSUPPORTED_RISK_CLAIM\`
- \`CROSS_SERVICE_IMPACT_NOT_VALIDATED\`
- \`SECURITY_REGRESSION_GAP\`
- \`DESTRUCTIVE_OPERATION_GAP\`
`;
        reviewerContent = reviewerContent + '\n' + r7Block;
        fs.writeFileSync(reviewerPath, reviewerContent, 'utf8');
        console.log("Patched reviewer.md for Phase 7");
    }
}
