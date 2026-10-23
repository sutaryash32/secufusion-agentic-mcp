import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * The reasoning tools through the real server: the matrix asks the model to REASON about the top cells (the judgment
 * protocol), the model's verdicts are verified against the code before they count, nothing is written to the workspace,
 * and the claims ledger adds what the product requires but the story never said.
 */
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").split(path.sep).join("/");
const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${SDK}/client/index.js`).href);
const { StdioClientTransport } = await import(pathToFileURL(`${SDK}/client/stdio.js`).href);
const { createEntry } = await import(pathToFileURL(`${PKG}/mcp/dist/project_knowledge.js`).href);

let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + String(detail).slice(0, 400)}`);
    if (!cond) failures++;
};
const write = (root, rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "reason-"));
createEntry(ws, { category: "invariants", title: "Exactly one IT Admin per tenant", body: "A tenant always has exactly one active IT Admin.", tags: ["it-admin", "tenant", "ownership", "owner"], source: "BUG-1288", status: "accepted", extra: { fields: "defaultUser", enforcement: "code check only" } });
createEntry(ws, { category: "decisions", title: "Previous owner keeps their groups", body: "Decided.", tags: ["ownership", "transfer", "groups"], source: "UD-8", status: "accepted" });
write(ws, "svc/UserService.java", `package x;
public class UserService {
    public void transferOwnership(String tenantId, Long newOwner) {
        owner.setDefaultUser(false);
        next.setDefaultUser(true);
    }
    public void deleteUser(Long id) {
        repo.deleteById(id);
    }
}
`);
write(ws, "svc/Guard.java", "class Guard {\n  void ensureOwner(Tenant t) { requireSingleActiveOwner(t); }\n}\n");

const c = new Client({ name: "reasoning", version: "1" }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: "node", args: [`${PKG}/mcp/dist/server.js`, "--root", ws], cwd: PKG }));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { text: r.content[0].text, error: !!r.isError }; };

const args = {
    workspace_root: ws,
    entry_points: [{ name: "POST /owners/transfer", inputs: [{ name: "newOwnerId", type: "uuid" }], operations: ["transfer"], writes_data: true }],
    story_text: "Transfer ownership of the tenant to another user. The new owner becomes the IT Admin.",
    entities: ["User"], flags: ["defaultUser"], terms: ["ownership"],
};

// 1. ask the model to reason: the server gathers evidence and asks, it does not decide
const ask = await call("build_edge_matrix", { ...args, reason_top: 3 });
check("reasoning: the matrix asks the model to reason about the top cells and says what it must return", /JUDGMENT REQUIRED/.test(ask.text) && /edge-reasoning/.test(ask.text) && /"verdicts"/.test(ask.text) && /Rubric/.test(ask.text) && /judgment/.test(ask.text), ask.text.slice(0, 300));
check("reasoning: the request carries the product rule and the code, not just a label", /Exactly one IT Admin per tenant/.test(ask.text) && /code check only/.test(ask.text) && /\.mcp\/invariants/.test(ask.text) && /deleteUser|repo\.deleteById/.test(ask.text));
check("reasoning: asking writes nothing to the workspace (no stored judgment)", !fs.existsSync(path.join(ws, ".secufusion")));

