const fs = require('fs');
const path = require('path');

const plannerPath = path.join(__dirname, 'agents', 'planner.md');
let plannerContent = fs.readFileSync(plannerPath, 'utf8');

if (!plannerContent.includes('Phase 0.78 — UX Interaction & UI Design (Phase 8)')) {
    const p8Block = `
## Phase 0.78 — UX Interaction & UI Design (Phase 8)
(TRIGGER: When planning new frontend or full-stack features)

1. **Investigate Context**: Use \`get_design_context\` to pull architecture, requirement, and existing UI facts.
2. **Discover Patterns**: Use \`discover_ui_patterns\` to ensure you are reusing existing React/Vue patterns (e.g. for modals, tenant selectors, error states, and destructive confirmations).
3. **Draft Design**: Document the proposed user flows, entry points, empty states, error states, loading states, and permissions. Identify unresolved unknowns or user decisions.
4. **Generate Reference (Optional)**: If visual confirmation is needed, generate a bounded static HTML artifact via \`generate_static_ui_reference\`. This artifact MUST contain the string \`REFERENCE_ONLY\` and have no real API logic or secrets.
5. **Traceability Check**: Ensure the design maps back to a requirement. Clearly distinguish:
   - "Design reference exists" (Draft/Static HTML)
   - "Design is confirmed" (User explicitly signed off on the UX)
   - "Design is implemented" (Production React code merged)
`;
    plannerContent = plannerContent.replace(
        '## Phase 0.8 — Implementation Planning & Validation (Phase 4)',
        p8Block + '\n## Phase 0.8 — Implementation Planning & Validation (Phase 4)'
    );
    
    fs.writeFileSync(plannerPath, plannerContent, 'utf8');
    console.log("Patched planner.md for Phase 8");
}

const reviewerPath = path.join(__dirname, 'agents', 'reviewer.md');
if (fs.existsSync(reviewerPath)) {
    let reviewerContent = fs.readFileSync(reviewerPath, 'utf8');
    if (!reviewerContent.includes('Phase 8 UI Design & UX Interaction Verification')) {
        const r8Block = `
### Phase 8 UI Design & UX Interaction Verification
When reviewing frontend implementation plans or code changes, verify:
- UI changes map back to a confirmed design and requirement.
- Static HTML generated during planning is NOT copied verbatim into production.
- Production UI changes were explicitly outlined in the plan.
- UI patterns used are supported by evidence (discovered from the repository).

Flag the following if found:
- \`DESIGN_WITHOUT_REQUIREMENT\`
- \`DESIGN_WITHOUT_EVIDENCE\`
- \`DESIGN_USED_AS_FACT\`
- \`UNCONFIRMED_DESIGN\`
- \`STALE_DESIGN\`
- \`UI_PATTERN_WITHOUT_SOURCE\`
- \`PRODUCTION_UI_CHANGED_WITHOUT_PLAN\`
- \`CONFIRMED_DESIGN_WITHOUT_TRACEABILITY\`
- \`IMPLEMENTATION_DEVIATES_FROM_CONFIRMED_DESIGN\`
`;
        reviewerContent = reviewerContent + '\n' + r8Block;
        fs.writeFileSync(reviewerPath, reviewerContent, 'utf8');
        console.log("Patched reviewer.md for Phase 8");
    }
}
