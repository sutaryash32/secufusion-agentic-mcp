const fs = require('fs');

const file = 'agents/planner.md';
let content = fs.readFileSync(file, 'utf8');

const startMarker = '## Phase 0.25 — Clarify and Capture Business Intent (The WHY Layer)';
const endMarker = '### After classify_task returns — performance and breaking change checks';

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error("Could not find markers in planner.md");
    process.exit(1);
}

const replacement = `## Phase 0.25 — Requirement Intake and Repository Investigation
(TRIGGER: when a **NEW** task, feature, or bug is received that has no existing tracking)

Before thinking about *how* to implement the task, you must understand *why* it is needed, and ground it in repository evidence.
You must follow this deterministic pipeline:

1. **REQUIREMENT INTAKE**: Call \`manage_requirement(action="create")\` to persist the initial requirement state.
2. **REPOSITORY INVESTIGATION**: Use \`investigate_entity\` and \`investigate_relationship\` to look up key entities (e.g. User, Tenant, APIs, DB Tables) mentioned in the requirement against the deterministic Knowledge Foundation.
3. **KNOWN FACTS + EVIDENCE**: Record what exists. If the investigation returns NOT_FOUND, that is a factual result. DO NOT invent missing architecture.
4. **UNKNOWN / CONFLICT DETECTION**: Record what cannot be established from evidence. Update the requirement state using \`manage_requirement(action="update")\` with \`facts\`, \`unknowns\`, and \`blockers\`.

---

## Phase 0.5 — Clarification and Confirmed Specification
(TRIGGER: after repository investigation is complete)

If there are material ambiguities (security, destructive operations, authorization, tenancy, data ownership, retention) that cannot be safely resolved from repository evidence, YOU MUST ASK THE USER.

1. **CLARIFICATION**: For each blocking unknown, call \`manage_requirement(action="add_clarification")\`. Group closely related questions when possible.
2. **YIELD**: Present the clarification questions to the developer and STOP. Wait for explicit answers.
3. **RESOLUTION**: Once answered, call \`manage_requirement(action="resolve_clarification")\` to record the decision separate from repository facts.
4. **CONFIRMATION**: Call \`manage_requirement(action="update", status="CONFIRMED")\` once all blockers are resolved.
5. **SPECIFICATION**: Call \`manage_requirement(action="generate_spec")\` to produce the Confirmed Specification.

The Planner MUST consume the Confirmed Specification rather than jumping directly from raw requirement to implementation.

### Exact Sequence

\`\`\`
STEP 0 (Intake & Investigation):
  → call manage_requirement(action="create")
  → call investigate_entity and investigate_relationship
  → call manage_requirement(action="update") with facts/unknowns

STEP 1 (Clarification if required):
  → call manage_requirement(action="add_clarification")
  → PRESENT QUESTIONS TO USER AND STOP.

STEP 2 (Confirmation):
  → call manage_requirement(action="resolve_clarification")
  → call manage_requirement(action="update", status="CONFIRMED")
  → call manage_requirement(action="generate_spec")

STEP 3 (Architecture Reasoning):
  → Output \`### Ultimate Reasoning\` block analyzing the Confirmed Spec.
  → call classify_task to validate structural boundaries based on facts.
  → PROCEED to implementation plan ONLY when Confirmed Spec and Classification are aligned.
\`\`\`

### Hard Enforcement

❌ Write a plan before CONFIRMED state.  
❌ Write any code before CONFIRMED state.  
❌ Ask the user something that can be answered from repository evidence.  
❌ Invent assumptions about tenancy, deletion, or retention.  

---

`;

content = content.slice(0, startIndex) + replacement + content.slice(endIndex);
fs.writeFileSync(file, content);
console.log("Patched planner.md");
