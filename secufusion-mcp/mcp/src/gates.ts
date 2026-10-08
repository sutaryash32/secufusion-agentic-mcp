import fs from "fs";
import path from "path";

/**
 * Phase gate ledger. A phase is only PASSED when a recorded judgment says so;
 * tools later in the lifecycle refuse to run until their prerequisites passed.
 *
 * One ledger per spec id (work item id == requirement id by convention).
 */

export const PHASES = ["philosophy", "intent", "classification", "requirement", "plan", "review"] as const;
export type Phase = (typeof PHASES)[number];

export interface GateEntry {
    status: "PASSED" | "FAILED";
    source: string;
    summary: string;
    at: string;
}

export interface Ledger {
    id: string;
    phases: Partial<Record<Phase, GateEntry>>;
}

function ledgerPath(root: string, id: string): string {
    return path.join(root, ".secufusion", "gates", `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

export function readLedger(root: string, id: string): Ledger {
    try {
        return JSON.parse(fs.readFileSync(ledgerPath(root, id), "utf-8"));
    } catch {
        return { id, phases: {} };
    }
}

export function recordGate(root: string, id: string, phase: Phase, passed: boolean, source: string, summary: string): void {
    const ledger = readLedger(root, id);
    ledger.phases[phase] = { status: passed ? "PASSED" : "FAILED", source, summary, at: new Date().toISOString() };
    // A new verdict upstream invalidates everything decided after it.
    const idx = PHASES.indexOf(phase);
    for (const later of PHASES.slice(idx + 1)) {
        if (!passed) delete ledger.phases[later];
    }
    const p = ledgerPath(root, id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(ledger, null, 2));
}

const NEXT_STEP: Record<Phase, string> = {
    philosophy: "philosophy_check (WHY/WHO/WHAT/RISK)",
    intent: "spec_create_intent (business goal + acceptance criteria)",
    classification: "classify_task",
    requirement: "manage_requirement action=assess, then action=update status=CONFIRMED",
    plan: "manage_implementation_plan, then validate_implementation_plan",
    review: "verify_against_spec",
};

/** Returns an error message if any prerequisite phase has not PASSED, else null. */
export function requireGates(root: string, id: string, needed: Phase[], action: string): string | null {
    const ledger = readLedger(root, id);
    const missing = needed.filter((p) => ledger.phases[p]?.status !== "PASSED");
    if (missing.length === 0) return null;
    return (
        `⛔ SPEC GATE: cannot ${action} for ${id}.\n` +
        missing
            .map((p) => `  • ${p}: ${ledger.phases[p] ? `FAILED — ${ledger.phases[p]!.summary}` : "not done"} → run ${NEXT_STEP[p]}`)
            .join("\n") +
        `\n\nUse spec_status(work_item_id: "${id}") to see the full ledger.`
    );
}

export function nextPhase(root: string, id: string): Phase | null {
    const ledger = readLedger(root, id);
    return PHASES.find((p) => ledger.phases[p]?.status !== "PASSED") ?? null;
}

export function nextStepHint(phase: Phase): string {
    return NEXT_STEP[phase];
}
