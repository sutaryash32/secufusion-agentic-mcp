import fs from 'fs';
import path from 'path';
import { z } from 'zod';

export type RequirementStatus = "RAW" | "UNDERSTOOD" | "INVESTIGATING" | "UI_DESIGN_REQUIRED" | "USER_FEEDBACK_REQUIRED" | "USER_DECISION_REQUIRED" | "CLARIFICATION_REQUIRED" | "CONFIRMED" | "BLOCKED" | "SUPERSEDED";

/** A decision only the user can make. Never invented by the MCP or the host LLM. */
export interface UserDecision {
    id: string;
    category: string;
    question: string;
    options: string[];
    evidence: string[];
    state: "OPEN" | "ANSWERED";
    asked_at: string;
    answer?: string;
    /** The user's own words, verbatim. Required to answer. */
    user_statement?: string;
    answered_at?: string;
}

export interface UiImpact {
    status: "UNASSESSED" | "NONE" | "YES";
    rationale: string;
    affected_components: string[];
    evidence: string[];
    assessed_at: string;
}

export interface UiReferenceState {
    design_id: string;
    status: "AWAITING_FEEDBACK" | "REVISION_REQUESTED" | "CONFIRMED" | "NOT_REQUIRED";
    revision: number;
    updated_at: string;
    user_statement?: string;
}
export type ClarificationState = "OPEN" | "ANSWERED" | "RESOLVED" | "REJECTED" | "SUPERSEDED";
export type ClarificationSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ClarificationQuestion {
    id: string;
    topic: string;
    issue: string;
    state: ClarificationState;
    evidence: string[];
    severity: ClarificationSeverity;
    blocking: boolean;
    question: string;
    answer?: string;
    decision?: string;
    created_at: string;
    resolved_at?: string;
}

export interface Requirement {
    id: string;
    raw_request?: string;
    title?: string;
    status: RequirementStatus;
    scope?: string;
    actors?: string[];
    tenancy?: string;
    authorization?: string;
    business_rules?: string[];
    data_lifecycle?: string;
    apis?: string[];
    events?: string[];
    frontend?: string[];
    extension?: string[];
    persistence?: string[];
    acceptance_criteria?: string[];
    constraints?: string[];
    
    // Reasoning State
    facts?: string[];
    inferences?: string[];
    assumptions?: string[];
    unknowns?: string[];
    conflicts?: string[];
    blockers?: string[];
    
    clarification_questions: ClarificationQuestion[];
    decisions?: string[];
    related_tasks?: string[];
    traceability?: string[];

    // Interactive exploration state
    user_decisions?: UserDecision[];
    ui_impact?: UiImpact;
    ui_reference?: UiReferenceState;
}

export function getRequirementPath(ecosystemRoot: string, reqId: string) {
    const reqDir = path.join(ecosystemRoot, ".secufusion", "requirements");
    if (!fs.existsSync(reqDir)) {
        fs.mkdirSync(reqDir, { recursive: true });
    }
    return path.join(reqDir, `${reqId}.json`);
}

