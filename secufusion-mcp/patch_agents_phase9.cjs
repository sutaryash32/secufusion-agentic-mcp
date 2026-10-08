const fs = require('fs');
const path = require('path');

const plannerPath = path.join(__dirname, 'agents', 'planner.md');
let plannerContent = fs.readFileSync(plannerPath, 'utf8');

if (!plannerContent.includes('Phase 9 — Workspace & Evidence Completeness')) {
    const p9Block = `
## Phase 9 — Workspace & Evidence Completeness
(TRIGGER: During repository investigation or implementation planning)

1. **Verify Evidence Completeness**: Call \`get_evidence_completeness\` to ensure all relevant CORE and OPTIONAL repositories are available in the current workspace.
2. **Missing Evidence Rule**: If a relevant repository is missing (e.g. \`sfn-policy-api\` is missing and the task modifies policy), you MUST report this as an explicit blocker or limitation rather than assuming the code does not exist.
3. **Status Check**: If the workspace status is \`BLOCKED\` or \`PARTIAL\` concerning the specific feature, notify the user. Never claim unsupported evidence as a negative fact.
`;
    plannerContent = plannerContent + '\n' + p9Block;
    fs.writeFileSync(plannerPath, plannerContent, 'utf8');
    console.log("Patched planner.md for Phase 9");
}

const reviewerPath = path.join(__dirname, 'agents', 'reviewer.md');
if (fs.existsSync(reviewerPath)) {
    let reviewerContent = fs.readFileSync(reviewerPath, 'utf8');
    if (!reviewerContent.includes('Phase 9 Workspace & Evidence Verification')) {
        const r9Block = `
### Phase 9 Workspace & Evidence Verification
When reviewing an implementation plan or code changes, verify:
- The implementation does not assume facts based on missing repositories.
- \`get_evidence_completeness\` was considered if cross-service impacts are suspected.

Flag the following if found:
- \`EVIDENCE_TREATED_AS_FACT_WHEN_MISSING\`
- \`WORKSPACE_PARTIAL_RESTRICTION_IGNORED\`
`;
        reviewerContent = reviewerContent + '\n' + r9Block;
        fs.writeFileSync(reviewerPath, reviewerContent, 'utf8');
        console.log("Patched reviewer.md for Phase 9");
    }
}