// 2. the model answers: one good verdict, one with a fabricated citation, one honest UNKNOWN
const ids = [...new Set([...ask.text.matchAll(/"cell_id": "(E[0-9a-f]+x*)"/g)].map((m) => m[1]))];
check("reasoning: three cells were put to the model, highest risk first", ids.length === 3, ids.join());
const judgment = JSON.stringify({ verdicts: [
    { cell_id: ids[0], verdict: "HOLDS", reasoning: "transferOwnership and deleteUser both go through ensureOwner, which requires a single active owner before the write.", evidence: [{ file: "svc/Guard.java", line: 2, quote: "requireSingleActiveOwner(t)" }] },
    { cell_id: ids[1], verdict: "HOLDS", reasoning: "the delete path is guarded by the transaction isolation level in the repository.", evidence: [{ file: "svc/UserService.java", line: 8, quote: "repo.deleteWithOwnerGuard(id)" }] },
    { cell_id: ids[2], verdict: "UNKNOWN", reasoning: "enforcement may exist as a database constraint that is not in this workspace; I need the live schema." },
] });
const done = await call("build_edge_matrix", { ...args, reason_top: 3, judgment, format: "json" });
const r = JSON.parse(done.text);
const byId = (id) => [...r.gaps, ...r.weak, ...r.deferred, ...r.unanswered, ...r.high_risk_unanswered].find((x) => x.id === id);
check("reasoning: a verdict whose evidence is in the code is accepted, and that cell leaves the high-risk list", !r.high_risk_unanswered.some((x) => x.id === ids[0]) && !byId(ids[0])?.problem && r.attention.high_risk_sound >= 1, JSON.stringify(r.attention));
check("reasoning: a 'holds' backed by a fabricated citation is NOT accepted: it is deferred, never covered", r.deferred.some((x) => x.id === ids[1]) && !r.high_risk_unanswered.some((x) => x.id === ids[1]) && r.notes.some((n) => /no evidence that survived the check/.test(n)), r.notes.join(" | "));
check("reasoning: an honest UNKNOWN is kept open as a question for a person, not turned into an answer", r.deferred.some((x) => x.id === ids[2]));
check("reasoning: the report says who reasoned and that the citations were checked", r.notes.some((n) => /calling model/.test(n) && /checked against the code/.test(n)));
check("reasoning: judging writes nothing to the workspace even after a verdict", !fs.existsSync(path.join(ws, ".secufusion")));

// 3. a verdict that breaks the schema is refused with the shape, nothing is applied
const bad = await call("build_edge_matrix", { ...args, reason_top: 3, judgment: JSON.stringify({ verdicts: [{ cell_id: ids[0], verdict: "MAYBE", reasoning: "x" }] }) });
check("reasoning: a verdict that does not match the schema is refused", /does not match the required schema/.test(bad.text));

// 4. violated verdict becomes a gap with its scenario
const viol = JSON.parse((await call("build_edge_matrix", { ...args, reason_top: 1, format: "json", judgment: JSON.stringify({ verdicts: [{ cell_id: ids[0], verdict: "VIOLATED", reasoning: "deleteUser calls repo.deleteById directly and never reaches ensureOwner, so the guard transferOwnership relies on is skipped.", scenario: "the IT Admin is deleted by an admin; the tenant is left with no active owner", evidence: [{ file: "svc/UserService.java", line: 8, quote: "repo.deleteById(id)" }] }] }) })).text);
check("reasoning: a VIOLATED verdict with verified evidence becomes a confirmed gap carrying its scenario", viol.gaps.length === 1 && /no active owner/.test(viol.gaps[0].reasoning), JSON.stringify(viol.gaps));

// 5. the ledger adds what the story never said
const led = JSON.parse((await call("build_claims_ledger", { workspace_root: ws, story_text: args.story_text, entities: ["User"], flags: ["defaultUser"], terms: ["ownership"], format: "json" })).text);
const kinds = led.claims.map((x) => x.kind);
check("ledger: besides what the story says it adds IMPLIED claims from the project's invariants and decisions, with their source", kinds.includes("acceptance") && led.claims.some((x) => x.kind === "implied" && /Exactly one IT Admin/.test(x.text) && /\.mcp\/invariants/.test(x.source ?? "")), JSON.stringify(led.claims.map((x) => [x.kind, x.text.slice(0, 40)])));
check("ledger: and SILENT claims for lifecycle paths that exist and the story never mentions", led.claims.some((x) => x.kind === "silent" && /User delete/.test(x.text) && /UserService\.java:\d+/.test(x.source ?? "")));
check("ledger: with no evidence yet, none of the product's requirements are shown as satisfied", led.claims.filter((x) => x.kind === "implied" || x.kind === "silent").every((x) => x.status === "UNVERIFIED"));

await c.close();
console.log(failures === 0 ? "\nAll reasoning-tool checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
