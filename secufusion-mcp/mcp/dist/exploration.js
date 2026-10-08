import fs from "fs";
import path from "path";
import { loadRequirement, saveRequirement, deriveExplorationStatus, explorationReadiness, } from "./requirement_manager.js";
import { addTraceabilityLink } from "./traceability_engine.js";
import { generateStaticUIReference, loadDesignMetadata, saveDesignMetadata, discoverUIPatterns, } from "./ui_intelligence.js";
/**
 * Deterministic bookkeeping for interactive exploration. Nothing here decides a
 * business or UX question: it records the questions, the user's own answers,
 * and refuses to let the requirement advance while any are missing.
 */
export class ExplorationError extends Error {
}
export const DECISION_CATEGORIES = [
    "business", "authorization", "tenant-isolation", "data-ownership", "deletion-retention",
    "api-contract", "event", "architecture", "security", "ux", "destructive",
];
function mustLoad(root, id) {
    const req = loadRequirement(root, id);
    if (!req)
        throw new ExplorationError(`Requirement ${id} not found. Create it with manage_requirement first.`);
    return req;
}
/** Exploration operations only make sense once investigation has started. */
function requireInvestigating(req, op) {
    if (["RAW", "UNDERSTOOD"].includes(req.status)) {
        throw new ExplorationError(`Cannot ${op} while ${req.id} is ${req.status}. Investigate the repository first and move it to INVESTIGATING.`);
    }
    if (["BLOCKED", "SUPERSEDED"].includes(req.status)) {
        throw new ExplorationError(`Cannot ${op}: ${req.id} is ${req.status}.`);
    }
}
/** Keep `status` truthful after every change. A CONFIRMED requirement that gains an open item is reopened. */
function syncStatus(req) {
    req.status = deriveExplorationStatus(req);
}
function save(root, req) {
    saveRequirement(root, req);
}
/** Path-like evidence is checked against the workspace; free text is left as null (unverifiable, not false). */
export function verifyEvidence(root, refs) {
    return refs.map((ref) => {
        const m = /^(.*?)(?::\d+(?:-\d+)?)?$/.exec(ref.trim());
        const candidate = (m ? m[1] : ref).trim();
        const pathLike = /[\\/]/.test(candidate) || /\.[A-Za-z0-9]{1,6}$/.test(candidate);
        if (!pathLike || /\s/.test(candidate))
            return { ref, exists: null };
        try {
            return { ref, exists: fs.existsSync(path.resolve(root, candidate)) };
        }
        catch {
            return { ref, exists: null };
        }
    });
}
function unverifiedWarning(checked) {
    const missing = checked.filter((c) => c.exists === false).map((c) => c.ref);
    return missing.length ? [`Evidence paths not found in the workspace (do not cite them as fact): ${missing.join(", ")}`] : [];
}
// ── UI impact ───────────────────────────────────────────────────────────────
const UI_KEYWORDS = [
    "ui", "screen", "page", "dialog", "modal", "label", "button", "table", "list", "dashboard", "form", "menu",
    "navigation", "confirmation", "toast", "notification", "empty state", "loading", "error message", "wording",
    "text", "display", "displays", "shown", "column", "tooltip", "layout", "icon", "badge", "tab", "dropdown",
    "workflow", "terminology", "copy", "translation", "localization",
];
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "should", "must", "have", "been", "user", "users"]);
/** A suggestion for the host LLM to confirm or reject. It never sets ui_impact itself. */
export function suggestUiImpact(req, snapshot) {
    const corpus = [req.title, req.raw_request, req.scope, ...(req.acceptance_criteria || []), ...(req.facts || [])]
        .filter(Boolean).join(" ").toLowerCase();
    const keyword_hits = UI_KEYWORDS.filter((k) => new RegExp(`\\b${k.replace(/ /g, "\\s+")}\\b`).test(corpus));
    const tokens = Array.from(new Set(corpus.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))).slice(0, 15);
    const candidate_components = snapshot && tokens.length
        ? discoverUIPatterns("", tokens.join(" "), snapshot).slice(0, 15).map((p) => ({ name: p.name, file: p.evidence?.location?.filePath ?? null, repository: p.evidence?.repository ?? null }))
        : [];
    return {
        likely_ui_impact: keyword_hits.length > 0 || candidate_components.length > 0,
        keyword_hits,
        candidate_components,
        note: "Keyword/graph suggestion only. Confirm by reading the component source, then call set_ui_impact with your rationale and evidence.",
    };
}
export function setUiImpact(root, id, p) {
    const req = mustLoad(root, id);
    requireInvestigating(req, "assess UI impact");
    if (!p.rationale?.trim())
        throw new ExplorationError("A rationale is required to assess UI impact.");
    const components = p.affected_components ?? [];
    const evidence = p.evidence ?? [];
    if (p.impact === "YES" && components.length === 0 && evidence.length === 0) {
        throw new ExplorationError("UI impact YES needs affected_components or evidence (e.g. the component file you read).");
    }
    const checked = verifyEvidence(root, evidence);
    req.ui_impact = {
        status: p.impact === "YES" ? "YES" : "NONE",
        rationale: p.rationale.trim(),
        affected_components: components,
        evidence,
        assessed_at: new Date().toISOString(),
    };
    syncStatus(req);
    save(root, req);
    return { status: req.status, ui_impact: req.ui_impact, warnings: unverifiedWarning(checked) };
}
// ── user decisions ──────────────────────────────────────────────────────────
export function askUserDecision(root, id, p) {
    const req = mustLoad(root, id);
    requireInvestigating(req, "ask a user decision");
    if (!p.question?.trim())
        throw new ExplorationError("A decision needs a question.");
    const options = Array.from(new Set((p.options || []).map((o) => o.trim()).filter(Boolean)));
    if (options.length < 2)
        throw new ExplorationError("Offer at least two distinct options so the user can choose.");
    const checked = verifyEvidence(root, p.evidence ?? []);
    req.user_decisions = req.user_decisions || [];
    const decision = {
        id: `UD-${req.user_decisions.length + 1}`,
        category: p.category,
        question: p.question.trim(),
        options,
        evidence: p.evidence ?? [],
        state: "OPEN",
        asked_at: new Date().toISOString(),
    };
    req.user_decisions.push(decision);
    syncStatus(req);
    save(root, req);
    return { decision, status: req.status, warnings: unverifiedWarning(checked) };
}
export function answerUserDecision(root, id, p) {
    const req = mustLoad(root, id);
    const d = (req.user_decisions || []).find((x) => x.id === p.decision_id);
    if (!d)
        throw new ExplorationError(`Decision ${p.decision_id} not found on ${id}.`);
    if (d.state !== "OPEN")
        throw new ExplorationError(`Decision ${d.id} is already answered.`);
    if (!p.answer?.trim())
        throw new ExplorationError("An answer is required.");
    if (!p.user_statement?.trim()) {
        throw new ExplorationError("user_statement is required: quote the user's own reply verbatim. Do not answer a decision on the user's behalf.");
    }
    d.state = "ANSWERED";
    d.answer = p.answer.trim();
    d.user_statement = p.user_statement.trim();
    d.answered_at = new Date().toISOString();
    req.decisions = req.decisions || [];
    req.decisions.push(`USER_DECISION[${d.id}] ${d.question} → ${d.answer}`);
    addTraceabilityLink(root, `REQUIREMENT:${id}`, `DECISION:${id}:${d.id}`, "DECIDED_BY_USER", "USER_CONFIRMED", "CONFIRMED");
    syncDesignDecisions(root, req);
    syncStatus(req);
    save(root, req);
    return { decision: d, status: req.status };
}
function syncDesignDecisions(root, req) {
    const ref = req.ui_reference;
    if (!ref?.design_id)
        return;
    const meta = loadDesignMetadata(root, ref.design_id);
    if (!meta)
        return;
    meta.decisions = req.decisions || [];
    saveDesignMetadata(root, meta);
}
/** Exact block the host should show the user. Ends with the marker the command treats as a hard stop. */
export function formatUserDecision(d, requirementId) {
    const letters = "ABCDEFGHIJ";
    return [
        `Decision ${d.id} for ${requirementId} (${d.category})`,
        ``,
        d.question,
        ``,
        ...d.options.map((o, i) => `  ${letters[i] ?? i + 1}. ${o}`),
        ...(d.evidence.length ? [``, `Evidence: ${d.evidence.join("; ")}`] : []),
        ``,
        `USER_DECISION_REQUIRED`,
        `STOP. Show this to the user and wait. Do not choose for them, do not continue exploration, do not confirm.`,
    ].join("\n");
}
// ── UI reference ────────────────────────────────────────────────────────────
export function createUiReference(root, id, p) {
    const req = mustLoad(root, id);
    requireInvestigating(req, "generate a UI reference");
    if (req.ui_impact?.status !== "YES") {
        throw new ExplorationError("Assess UI impact first: a reference is only generated when ui_impact is YES (manage_exploration set_ui_impact).");
    }
    const evidence = p.evidence ?? [];
    if (evidence.length === 0 && !p.novelty_reason?.trim()) {
        throw new ExplorationError("Inspect existing UI first: cite the existing components/dialogs you read as evidence, or give novelty_reason explaining why no existing pattern applies.");
    }
    const designId = p.design_id || req.ui_reference?.design_id || `DESIGN-${id}`;
    const checked = verifyEvidence(root, evidence);
    const components = p.affected_components ?? req.ui_impact.affected_components;
    const index = generateStaticUIReference(root, designId, p.html, {
        requirementId: id,
        title: p.title,
        purpose: p.purpose,
        affectedComponents: components,
        decisions: req.decisions || [],
        evidence: checked,
        traceability: [`REQUIREMENT:${id}`],
    });
    const meta = loadDesignMetadata(root, designId);
    meta.reviewStatus = "AWAITING_FEEDBACK";
    saveDesignMetadata(root, meta);
    req.ui_reference = { design_id: designId, status: "AWAITING_FEEDBACK", revision: meta.revision, updated_at: new Date().toISOString() };
    addTraceabilityLink(root, `REQUIREMENT:${id}`, `DESIGN:${designId}`, "HAS_UI_REFERENCE", "DIRECT", "SUPPORTED");
    for (const c of components) {
        addTraceabilityLink(root, `DESIGN:${designId}`, `FRONTEND_COMPONENT:${c}`, "REFERENCES_COMPONENT", "INFERRED", "INFERRED");
    }
    syncStatus(req);
    save(root, req);
    return { index_path: index, metadata: meta, status: req.status, warnings: unverifiedWarning(checked) };
}
export function recordUiFeedback(root, id, p) {
    const req = mustLoad(root, id);
    requireInvestigating(req, "record UI feedback");
    if (!p.user_statement?.trim()) {
        throw new ExplorationError("user_statement is required: quote the user's own reply verbatim. A generated reference is never approved on the user's behalf.");
    }
    const ref = req.ui_reference;
    const now = new Date().toISOString();
    req.decisions = req.decisions || [];
    if (p.outcome === "NO_UI_REQUIRED") {
        if (req.ui_impact?.status !== "YES")
            throw new ExplorationError("NO_UI_REQUIRED only applies when ui_impact is YES; otherwise set ui_impact to NO.");
        req.ui_reference = { design_id: ref?.design_id ?? "", status: "NOT_REQUIRED", revision: ref?.revision ?? 0, updated_at: now, user_statement: p.user_statement.trim() };
        req.decisions.push(`USER_DECISION[UI] No UI reference required: ${p.user_statement.trim()}`);
    }
    else {
        if (!ref || ref.status !== "AWAITING_FEEDBACK") {
            throw new ExplorationError("There is no UI reference awaiting feedback. Generate (or regenerate) one with generate_static_ui_reference first.");
        }
        const meta = loadDesignMetadata(root, ref.design_id);
        if (p.outcome === "APPROVED") {
            ref.status = "CONFIRMED";
            req.decisions.push(`UI_REFERENCE_CONFIRMED[${ref.design_id} r${ref.revision}] ${p.user_statement.trim()}`);
            addTraceabilityLink(root, `REQUIREMENT:${id}`, `DESIGN:${ref.design_id}`, "HAS_UI_REFERENCE", "USER_CONFIRMED", "CONFIRMED");
        }
        else {
            if (!p.feedback?.trim())
                throw new ExplorationError("CHANGES_REQUESTED needs the feedback to apply.");
            ref.status = "REVISION_REQUESTED";
            req.decisions.push(`UI_FEEDBACK[${ref.design_id} r${ref.revision}] ${p.feedback.trim()}`);
        }
        ref.user_statement = p.user_statement.trim();
        ref.updated_at = now;
        if (meta) {
            meta.reviewStatus = ref.status;
            meta.decisions = req.decisions;
            saveDesignMetadata(root, meta);
        }
    }
    syncStatus(req);
    save(root, req);
    return { status: req.status, ui_reference: req.ui_reference };
}
// ── status / handoff ────────────────────────────────────────────────────────
export function explorationStatus(root, id) {
    const req = mustLoad(root, id);
    const ref = req.ui_reference;
    return {
        id,
        title: req.title,
        status: req.status,
        readiness: explorationReadiness(req),
        open_user_decisions: (req.user_decisions || []).filter((d) => d.state === "OPEN"),
        ui_impact: req.ui_impact ?? null,
        ui_reference: ref ?? null,
        design: ref?.design_id ? loadDesignMetadata(root, ref.design_id) : null,
    };
}
/** What /sfn-spec, /sfn-code and /sfn-review need to honour confirmed exploration. */
export function explorationSummary(root, id) {
    const req = loadRequirement(root, id);
    if (!req)
        return null;
    const ref = req.ui_reference;
    const meta = ref?.design_id ? loadDesignMetadata(root, ref.design_id) : null;
    return {
        requirement_status: req.status,
        user_decisions: (req.user_decisions || []).filter((d) => d.state === "ANSWERED").map((d) => ({ id: d.id, question: d.question, answer: d.answer, user_statement: d.user_statement })),
        recorded_decisions: req.decisions || [],
        ui_impact: req.ui_impact ?? null,
        ui_reference: ref
            ? {
                design_id: ref.design_id, review_status: ref.status, revision: ref.revision,
                implementation_status: meta?.implementationStatus ?? "NOT_IMPLEMENTED",
                affected_components: meta?.affectedComponents ?? [],
                path: ref.design_id ? path.join(".secufusion", "designs", ref.design_id, "index.html") : null,
                note: "Design intent, not a screenshot test. Do not require pixel matching; flag divergence from intent.",
            }
            : null,
    };
}
