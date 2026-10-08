const fs = require('fs');
const path = require('path');

const plannerPath = path.join(__dirname, 'agents', 'planner.md');
let plannerContent = fs.readFileSync(plannerPath, 'utf8');

if (!plannerContent.includes('Phase 0.75 — Validated Engineering Experience (Phase 6)')) {
    const experienceBlock = `
## Phase 0.75 — Validated Engineering Experience (Phase 6)
(TRIGGER: Before creating the Implementation Plan)

1. **Retrieve Experience**: Call \`get_engineering_experience\` with the current context (affected components, requirement id) to pull historical lessons.
2. **Review Experience**: Evaluate the returned experience records. Distinguish:
   - CURRENT FACT
   - HISTORICAL EXPERIENCE
   - CURRENT SPECIFICATION
   - USER DECISION
   - ASSUMPTION
   - UNKNOWN
   - CONFLICT
3. **Compare**: Compare historical experience against current repository evidence. Current evidence ALWAYS outranks historical experience.
4. **Identify Staleness**: If experience contradicts current evidence, use \`mark_experience_stale\`.
5. **Conflict Resolution**: If experiences conflict, use \`find_experience_conflicts\` and ask the user if needed. DO NOT silently resolve conflicts.
6. **Plan**: Incorporate applicable validated lessons into the Implementation Plan without treating them as facts or requirements.
`;
    plannerContent = plannerContent.replace(
        '## Phase 0.8 — Implementation Planning & Validation (Phase 4)',
        experienceBlock + '\n## Phase 0.8 — Implementation Planning & Validation (Phase 4)'
    );
    
    // Add Phase 6 learning loop to Phase 0.9
    const learningFeedbackBlock = `
6. **Learning Loop (Phase 6)**: Assess if a new lesson was learned. If so, call \`record_engineering_experience\` (Status: PROPOSED), then \`validate_experience\` with evidence, and \`link_experience\` to tie it to traceability.
`;
    plannerContent = plannerContent.replace(
        '5. **Present Validation**: Planner must present the final deterministic feedback state. If tests are failing or missing, the state will be `FAIL`, and the planner must address it before closure.',
        '5. **Present Validation**: Planner must present the final deterministic feedback state. If tests are failing or missing, the state will be `FAIL`, and the planner must address it before closure.\n' + learningFeedbackBlock
    );
    fs.writeFileSync(plannerPath, plannerContent, 'utf8');
    console.log("Patched planner.md for Phase 6");
}

const reviewerPath = path.join(__dirname, 'agents', 'reviewer.md');
if (fs.existsSync(reviewerPath)) {
    let reviewerContent = fs.readFileSync(reviewerPath, 'utf8');
    if (!reviewerContent.includes('Phase 6 Experience Verification')) {
        const reviewerExpBlock = `
### Phase 6 Experience Verification
When reviewing an implementation plan or code changes, verify:
- Experience used by the plan has provenance.
- Experience is NOT treated as current fact or requirement.
- Stale or conflicting experience is properly identified.
- Current repository evidence was checked.
- User decisions remain authoritative.
- No unsupported generalized rule was introduced.

Flag the following if found:
- \`UNPROVEN_EXPERIENCE\`
- \`STALE_EXPERIENCE\`
- \`CONFLICTING_EXPERIENCE\`
- \`EXPERIENCE_USED_AS_FACT\`
- \`EXPERIENCE_USED_AS_REQUIREMENT\`
- \`UNSUPPORTED_GENERALIZATION\`
- \`MISSING_PROVENANCE\`
- \`OUTDATED_REPOSITORY_CONTEXT\`
`;
        reviewerContent = reviewerContent + '\n' + reviewerExpBlock;
        fs.writeFileSync(reviewerPath, reviewerContent, 'utf8');
        console.log("Patched reviewer.md for Phase 6");
    }
}