export function loadRequirement(ecosystemRoot: string, reqId: string): Requirement | null {
    const p = getRequirementPath(ecosystemRoot, reqId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveRequirement(ecosystemRoot: string, req: Requirement) {
    const p = getRequirementPath(ecosystemRoot, req.id);
    fs.writeFileSync(p, JSON.stringify(req, null, 2));
}

const ACTIVE_STATES: RequirementStatus[] = ["INVESTIGATING", "UI_DESIGN_REQUIRED", "USER_FEEDBACK_REQUIRED", "USER_DECISION_REQUIRED", "CLARIFICATION_REQUIRED"];

export interface ExplorationReadiness {
    ready: boolean;
    blockers: string[];
    next_action: string;
}

/**
 * Deterministic answer to "may this requirement be CONFIRMED?". It never decides
 * anything itself: it only reports which recorded facts are still missing.
 */
export function explorationReadiness(req: Requirement): ExplorationReadiness {
    const blockers: string[] = [];
    let next = "";
    const note = (b: string, n: string) => { blockers.push(b); if (!next) next = n; };

    const open = (req.user_decisions || []).filter(d => d.state === "OPEN");
    if (open.length > 0) {
        note(`USER_DECISION_REQUIRED: ${open.length} unanswered (${open.map(d => d.id).join(", ")})`,
            "Ask the user the open decision(s) and STOP until they answer (manage_exploration answer_user_decision).");
    }
    if (req.blockers && req.blockers.length > 0) {
        note(`Active blockers: ${req.blockers.join("; ")}`, "Resolve the blockers or ask the user.");
    }
    const openClar = (req.clarification_questions || []).filter(c => c.state === "OPEN" && c.blocking);
    if (openClar.length > 0) {
        note(`OPEN blocking clarification questions: ${openClar.map(c => c.id).join(", ")}`, "Ask the user and record the answers (resolve_clarification).");
    }

    const impact = req.ui_impact;
    if (!impact || impact.status === "UNASSESSED") {
        note("UI impact has not been assessed", "Assess UI impact (manage_exploration set_ui_impact, after detect_ui_impact).");
    } else if (impact.status === "YES") {
        const ref = req.ui_reference;
        if (!ref) {
            note("UI-impacting change has no UI reference", "Inspect existing UI patterns, then generate_static_ui_reference.");
        } else if (ref.status === "AWAITING_FEEDBACK") {
            note(`UI reference ${ref.design_id} r${ref.revision} has not been reviewed by the user`, "Show the reference to the user and STOP for feedback (record_ui_feedback).");
        } else if (ref.status === "REVISION_REQUESTED") {
            note(`UI reference ${ref.design_id} needs revision`, "Regenerate the reference with the user's changes.");
        }
        // CONFIRMED and NOT_REQUIRED (explicit user statement) both satisfy the gate.
    }
    return { ready: blockers.length === 0, blockers, next_action: next || "Ready: run manage_requirement assess, then update status=CONFIRMED." };
}

/** The status an in-flight exploration should be in, given what is recorded. */
export function deriveExplorationStatus(req: Requirement): RequirementStatus {
    if ((req.user_decisions || []).some(d => d.state === "OPEN")) return "USER_DECISION_REQUIRED";
    if (req.ui_impact?.status === "YES") {
        const ref = req.ui_reference;
        if (!ref || ref.status === "REVISION_REQUESTED") return "UI_DESIGN_REQUIRED";
        if (ref.status === "AWAITING_FEEDBACK") return "USER_FEEDBACK_REQUIRED";
    }
    if ((req.clarification_questions || []).some(c => c.state === "OPEN" && c.blocking)) return "CLARIFICATION_REQUIRED";
    return "INVESTIGATING";
}

export function validateStateTransition(current: RequirementStatus, next: RequirementStatus, req: Requirement): boolean {
    if (next === "BLOCKED" || next === "SUPERSEDED") return true;

    const validFlows: Record<RequirementStatus, RequirementStatus[]> = {
        "RAW": ["UNDERSTOOD", "INVESTIGATING", "BLOCKED", "SUPERSEDED"],
        "UNDERSTOOD": ["INVESTIGATING", "BLOCKED", "SUPERSEDED"],
        "INVESTIGATING": [...ACTIVE_STATES, "CONFIRMED"],
        "UI_DESIGN_REQUIRED": [...ACTIVE_STATES, "CONFIRMED"],
        "USER_FEEDBACK_REQUIRED": [...ACTIVE_STATES, "CONFIRMED"],
        "USER_DECISION_REQUIRED": [...ACTIVE_STATES, "CONFIRMED"],
        "CLARIFICATION_REQUIRED": [...ACTIVE_STATES, "CONFIRMED"],
        "CONFIRMED": ["INVESTIGATING", "BLOCKED", "SUPERSEDED"],
        "BLOCKED": ["INVESTIGATING", "SUPERSEDED"],
        "SUPERSEDED": []
    };

    if (!validFlows[current].includes(next)) {
        throw new Error(`Invalid transition from ${current} to ${next}`);
    }

    if (next === "CONFIRMED") {
        const readiness = explorationReadiness(req);
        if (!readiness.ready) {
            throw new Error("Cannot transition to CONFIRMED:\n  - " + readiness.blockers.join("\n  - ") + "\nNext: " + readiness.next_action);
        }
    }

    return true;
}

export function generateConfirmedSpecification(req: Requirement): string {
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
