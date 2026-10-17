/**
 * Calibration: would the review have written the same comments as the client reviewer?
 *
 * Blind protocol, enforced by the files:
 *   1. seal    the review's own concerns are written down FIRST and hashed. Refused once client comments exist.
 *   2. reveal  only then are the client's comments added. Refused without an intact seal.
 * Matching is lexical (shared significant words and identifiers) and only proposes candidates: the reviewer confirms or
 * overrides each pairing. Parity is reported as derived / partial / missed, with extras (concerns the client did not raise).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const CATEGORIES = ["BLOCKING", "NON-BLOCKING", "QUESTION", "REQUIRES_DECISION"] as const;
export type Cat = (typeof CATEGORIES)[number];
export interface Derived { title: string; category: Cat; entity?: string; text: string; derived_from?: string }
export interface ClientComment { text: string; category?: string }
export interface Override { client: number; derived: number | null; verdict: "DERIVED" | "PARTIAL" | "MISSED" }
export interface Pairing { client: number; derived: number | null; score: number; verdict: "DERIVED" | "PARTIAL" | "MISSED"; by: "lexical" | "reviewer"; category_match: boolean | null }

const dir = (root: string) => path.join(root, ".secufusion", "calibration");
const safe = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, "_");
const sealedPath = (root: string, id: string) => path.join(dir(root), `${safe(id)}.sealed.json`);
const clientPath = (root: string, id: string) => path.join(dir(root), `${safe(id)}.client.json`);
const hashOf = (f: Derived[]) => crypto.createHash("sha256").update(JSON.stringify(f)).digest("hex");

export function seal(root: string, id: string, findings: Derived[]): { sealed_at: string; sha256: string; count: number } {
    if (fs.existsSync(clientPath(root, id))) throw new Error(`Refused: client comments for ${id} are already recorded, so these findings can no longer be blind. Calibrate a different item, or delete the calibration files and accept that the earlier run is void.`);
    if (fs.existsSync(sealedPath(root, id))) throw new Error(`Refused: ${id} is already sealed. A sealed list is not edited; that is what makes the comparison honest.`);
    if (!findings.length) throw new Error("Nothing to seal: derive the concerns first.");
    const rec = { work_item_id: id, sealed_at: new Date().toISOString(), sha256: hashOf(findings), findings };
    fs.mkdirSync(dir(root), { recursive: true });
    fs.writeFileSync(sealedPath(root, id), JSON.stringify(rec, null, 2));
    return { sealed_at: rec.sealed_at, sha256: rec.sha256, count: findings.length };
}

const STOP = new Set(("the and for with without from into when then that this have been should must does not are was were its their there which what who can could would may might also only just some any all each both more most other such than too very " +
    "user users code service services case cases make makes made need needs used use uses using true false null new old per via").split(" "));
export function tokens(s: string): Set<string> {
    const out = new Set<string>();
    for (const w of s.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-z0-9]+/)) if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w.replace(/(ing|ed|es|s)$/, ""));
    for (const m of s.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) for (const p of m[0].replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(" ")) if (p.length >= 4 && !STOP.has(p)) out.add(p.replace(/(ing|ed|es|s)$/, ""));
    return out;
}
export function similarity(a: string, b: string): number {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let n = 0; for (const t of A) if (B.has(t)) n++;
    return n / Math.min(A.size, B.size);
}

const isBlocking = (c?: string) => (c ? /^blocking/i.test(c) : null);

export function reveal(root: string, id: string, client: ClientComment[], overrides: Override[] = []): {
    pairings: Pairing[]; extras: number[]; derived: Derived[]; sealed_at: string; intact: boolean; parity: { derived: number; partial: number; missed: number; total: number; blocking_recall: string };
} {
    let rec: any;
    try { rec = JSON.parse(fs.readFileSync(sealedPath(root, id), "utf-8")); } catch { throw new Error(`Refused: ${id} has no sealed findings. Derive the concerns and seal them BEFORE the client comments are looked at.`); }
    const intact = hashOf(rec.findings) === rec.sha256;
    if (!intact) throw new Error(`Refused: the sealed findings for ${id} were changed after sealing (hash mismatch). The comparison would not be blind.`);
    if (!client.length) throw new Error("No client comments given.");
    const derived: Derived[] = rec.findings;
    if (!fs.existsSync(clientPath(root, id))) fs.writeFileSync(clientPath(root, id), JSON.stringify({ revealed_at: new Date().toISOString(), client }, null, 2));
    const pairings: Pairing[] = client.map((c, ci) => {
        const ov = overrides.find((o) => o.client === ci);
        if (ov) return { client: ci, derived: ov.derived, score: ov.derived === null ? 0 : similarity(c.text, `${derived[ov.derived]?.title} ${derived[ov.derived]?.text}`), verdict: ov.verdict, by: "reviewer", category_match: ov.derived === null ? null : isBlocking(c.category) === null ? null : isBlocking(c.category) === (derived[ov.derived]?.category === "BLOCKING") };
        let best = -1, bs = 0;
        derived.forEach((d, di) => { const s = similarity(c.text, `${d.title} ${d.entity ?? ""} ${d.text}`); if (s > bs) { bs = s; best = di; } });
        const verdict = bs >= 0.34 ? "DERIVED" : bs >= 0.2 ? "PARTIAL" : "MISSED";
        return { client: ci, derived: verdict === "MISSED" ? null : best, score: Math.round(bs * 100) / 100, verdict, by: "lexical", category_match: verdict === "MISSED" || isBlocking(c.category) === null ? null : isBlocking(c.category) === (derived[best].category === "BLOCKING") };
    });
    const used = new Set(pairings.map((p) => p.derived).filter((x): x is number => x !== null));
    const extras = derived.map((_, i) => i).filter((i) => !used.has(i));
    const count = (v: string) => pairings.filter((p) => p.verdict === v).length;
    const blocking = client.map((c, i) => ({ c, p: pairings[i] })).filter((x) => isBlocking(x.c.category));
    const bd = blocking.filter((x) => x.p.verdict === "DERIVED").length;
    return { pairings, extras, derived, sealed_at: rec.sealed_at, intact, parity: { derived: count("DERIVED"), partial: count("PARTIAL"), missed: count("MISSED"), total: client.length, blocking_recall: blocking.length ? `${bd}/${blocking.length}` : "n/a" } };
}

export function renderReveal(r: ReturnType<typeof reveal>, client: ClientComment[]): string {
    const L: string[] = [];
    L.push(`CALIBRATION: sealed ${r.sealed_at} (hash intact), ${r.derived.length} derived concern(s), ${client.length} client comment(s).`);
    L.push(`PARITY: ${r.parity.derived} derived, ${r.parity.partial} partial, ${r.parity.missed} missed of ${r.parity.total}. Blocking recall: ${r.parity.blocking_recall}.`);
    L.push("Matching is lexical and only PROPOSES pairings; confirm or override each one (pass `overrides`). A word overlap is not agreement.");
    r.pairings.forEach((p) => {
        const c = client[p.client];
        L.push("", `[${p.verdict}] client #${p.client + 1}${c.category ? ` (${c.category})` : ""}: ${c.text.replace(/\s+/g, " ").slice(0, 200)}`);
        if (p.derived !== null) { const d = r.derived[p.derived]; L.push(`    <- derived #${p.derived + 1} [${d.category}] ${d.title}  (score ${p.score}, ${p.by}${p.category_match === false ? ", SEVERITY DIFFERS" : ""})${d.derived_from ? `\n       derived from: ${d.derived_from}` : ""}`); }
        else L.push("    <- nothing derived matches. Write down WHY: which contract, transition or capability would have produced it?");
    });
    if (r.extras.length) { L.push("", "DERIVED BUT NOT RAISED BY THE CLIENT (extras: noise or additional findings):"); for (const i of r.extras) L.push(`- #${i + 1} [${r.derived[i].category}] ${r.derived[i].title}`); }
    return L.join("\n");
}
