/**
 * Before a behavior change is called "intent not confirmed", look for what confirms it.
 *
 * Sources searched deterministically: the story's acceptance criteria, its story text (requirement, plan, specification),
 * ADRs, and recorded product decisions (answered user decisions, the task's decision log, accepted project knowledge).
 * The fifth source, user instruction (what the user told the reviewer in this conversation), cannot be searched here; the
 * reviewer checks it. This is keyword evidence: it finds sentences that talk about the same things the code now does. The
 * reviewer reads the full text and decides whether it really confirms THIS behavior; a nearby sentence is not confirmation.
 */
import fs from "fs";
import path from "path";
import { loadRequirement } from "./requirement_manager.js";
import { findPlanFor } from "./pr_summary.js";
import { loadKnowledge } from "./project_knowledge.js";

export type SourceKind = "acceptance criterion" | "story text" | "ADR" | "product decision";
export interface IntentSource { kind: SourceKind; label: string; text: string; trust?: string }
export interface Support { source: SourceKind; label: string; quote: string; matched: string[]; trust?: string }

export const SEARCHED = "acceptance criteria, story text, ADRs, recorded product decisions";

const STOP = new Set([
    "this", "that", "with", "from", "have", "will", "when", "then", "than", "into", "does", "must", "should", "would", "could", "each", "every", "only", "also", "return", "returns", "public", "private", "protected", "static", "final", "string", "long", "integer", "boolean", "void", "class", "null", "true", "false", "else", "throw", "throws", "import", "package", "equals", "size", "length", "value", "values", "name", "names", "list", "data", "item", "items", "result", "response", "request", "service", "object", "param", "params", "args", "test", "type", "new", "get", "set",
]);

const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };

/** words inside identifiers and keys: retentionDays, retention.days, FEATURE_AUDIT -> retention, days, feature, audit */
function words(s: string): string[] {
    return [...s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").matchAll(/[A-Za-z]{4,}/g)].map((m) => m[0].toLowerCase()).filter((w) => !STOP.has(w));
}

/** The concepts a changed line is about: its words, its numbers and its quoted text. */
export function conceptsOf(lines: string[]): { words: Set<string>; numbers: Set<string> } {
    const text = lines.join(" ");
    const ws = new Set(words(text));
    for (const m of text.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)) for (const w of words(m[1] ?? m[2] ?? "")) ws.add(w);
    const nums = new Set([...text.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map((m) => m[0]).filter((n) => n.length >= 2 || Number(n) > 1));
    return { words: ws, numbers: nums };
}

/** a light stem so "reconcile" finds "reconciliation" and "schedule" finds "scheduled" */
const stem = (w: string) => (w.length >= 7 ? w.slice(0, -2) : w);

const sentences = (t: string): string[] => t.split(/(?<=[.!?])\s+|\r?\n+/).map((s) => s.trim()).filter((s) => s.length >= 8);

export function findIntentEvidence(oldLines: string[], newLines: string[], sources: IntentSource[], max = 3): Support[] {
    const o = conceptsOf(oldLines), n = conceptsOf(newLines);
    const wset = new Set([...o.words, ...n.words]);
    const nset = new Set([...o.numbers, ...n.numbers]);
    const found: Array<Support & { score: number }> = [];
    for (const src of sources) {
        for (const sent of sentences(src.text)) {
            const low = sent.toLowerCase();
            const matched = [
                ...[...wset].filter((w) => new RegExp(`\\b${stem(w)}`).test(low)),
                ...[...nset].filter((x) => new RegExp(`(?<![\\w.])${x.replace(".", "\\.")}(?![\\w.])`).test(sent)),
            ];
            // two shared concepts at least: a lone common word is not evidence
            if (matched.length >= 2) found.push({ source: src.kind, label: src.label, quote: sent.length > 220 ? sent.slice(0, 217) + "..." : sent, matched, trust: src.trust, score: matched.length });
        }
    }
    found.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    return found.filter((f) => { const k = f.label + f.quote; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, max).map(({ score, ...s }) => s);
}

/** The story's recorded sources: acceptance criteria, story text, ADRs and product decisions. */
export function gatherIntentSources(opts: { ecosystemRoot: string; workItemId: string; taskDir?: string | null }): IntentSource[] {
    const out: IntentSource[] = [];
    const req = loadRequirement(opts.ecosystemRoot, opts.workItemId);
    const plan = findPlanFor(opts.ecosystemRoot, opts.workItemId);
    const spec = opts.taskDir ? readJson(path.join(opts.taskDir, "spec.json")) : null;
    const acs: string[] = req?.acceptance_criteria?.length ? req.acceptance_criteria : (spec?.acceptance_criteria ?? []);
    acs.forEach((a, i) => out.push({ kind: "acceptance criterion", label: `acceptance criterion ${i + 1}`, text: a }));
    if (req) {
        for (const [label, t] of [["requirement: title", req.title], ["requirement: request", req.raw_request], ["requirement: scope", req.scope]] as const) if (t) out.push({ kind: "story text", label, text: String(t) });
        (req.constraints ?? []).forEach((c, i) => out.push({ kind: "story text", label: `requirement: constraint ${i + 1}`, text: c }));
        (req.facts ?? []).forEach((c, i) => out.push({ kind: "story text", label: `requirement: finding ${i + 1}`, text: c }));
        for (const d of (req.user_decisions ?? []).filter((x: any) => x.state === "ANSWERED")) {
            out.push({ kind: "product decision", label: `user decision ${d.id}`, text: `${d.question} ${d.answer}${d.user_statement ? ` ${d.user_statement}` : ""}`, trust: "answered by the user" });
        }
    }
    if (spec?.description) out.push({ kind: "story text", label: "task description", text: String(spec.description) });
    if (plan) {
        if (plan.summary) out.push({ kind: "story text", label: "plan: summary", text: plan.summary });
        (plan.implementation_steps ?? []).forEach((s, i) => out.push({ kind: "story text", label: `plan: step ${i + 1}`, text: s }));
    }
    if (opts.taskDir) {
        try { out.push({ kind: "story text", label: "specification (spec.md)", text: fs.readFileSync(path.join(opts.taskDir, "spec.md"), "utf-8") }); } catch { /* not written yet */ }
        for (const d of (readJson(path.join(opts.taskDir, "decisions.json")) ?? []) as any[]) {
            out.push({ kind: "product decision", label: "task decision", text: `${d.decision ?? ""} ${d.rationale ?? ""}`, trust: "recorded in the task's decision log" });
        }
    }
    const model = loadKnowledge(opts.ecosystemRoot);
    for (const e of model.entries) {
        if (e.status === "superseded" || e.status === "deprecated") continue;
        if (e.category === "adr") out.push({ kind: "ADR", label: `ADR ${e.id}`, text: `${e.title}. ${e.body}`, trust: e.status === "accepted" ? "accepted" : `${e.status}: a hint, not confirmation` });
        else if (e.status === "accepted") out.push({ kind: "product decision", label: `project knowledge ${e.id}`, text: `${e.title}. ${e.body}`, trust: "accepted project knowledge" });
    }
    return out;
}
