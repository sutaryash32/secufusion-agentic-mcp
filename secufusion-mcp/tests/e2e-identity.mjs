import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").split(path.sep).join("/");
const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${SDK}/client/index.js`).href);
const { StdioClientTransport } = await import(pathToFileURL(`${SDK}/client/stdio.js`).href);

let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
};

function workspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2etmp-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, ".secufusion-project-spec.json"), JSON.stringify({ microservices: { a: {} } }));
    return dir;
}
async function connect(dir) {
    const c = new Client({ name: "e2e", version: "1" }, { capabilities: {} });
    await c.connect(new StdioClientTransport({ command: "node", args: [`${PKG}/mcp/dist/server.js`, "--root", dir], cwd: dir }));
    return c;
}
const call = async (c, name, args) => {
    const r = await c.callTool({ name, arguments: args });
    return { err: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
};
const PASS = { verdict: "PASS", why: "w", who: "PM", what: "s", risk: "r", questions_for_user: [] };
const TITLE = "Tenant deletion reports failure";

// ── BUG-1230 stays BUG-1230 across folder, intent file and messages ─────────
{
    const dir = workspace();
    const c = await connect(dir);
    const id = "BUG-1230";

    let r = await call(c, "resolve_work_item_ref", { work_item: id, title: `${id}: ${TITLE}` });
    const b = JSON.parse(r.text);
    check("resolve_work_item_ref returns the exact ref, folder, branch and commit prefix", b.ref === id && b.folder === "BUG-1230-tenant-deletion-reports-failure" && b.branch_suffix.startsWith("BUG-1230-") && b.commit_prefix === "BUG-1230: " && b.type_known === true, r.text);

    r = await call(c, "philosophy_check", { work_item_id: id, title: TITLE, description: "d", task_type: "bug", judgment: PASS });
    r = await call(c, "spec_create_intent", { work_item_id: id, title: TITLE, business_goal: "g", acceptance_criteria: ["AC1"] });
    const intents = fs.readdirSync(path.join(dir, ".secufusion", "intents"));
    check("intent file is 0001-BUG-1230-..., not 0001-WI-BUG-1230-...", intents.length === 1 && /^\d+-BUG-1230-/.test(intents[0]) && !intents[0].includes("WI-"), intents.join());
    r = await call(c, "spec_read_intent", { work_item_id: id });
    check("the intent is found again by BUG-1230", !r.err && r.text.includes("BUG-1230"), r.text.slice(0, 200));
    check("intent text never says WI-BUG-1230", !r.text.includes("WI-BUG-1230"));

    r = await call(c, "manage_task", { action: "initialize", work_item_id: id, title: `${id}: ${TITLE}`, task_type: "feature" });
    check("initialize succeeds and reports BUG-1230", !r.err && r.text.includes("Task BUG-1230 initialized") && !r.text.includes("WI-BUG-1230"), r.text.slice(0, 300));
    const folders = fs.readdirSync(path.join(dir, ".secufusion", "tasks"));
    check("task folder is BUG-1230-... even though task_type said 'feature'", folders.length === 1 && folders[0] === "BUG-1230-tenant-deletion-reports-failure", folders.join());
    check("no 'task-1230' anywhere on disk", ![...folders, ...intents].some((n) => /task-1230/i.test(n)));

    r = await call(c, "manage_task", { action: "read", work_item_id: id });
    check("task is read back by its exact reference", !r.err, r.text.slice(0, 200));
    r = await call(c, "manage_task", { action: "read", work_item_id: "1230" });
    check("a bare number finds the same task (and creates nothing)", !r.err && fs.readdirSync(path.join(dir, ".secufusion", "tasks")).length === 1, r.text.slice(0, 200));

    r = await call(c, "manage_task", { action: "initialize", work_item_id: "TASK-1230", title: TITLE });
    check("TASK-1230 is refused: ticket 1230 is registered as BUG-1230", r.err && r.text.includes("IDENTITY CONFLICT") && r.text.includes("BUG-1230"), r.text);
    check("the registry still says BUG-1230 and nothing was created", JSON.parse(fs.readFileSync(path.join(dir, ".secufusion", "registry.json"), "utf8")).every((e) => e.work_item_id === "BUG-1230") && fs.readdirSync(path.join(dir, ".secufusion", "tasks")).length === 1);
    r = await call(c, "resolve_work_item_ref", { work_item: "TASK-1230", title: TITLE });
    check("resolve_work_item_ref also reports the conflict", JSON.parse(r.text).identity_conflict?.includes("IDENTITY CONFLICT"), r.text);
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── every type, end to end ─────────────────────────────────────────────────
{
    const dir = workspace();
    const c = await connect(dir);
    let n = 2000;
    for (const t of ["TASK", "STORY", "FEATURE", "EPIC", "BUG"]) {
        const id = `${t}-${n++}`;
        await call(c, "philosophy_check", { work_item_id: id, title: TITLE, description: "d", task_type: "chore", judgment: PASS });
        await call(c, "spec_create_intent", { work_item_id: id, title: TITLE, business_goal: "g", acceptance_criteria: ["AC1"] });
        const r = await call(c, "manage_task", { action: "initialize", work_item_id: id, title: TITLE, task_type: "chore" });
        const ok = !r.err && fs.existsSync(path.join(dir, ".secufusion", "tasks", `${id}-tenant-deletion-reports-failure`));
        check(`${id}: folder ${id}-tenant-deletion-reports-failure created, type untouched`, ok, r.text.slice(0, 200));
    }
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── a task folder created by the old behaviour is still found ──────────────
{
    const dir = workspace();
    const tasks = path.join(dir, ".secufusion", "tasks", "Task-1230-tenant-deletion");
    fs.mkdirSync(tasks, { recursive: true });
    fs.writeFileSync(path.join(tasks, "spec.json"), JSON.stringify({ work_item_id: "1230", title: "T", status: "active" }));
    fs.writeFileSync(path.join(tasks, "progress.json"), "{}");
    fs.writeFileSync(path.join(dir, ".secufusion", "registry.json"), JSON.stringify([{ work_item_id: "1230", title: "T", status: "active", folder: "Task-1230-tenant-deletion" }]));
    const c = await connect(dir);
    let r = await call(c, "manage_task", { action: "read", work_item_id: "BUG-1230" });
    check("legacy Task-1230 folder is found for BUG-1230 (no duplicate created)", !r.err && fs.readdirSync(path.join(dir, ".secufusion", "tasks")).length === 1, r.text.slice(0, 300));
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
