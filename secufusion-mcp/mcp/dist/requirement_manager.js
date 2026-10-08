import fs from 'fs';
import path from 'path';
export function getRequirementPath(ecosystemRoot, reqId) {
    const reqDir = path.join(ecosystemRoot, ".secufusion", "requirements");
    if (!fs.existsSync(reqDir)) {
        fs.mkdirSync(reqDir, { recursive: true });
    }
    return path.join(reqDir, `${reqId}.json`);
}
export function loadRequirement(ecosystemRoot, reqId) {
    const p = getRequirementPath(ecosystemRoot, reqId);
    if (!fs.existsSync(p))
        return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
}
export function saveRequirement(ecosystemRoot, req) {
    const p = getRequirementPath(ecosystemRoot, req.id);
    fs.writeFileSync(p, JSON.stringify(req, null, 2));
}
export function validateStateTransition(current, next, req) {
    if (next === "BLOCKED" || next === "SUPERSEDED")
        return true;
    const validFlows = {
        "RAW": ["UNDERSTOOD", "INVESTIGATING", "BLOCKED", "SUPERSEDED"],
        "UNDERSTOOD": ["INVESTIGATING", "BLOCKED", "SUPERSEDED"],
        "INVESTIGATING": ["CONFIRMED", "CLARIFICATION_REQUIRED", "BLOCKED", "SUPERSEDED"],
        "CLARIFICATION_REQUIRED": ["INVESTIGATING", "BLOCKED", "SUPERSEDED"],
        "CONFIRMED": ["INVESTIGATING", "BLOCKED", "SUPERSEDED"],
        "BLOCKED": ["INVESTIGATING", "SUPERSEDED"],
        "SUPERSEDED": []
    };
    if (!validFlows[current].includes(next)) {
        throw new Error(`Invalid transition from ${current} to ${next}`);
    }
    if (next === "CONFIRMED") {
        if (req.blockers && req.blockers.length > 0) {
            throw new Error("Cannot transition to CONFIRMED with active blockers.");
        }
        const openClarifications = req.clarification_questions.filter(c => c.state === "OPEN" && c.blocking);
        if (openClarifications.length > 0) {
            throw new Error("Cannot transition to CONFIRMED with OPEN blocking clarification questions.");
        }
    }
    return true;
}
export function generateConfirmedSpecification(req) {
    let spec = `---
Requirement ID: ${req.id}
Title: ${req.title || "Untitled"}
Status: ${req.status}
---

# CONFIRMED SPECIFICATION

## WHAT THE USER REQUESTED
${req.raw_request || "Not provided."}

## WHAT THE REPOSITORY CURRENTLY DOES
(Based on gathered facts)
${req.facts ? req.facts.map(f => "- " + f).join("\\n") : "No facts recorded."}

## WHAT WAS CONFIRMED BY THE USER
${req.decisions ? req.decisions.map(d => "- " + d).join("\\n") : "No specific decisions recorded."}

## WHAT REMAINS UNKNOWN
${req.unknowns ? req.unknowns.map(u => "- " + u).join("\\n") : "None."}

## SCOPE & DETAILS
- Scope: ${req.scope || "Unknown"}
- Tenancy: ${req.tenancy || "Unknown"}
- Authorization: ${req.authorization || "Unknown"}
- Data Lifecycle: ${req.data_lifecycle || "Unknown"}

### Technical Implications
- APIs: ${req.apis ? req.apis.join(", ") : "None"}
- Events: ${req.events ? req.events.join(", ") : "None"}
- Persistence: ${req.persistence ? req.persistence.join(", ") : "None"}
- Frontend: ${req.frontend ? req.frontend.join(", ") : "None"}

## ACCEPTANCE CRITERIA
${req.acceptance_criteria ? req.acceptance_criteria.map(a => "- [ ] " + a).join("\\n") : "None specified."}
`;
    return spec;
}
