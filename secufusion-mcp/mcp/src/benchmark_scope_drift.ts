import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { analyzeScopeDrift, classifyScope, renderScopeDrift, serviceOf } from "./scope_drift.js";

/** PR scope drift: files unrelated to the story are classified and REPORTED, never failed. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"];
const g = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const write = (root: string, rel: string, content: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

const SCHED = "sfn-events-api/src/main/java/com/x/RetentionScheduler.java";
const RECON = "sfn-events-api/src/main/java/com/x/ReconciliationJob.java";
const TESTF = "sfn-events-api/src/test/java/com/x/RetentionSchedulerTest.java";
const PROPS = "sfn-events-api/src/main/resources/application.properties";
const MIG = "sfn-events-api/src/main/resources/db/migration/V9__retention_lock.sql";
const DOCS = "sfn-events-api/README.md";
const NEIGH = "sfn-events-api/src/main/java/com/x/Clock.java";
const UNREL1 = "sfn-iam-api/src/main/java/com/x/UserFormatter.java";
const UNREL2 = "sfn-web-ui/src/Banner.jsx";

const STORY = {
    acceptance_criteria: ["Only one replica runs a retention job", "A ReconciliationJob converges every replica's timers with the database"],
    story_text: "Retention scheduler replica convergence. Add reconciliation so replicas agree.",
    planned_files: [SCHED],
};
const CHANGED = [SCHED, RECON, TESTF, PROPS, MIG, DOCS, NEIGH, UNREL1, UNREL2].map((file) => ({ file, lines: 10 }));

// ── classification ──────────────────────────────────────────────────────────
{
    const { classified, files } = classifyScope(CHANGED, STORY);
    const k = (f: string) => files.find((x) => x.file === f)!;
    check("a story is known, so files are classified", classified);
    check("CORE: a file in the plan, and a file named in the acceptance criteria", k(SCHED).klass === "CORE" && /plan's affected files/.test(k(SCHED).reason) && k(RECON).klass === "CORE" && /named in the story/.test(k(RECON).reason), JSON.stringify([k(SCHED), k(RECON)]));
    check("INDIRECT: the test of a core file, with the reason", k(TESTF).klass === "INDIRECT" && /test of the core file RetentionScheduler/.test(k(TESTF).reason), JSON.stringify(k(TESTF)));
    check("INDIRECT: configuration, a migration and documentation of the same service", k(PROPS).klass === "INDIRECT" && /configuration of the same service/.test(k(PROPS).reason) && k(MIG).klass === "INDIRECT" && /migration/.test(k(MIG).reason) && k(DOCS).klass === "INDIRECT" && /documentation/.test(k(DOCS).reason));
    check("INDIRECT: a neighbour in the same folder as a core file", k(NEIGH).klass === "INDIRECT" && /same folder as the core file/.test(k(NEIGH).reason), JSON.stringify(k(NEIGH)));
    check("UNRELATED: other services' files that nothing in the story mentions", k(UNREL1).klass === "UNRELATED" && k(UNREL2).klass === "UNRELATED", JSON.stringify([k(UNREL1), k(UNREL2)]));
    check("core_files supplied by the reviewer promote a file to CORE, with that reason", (() => { const r = classifyScope(CHANGED, { ...STORY, core_files: [UNREL1] }); const f = r.files.find((x) => x.file === UNREL1)!; return f.klass === "CORE" && /named by the reviewer/.test(f.reason); })());
    check("a lock file follows its manifest (related -> indirect, unrelated -> unrelated)", (() => {
        const web = classifyScope([{ file: "sfn-web-ui/package.json", lines: 3 }, { file: "sfn-web-ui/package-lock.json", lines: 900 }, ...CHANGED.slice(0, 1)], STORY).files;
        const rel = classifyScope([{ file: "sfn-events-api/package.json", lines: 3 }, { file: "sfn-events-api/package-lock.json", lines: 900 }, { file: SCHED, lines: 5 }], { ...STORY, core_files: ["sfn-events-api/package.json"] }).files;
        return web.find((f) => f.file.endsWith("lock.json"))!.klass === "UNRELATED" && rel.find((f) => f.file.endsWith("lock.json"))!.klass === "INDIRECT";
    })());
    check("serviceOf: the folder above src/, else the first folder", serviceOf("a/src/main/X.java") === "a" && serviceOf("web/index.js") === "web" && serviceOf("README.md") === "");
    const none = classifyScope(CHANGED, {});
    check("with no story information nothing is claimed: unclassified, not 'all unrelated' drift", !none.classified);
}

// ── in a real repository: uncommitted and committed files, untracked files, .secufusion ignored ──
{
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "scp-"));
    g(r, "init", "-q", "-b", "main");
    write(r, "README.md", "x\n"); g(r, "add", "-A"); g(r, "commit", "-q", "-m", "base");
    g(r, "checkout", "-q", "-b", "work");
    for (const f of CHANGED) write(r, f.file, "line\n");
    write(r, ".secufusion/tasks/x/spec.json", "{}");
    g(r, "add", "sfn-events-api", "sfn-iam-api"); g(r, "commit", "-q", "-m", "work");
    write(r, UNREL2, "banner\n"); // committed? no: untracked
    const headBefore = g(r, "rev-parse", "HEAD");
    const rep = analyzeScopeDrift(r, { base: "main", ...STORY });
    check("changed files come from git (committed plus untracked), and .secufusion is ignored", rep.files.length === CHANGED.length && !rep.files.some((f) => f.file.startsWith(".secufusion/")) && rep.files.some((f) => f.file === UNREL2), JSON.stringify(rep.files.map((f) => f.file)));
    check("counts: 2 core, 5 indirect, 2 unrelated", rep.counts.CORE === 2 && rep.counts.INDIRECT === 5 && rep.counts.UNRELATED === 2, JSON.stringify(rep.counts));
    const text = renderScopeDrift(rep);
    check("each UNRELATED file becomes a SCOPE DRIFT block in the specified format", (text.match(/^SCOPE DRIFT$/gm) ?? []).length === 2 && text.includes(`File: ${UNREL1}`) && text.includes("Does not contribute directly to:") && ["Acceptance Criteria", "Architecture Decision", "Bug Fix", "Product Requirement"].every((x) => text.includes(`- ${x}`)) && text.includes("Move to separate story or explain why included."), text.slice(0, 900));
    const driftBlocks = text.match(/^SCOPE DRIFT$[\s\S]*?(?=\n---\n|$(?![\s\S]))/gm) ?? [];
    check("only the two UNRELATED files get a SCOPE DRIFT block; core and indirect files get none", driftBlocks.length === 2 && driftBlocks.every((b) => b.includes(UNREL1) || b.includes(UNREL2)) && !driftBlocks.some((b) => b.includes(SCHED) || b.includes(TESTF) || b.includes(RECON)), JSON.stringify(driftBlocks.map((b) => b.slice(0, 80))));
    check("the three groups are listed in the specified order", text.indexOf("### CORE STORY FILES") < text.indexOf("### INDIRECTLY RELATED FILES") && text.indexOf("### INDIRECTLY RELATED FILES") < text.indexOf("### UNRELATED FILES"));
    check("it says plainly that it never fails the review, and speaks no verdict", /REPORTED ONLY: it never fails the review/.test(text) && !/CHANGES REQUESTED|BLOCKER|APPROVED/.test(text));
    check("without a story it classifies nothing and says how to fix that", (() => { const t = renderScopeDrift(analyzeScopeDrift(r, { base: "main" })); return /could not be classified against a story/.test(t) && /unclassified/.test(t) && !/^SCOPE DRIFT$/m.test(t); })());
    check("the scan is read-only", g(r, "rev-parse", "HEAD") === headBefore);
    fs.rmSync(r, { recursive: true, force: true });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "scp-"));
    check("not a git repository: a note, no crash", analyzeScopeDrift(plain).notes.some((n) => /Not a git repository/.test(n)));
    fs.rmSync(plain, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
