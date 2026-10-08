import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { analyzeDiffQuality, detectLineEndings, applyAcknowledgements, blockingFindings, renderFindingBlocks, } from "./diff_quality.js";
import { fixLineEndings } from "./line_ending_fix.js";
/**
 * Deterministic tests for diff quality / line-ending awareness. Every scenario builds a real
 * temporary git repository so .gitattributes, autocrlf and rename detection behave as in production.
 */
// Isolate from the developer's git configuration.
const emptyCfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dqcfg-")), "gitconfig");
fs.writeFileSync(emptyCfg, "");
process.env.GIT_CONFIG_GLOBAL = emptyCfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
let failures = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond)
        failures++;
}
const tmpDirs = [];
function sh(cwd, ...args) { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString(); }
function repo(opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dqrepo-"));
    tmpDirs.push(dir);
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.name", "t");
    sh(dir, "config", "user.email", "t@t");
    sh(dir, "config", "core.autocrlf", opts.autocrlf ?? "false");
    sh(dir, "config", "core.safecrlf", "false");
    return dir;
}
function put(dir, rel, content) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
}
function commit(dir, msg = "c") { sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", msg); }
const lines = (n, eol, edit) => Array.from({ length: n }, (_, i) => (edit ? edit(i) : `const value${i} = compute(${i});`)).join(eol) + eol;
const run = (dir, files) => analyzeDiffQuality(dir, { files });
const find = (r, name) => r.findings.find((f) => f.finding === name);
const names = (r) => r.findings.map((f) => f.finding).join(",") || "none";
// ── file-state detection ────────────────────────────────────────────────────
{
    check("detect: LF only", detectLineEndings(Buffer.from("a\nb\n")).state === "LF");
    check("detect: CRLF only", detectLineEndings(Buffer.from("a\r\nb\r\n")).state === "CRLF");
    const m = detectLineEndings(Buffer.from("a\r\nb\nc\r\nd\r\n"));
    check("detect: mixed with counts and minority line", m.state === "MIXED" && m.crlf === 3 && m.lf === 1 && m.minority_kind === "LF" && m.minority_lines[0] === 2, JSON.stringify(m));
    check("detect: no newline", detectLineEndings(Buffer.from("single line")).state === "NONE");
    check("detect: empty", detectLineEndings(Buffer.alloc(0)).state === "NONE");
    check("detect: lone CR", detectLineEndings(Buffer.from("a\rb\r")).state === "CR" && detectLineEndings(Buffer.from("a\rb\n")).state === "MIXED");
    check("detect: binary is N/A", detectLineEndings(Buffer.from([0x89, 0x50, 0, 1, 2])).state === "N/A");
}
// ── no false positives on consistent files ──────────────────────────────────
{
    const d = repo();
    put(d, "a.ts", lines(100, "\n"));
    put(d, "b.ts", lines(100, "\r\n"));
    commit(d);
    put(d, "a.ts", lines(100, "\n", (i) => (i === 10 ? "const changed = 1;" : `const value${i} = compute(${i});`)));
    put(d, "b.ts", lines(100, "\r\n", (i) => (i === 10 ? "const changed = 1;" : `const value${i} = compute(${i});`)));
    const r = run(d);
    check("LF-only file, small change: no findings", r.findings.length === 0, names(r));
    check("CRLF-only file, small change: no findings (CRLF is not a defect)", r.findings.length === 0 && r.files.find((f) => f.file === "b.ts").disk.state === "CRLF");
    const f = r.files.find((x) => x.file === "b.ts");
    check("real code change with normal line endings: 1 line of churn, classified CODE_CHANGE", f.churn.raw === 1 && f.churn.semantic === 1 && f.classifications.includes("CODE_CHANGE"), JSON.stringify(f.churn));
}
// ── configured conventions ──────────────────────────────────────────────────
{
    const d = repo();
    put(d, ".gitattributes", "* text eol=lf\n");
    put(d, "a.ts", lines(60, "\n"));
    commit(d);
    put(d, "a.ts", lines(60, "\n", (i) => (i === 3 ? "x;" : `const value${i} = compute(${i});`)));
    check("repo configured LF (.gitattributes) + LF file: no findings", run(d).findings.length === 0, names(run(d)));
    const d2 = repo();
    put(d2, ".editorconfig", "root = true\n[*]\nend_of_line = crlf\n");
    put(d2, "a.ts", lines(60, "\r\n"));
    commit(d2);
    put(d2, "a.ts", lines(60, "\r\n", (i) => (i === 3 ? "x;" : `const value${i} = compute(${i});`)));
    check("repo configured CRLF (.editorconfig) + CRLF file: no findings", run(d2).findings.length === 0, names(run(d2)));
    const d3 = repo();
    put(d3, ".editorconfig", "root = true\n[*]\nend_of_line = lf\n");
    put(d3, "a.ts", lines(60, "\n"));
    commit(d3);
    put(d3, "a.ts", lines(60, "\r\n", (i) => (i === 3 ? "x;" : `const value${i} = compute(${i});`)));
    const r3 = run(d3);
    check("file flipped against configured LF: convention mismatch reported", !!find(r3, "LINE_ENDING_CONVENTION_MISMATCH") || !!find(r3, "LINE_ENDING_CHANGE"), names(r3));
    const d4 = repo();
    put(d4, ".editorconfig", "root = true\n[*]\nend_of_line = lf\n");
    put(d4, ".gitattributes", "*.ts eol=crlf\n");
    put(d4, "a.ts", lines(60, "\n"));
    commit(d4);
    put(d4, "a.ts", lines(60, "\n", (i) => (i === 3 ? "x;" : `const value${i} = compute(${i});`)));
    const r4 = run(d4);
    const conflict = find(r4, "CONVENTION_SOURCES_DISAGREE");
    check("conflicting config (.editorconfig vs .gitattributes): reported, not resolved", !!conflict && conflict.classification === "REPOSITORY_CONFIGURATION_ISSUE" && conflict.evidence.includes(".editorconfig") && conflict.evidence.includes(".gitattributes"), names(r4));
    const d5 = repo();
    put(d5, ".editorconfig", "root = true\n[*]\nend_of_line = lf\n[sub/*.ts]\nend_of_line = crlf\n");
    put(d5, "sub/a.ts", lines(60, "\r\n"));
    commit(d5);
    put(d5, "sub/a.ts", lines(60, "\r\n", (i) => (i === 3 ? "x;" : `const value${i} = compute(${i});`)));
    check("editorconfig section override honoured (sub/*.ts = crlf)", run(d5).findings.length === 0, names(run(d5)));
    const d6 = repo();
    put(d6, ".prettierrc", '{ "endOfLine": "crlf" }\n');
    put(d6, "a.ts", lines(60, "\n"));
    commit(d6);
    put(d6, "a.ts", lines(60, "\n", (i) => (i === 3 ? "x;" : `const value${i} = compute(${i});`)));
    const r6 = run(d6);
    check("prettier endOfLine=crlf vs LF file with LF history: config/history disagreement is reported as repo config issue", !!find(r6, "CONFIG_DISAGREES_WITH_FILE_HISTORY"), names(r6));
}
// ── config explains many files: one finding, not N ─────────────────────────
{
    const d = repo();
    put(d, ".editorconfig", "root = true\n[*]\nend_of_line = lf\n");
    for (let i = 0; i < 5; i++)
        put(d, `src/f${i}.ts`, lines(30, "\r\n"));
    commit(d);
    for (let i = 0; i < 5; i++)
        put(d, `src/f${i}.ts`, lines(30, "\r\n", (k) => (k === 2 ? "x;" : `const value${k} = compute(${k});`)));
    const r = run(d);
    const cfg = r.findings.filter((f) => f.finding === "CONFIG_DISAGREES_WITH_FILE_HISTORY");
    check("5 files, one repo-wide cause: a single deduplicated finding listing all 5", cfg.length === 1 && cfg[0].files?.length === 5 && r.findings.length === 1, `${r.findings.length} findings: ${names(r)}`);
}
// ── mixed line endings ──────────────────────────────────────────────────────
{
    const d = repo();
    put(d, "a.ts", lines(60, "\r\n"));
    commit(d);
    put(d, "a.ts", lines(60, "\r\n").replace(/\r\n/, "\n") + "// added\n");
    const r = run(d);
    const mix = find(r, "MIXED_LINE_ENDINGS");
    check("LF lines added to a CRLF file: MIXED_LINE_ENDINGS, introduced, severity MEDIUM", !!mix && mix.severity === "MEDIUM" && mix.evidence.includes("minority LF") && mix.recommendation.startsWith("Restore"), JSON.stringify(mix));
    check("mixed finding states expected vs actual", !!mix && mix.expected.includes("CRLF") && mix.actual.startsWith("MIXED"));
    check("mixed file classified MIXED_LINE_ENDINGS", r.files[0].classifications.includes("MIXED_LINE_ENDINGS"));
    const d2 = repo();
    put(d2, "a.ts", lines(200, "\r\n"));
    commit(d2);
    const half = lines(200, "\r\n").split("\r\n");
    const out = half.map((l, i) => (i < 100 ? l + "\n" : l + "\r\n")).join("").replace(/\r\n$/, "\r\n");
    put(d2, "a.ts", out);
    const r2 = run(d2);
    check("half the file converted: mixed AND churn, introduced mix with line-ending noise is HIGH", find(r2, "MIXED_LINE_ENDINGS")?.severity === "HIGH", names(r2) + " " + JSON.stringify(r2.files[0].churn));
    const d3 = repo();
    put(d3, "a.ts", "a\r\nb\nc\r\nd\r\n" + lines(60, "\r\n"));
    commit(d3);
    put(d3, "a.ts", "a\r\nb\nc\r\nd\r\n" + lines(60, "\r\n", (i) => (i === 1 ? "x;" : `const value${i} = compute(${i});`)));
    check("mixed already at base: reported LOW as pre-existing, not demanded in this PR", find(run(d3), "MIXED_LINE_ENDINGS")?.severity === "LOW" && find(run(d3), "MIXED_LINE_ENDINGS").recommendation.includes("Pre-existing"));
    const d4 = repo();
    put(d4, "README.md", "x\n");
    commit(d4);
    put(d4, "new.ts", "a\r\nb\nc\r\n");
    check("new untracked mixed file is analyzed", !!find(run(d4), "MIXED_LINE_ENDINGS"));
}
// ── line-ending-only diff / the client scenario ────────────────────────────
{
    const d = repo();
    put(d, "big.ts", lines(1100, "\r\n"));
    commit(d);
    put(d, "big.ts", lines(1100, "\n"));
    const r = run(d);
    const f = find(r, "LINE_ENDING_CHANGE");
    check("whole-file CRLF→LF, no code change: LINE_ENDING_CHANGE, HIGH, 1100 lines of pure noise", !!f && f.severity === "HIGH" && r.files[0].churn.semantic === 0 && r.files[0].churn.raw === 1100, JSON.stringify(r.files[0].churn));
    check("pure line-ending change is classified LINE_ENDING_CHANGE, not CODE_CHANGE", r.files[0].classifications.includes("LINE_ENDING_CHANGE") && !r.files[0].classifications.includes("CODE_CHANGE"));
    const d2 = repo();
    put(d2, "big.ts", lines(1100, "\r\n"));
    commit(d2);
    put(d2, "big.ts", lines(1100, "\n", (i) => (i === 5 || i === 500 || i === 900 ? `const edited${i} = true;` : `const value${i} = compute(${i});`)));
    const r2 = run(d2);
    const f2 = find(r2, "LINE_ENDING_CHANGE");
    check("3-line change shown as ~1100: reported, with the real change separated out", !!f2 && f2.severity === "HIGH" && r2.files[0].churn.raw === 1100 && r2.files[0].churn.semantic === 3, JSON.stringify(r2.files[0].churn));
    check("the recommendation is to restore style and reapply only the change", !!f2 && f2.recommendation === "Restore the original file style/line endings and reapply only the intended changes.");
    check("it is both CODE_CHANGE and LINE_ENDING_CHANGE", r2.files[0].classifications.includes("CODE_CHANGE") && r2.files[0].classifications.includes("LINE_ENDING_CHANGE"));
    check("blocks render in the sfn-review FINDING format", renderFindingBlocks(r2).includes("FINDING 10A — LINE_ENDING: LINE_ENDING_CHANGE") && renderFindingBlocks(r2).includes("Severity: BLOCKER (HIGH)"));
    const d3 = repo();
    put(d3, "small.ts", lines(5, "\r\n"));
    commit(d3);
    put(d3, "small.ts", lines(5, "\n"));
    check("tiny file fully converted: MEDIUM (pure, not disproportionate)", find(run(d3), "LINE_ENDING_CHANGE")?.severity === "MEDIUM");
    const d4 = repo();
    put(d4, "big.ts", lines(300, "\r\n"));
    put(d4, ".gitattributes", "# none\n");
    commit(d4);
    put(d4, "big.ts", lines(300, "\n"));
    put(d4, ".gitattributes", "* text eol=lf\n");
    check("normalization alongside a .gitattributes change: INFO, 'keep it in its own commit'", find(run(d4), "LINE_ENDING_NORMALIZATION")?.severity === "INFO" && find(run(d4), "LINE_ENDING_NORMALIZATION").recommendation.includes("own commit"), names(run(d4)));
}
// ── autocrlf: measure what would be committed ───────────────────────────────
{
    const d = repo({ autocrlf: "true" });
    put(d, "a.ts", lines(300, "\r\n"));
    commit(d);
    put(d, "a.ts", lines(300, "\r\n", (i) => (i === 3 ? "x;" : `const value${i} = compute(${i});`)));
    const r = run(d);
    check("autocrlf=true, CRLF on disk, LF in index: no false positive", r.findings.length === 0, names(r));
    check("autocrlf is surfaced in the notes", r.notes.some((n) => n.includes("autocrlf=true")));
}
// ── whitespace / formatting / encoding / EOF ────────────────────────────────
{
    const d = repo();
    put(d, "a.ts", lines(120, "\n", (i) => `\t\tconst value${i} = compute(${i});`));
    commit(d);
    put(d, "a.ts", lines(120, "\n", (i) => `    const value${i} = compute(${i});`));
    const r = run(d);
    check("tabs→spaces re-indent of the whole file: WHITESPACE_CHURN HIGH", find(r, "WHITESPACE_CHURN")?.severity === "HIGH" && r.files[0].churn.semantic === 0, names(r) + JSON.stringify(r.files[0].churn));
    const d2 = repo();
    put(d2, "a.ts", lines(120, "\n", (i) => `const value${i} = compute(${i});   `));
    commit(d2);
    put(d2, "a.ts", lines(120, "\n"));
    check("mass trailing-whitespace strip: WHITESPACE_CHURN", !!find(run(d2), "WHITESPACE_CHURN"));
    const d3 = repo();
    const longLines = Array.from({ length: 80 }, (_, i) => `foo(argumentNumber${i}, otherArgument${i}, third${i});`);
    put(d3, "a.ts", longLines.join("\n") + "\n");
    commit(d3);
    put(d3, "a.ts", longLines.map((l) => l.replace("(", "(\n  ").replace(", ", ",\n  ").replace(");", "\n);")).join("\n") + "\n");
    const r3 = run(d3);
    check("re-wrapped code, same tokens: FORMAT_REWRITE", !!find(r3, "FORMAT_REWRITE"), names(r3) + JSON.stringify(r3.files[0].churn));
    const d4 = repo();
    put(d4, "a.ts", lines(40, "\n"));
    commit(d4);
    put(d4, "a.ts", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines(40, "\n"))]));
    check("BOM added: ENCODING_CHANGE", !!find(run(d4), "ENCODING_CHANGE"));
    const d5 = repo();
    put(d5, "a.ts", lines(40, "\n"));
    commit(d5);
    put(d5, "a.ts", lines(40, "\n").replace(/\n$/, ""));
    check("final newline removed: EOF_NEWLINE_CHANGE LOW", find(run(d5), "EOF_NEWLINE_CHANGE")?.severity === "LOW");
    const d6 = repo();
    put(d6, "run.sh", "#!/bin/sh\r\necho hi\r\n");
    commit(d6);
    put(d6, "run.sh", "#!/bin/sh\r\necho hello\r\n");
    check("shebang script with CRLF: HIGH even though consistent", find(run(d6), "SHEBANG_WITH_CRLF")?.severity === "HIGH");
}
// ── exclusions ──────────────────────────────────────────────────────────────
{
    const d = repo();
    put(d, "base.txt", "x\n");
    commit(d);
    put(d, "dist/bundle.js", "a\r\nb\nc\r\n");
    put(d, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    put(d, "gen.ts", "// @generated by tool\r\nx\ny\r\n");
    put(d, "package-lock.json", '{\r\n"a":1\n}\r\n');
    put(d, ".gitattributes", "*.dat -text\n");
    put(d, "x.dat", "a\r\nb\nc\r\n");
    put(d, "big.txt", Buffer.alloc(3 * 1024 * 1024, 0x61));
    const r = run(d);
    const skipped = Object.fromEntries(r.files.filter((f) => f.status === "SKIPPED").map((f) => [f.file, f.skip_reason]));
    check("vendor/dist, binary, @generated, lockfile, -text attribute are excluded", ["dist/bundle.js", "logo.png", "gen.ts", "package-lock.json", "x.dat"].every((k) => skipped[k]), JSON.stringify(skipped));
    check("excluded files produce no findings", !r.findings.some((f) => ["dist/bundle.js", "logo.png", "gen.ts", "package-lock.json", "x.dat"].includes(f.file)), names(r));
    check("oversized file is reported as skipped, never silently passed", /larger than/.test(skipped["big.txt"] ?? ""), JSON.stringify(skipped));
}
// ── renames ─────────────────────────────────────────────────────────────────
{
    const d = repo();
    put(d, "old/name.ts", lines(300, "\r\n"));
    commit(d);
    fs.mkdirSync(path.join(d, "new"), { recursive: true });
    sh(d, "mv", "old/name.ts", "new/name.ts");
    put(d, "new/name.ts", lines(300, "\r\n", (i) => (i === 7 ? "x;" : `const value${i} = compute(${i});`)));
    const r = run(d);
    check("rename + 1-line edit is not reported as a 300-line change", r.findings.length === 0 && r.files.find((f) => f.file === "new/name.ts")?.churn?.raw === 1, names(r) + JSON.stringify(r.files.map((f) => f.churn)));
}
// ── empty / no-newline files ────────────────────────────────────────────────
{
    const d = repo();
    put(d, "e.txt", "");
    put(d, "s.txt", "one line");
    commit(d);
    put(d, "e.txt", "hello");
    put(d, "s.txt", "one line, edited");
    const r = run(d);
    check("empty and single-line files: no crash, no findings, state NONE", r.findings.length === 0 && r.files.every((f) => f.disk?.state === "NONE"), names(r));
}
// ── non-git degrade ─────────────────────────────────────────────────────────
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dqplain-"));
    tmpDirs.push(dir);
    put(dir, "m.ts", "a\r\nb\nc\r\n");
    put(dir, "ok.ts", "a\nb\n");
    const r = run(dir, ["m.ts", "ok.ts"]);
    check("no git: says so, still detects mixed, makes no diff-noise claims", !r.git && r.notes.some((n) => n.includes("Not a git repository")) && !!find(r, "MIXED_LINE_ENDINGS") && !r.findings.some((f) => f.category === "WHITESPACE"), names(r));
}
// ── acknowledgement ─────────────────────────────────────────────────────────
{
    const d = repo();
    put(d, "big.ts", lines(500, "\r\n"));
    commit(d);
    put(d, "big.ts", lines(500, "\n"));
    const r = run(d);
    check("HIGH finding blocks until acknowledged", blockingFindings(r.findings).length === 1);
    applyAcknowledgements(r.findings, [{ file: "big.ts", finding: "LINE_ENDING_CHANGE", user_statement: "  " }]);
    check("an acknowledgement without the user's words does nothing", blockingFindings(r.findings).length === 1);
    applyAcknowledgements(r.findings, [{ file: "big.ts", finding: "LINE_ENDING_CHANGE", user_statement: "Yes, we are normalizing on purpose" }]);
    check("acknowledged with the user's words: no longer blocking, still reported", blockingFindings(r.findings).length === 0 && r.findings[0].acknowledged === true);
}
// ── convert back to the file's own style ────────────────────────────────────
{
    const stripCr = (b) => Buffer.from(b.filter((x) => x !== 13));
    const d = repo();
    put(d, "a.ts", lines(80, "\r\n"));
    commit(d);
    const mixed = lines(80, "\r\n").replace(/\r\n/g, (m, off) => (off === 0 ? m : m)) + "// inserted by an LF editor\n// and another\n";
    put(d, "a.ts", mixed);
    check("scenario: CRLF file + LF insertions is detected as mixed", !!find(run(d), "MIXED_LINE_ENDINGS"));
    const before = fs.readFileSync(path.join(d, "a.ts"));
    const preview = fixLineEndings(d, "a.ts");
    check("preview: would convert 2 LF lines to CRLF using the file's own style, writes nothing", preview.ok && !preview.applied && preview.lines_changed === 2 && preview.target === "crlf" && /base|HEAD|\w/.test(preview.target_source ?? "") && fs.readFileSync(path.join(d, "a.ts")).equals(before), JSON.stringify(preview));
    check("target came from the file's history, not a guess", (preview.target_source ?? "").startsWith("file's style at"), preview.target_source);
    const done = fixLineEndings(d, "a.ts", { apply: true });
    const after = fs.readFileSync(path.join(d, "a.ts"));
    check("apply: file is now consistent CRLF", done.applied && detectLineEndings(after).state === "CRLF", JSON.stringify(done));
    check("only line terminators changed (content identical ignoring CR)", stripCr(after).equals(stripCr(before)));
    check("the diff-quality finding is gone after the fix", run(d).findings.length === 0, names(run(d)));
    check("running it again is a no-op", fixLineEndings(d, "a.ts", { apply: true }).applied === false);
    // BOM and missing final newline are preserved
    const d2 = repo();
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\nc\nd")]);
    put(d2, ".gitattributes", "*.txt eol=crlf\n");
    put(d2, "x.txt", body);
    commit(d2);
    const r2 = fixLineEndings(d2, "x.txt", { apply: true });
    const out2 = fs.readFileSync(path.join(d2, "x.txt"));
    check("BOM and the absence of a final newline are preserved", r2.applied && out2.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && out2.toString("utf-8").endsWith("c\r\nd") && !out2.toString("utf-8").endsWith("\n"), JSON.stringify(out2.toString("utf-8")));
    // repo configuration outranks history
    const d3 = repo();
    put(d3, ".editorconfig", "root = true\n[*]\nend_of_line = lf\n");
    put(d3, "m.ts", "a\r\nb\nc\n");
    commit(d3);
    const r3 = fixLineEndings(d3, "m.ts");
    check("repo config (.editorconfig lf) decides the target", r3.target === "lf" && (r3.target_source ?? "").includes(".editorconfig"), JSON.stringify(r3));
    // refuses to guess
    const d4 = repo();
    put(d4, "seed.txt", "x\n");
    commit(d4);
    put(d4, "new.ts", "a\r\nb\nc\r\n");
    const r4 = fixLineEndings(d4, "new.ts");
    check("no convention anywhere: refuses and asks for an explicit target", !r4.ok && /pass target explicitly/.test(r4.reason ?? ""), JSON.stringify(r4));
    check("explicit target works", fixLineEndings(d4, "new.ts", { target: "crlf", apply: true }).applied && detectLineEndings(fs.readFileSync(path.join(d4, "new.ts"))).state === "CRLF");
    const d5 = repo();
    put(d5, ".editorconfig", "root = true\n[*]\nend_of_line = lf\n");
    put(d5, ".gitattributes", "*.ts eol=crlf\n");
    put(d5, "m.ts", "a\r\nb\nc\n");
    commit(d5);
    check("conflicting repo config: refuses instead of choosing", !fixLineEndings(d5, "m.ts").ok && fixLineEndings(d5, "m.ts", { target: "lf" }).ok);
    // safety refusals
    const d6 = repo();
    put(d6, "dist/o.js", "a\r\nb\n");
    put(d6, "p.png", Buffer.from([0, 1, 2]));
    put(d6, "cr.txt", "a\rb\rc\n");
    put(d6, "ok.ts", "a\r\nb\n");
    commit(d6);
    check("path traversal is refused", fixLineEndings(d6, "../outside.ts", { target: "lf", apply: true }).reason === "path is outside the repository");
    check(".git is refused", !fixLineEndings(d6, ".git/config", { target: "lf", apply: true }).ok);
    check("generated/vendor and binary files are refused", !fixLineEndings(d6, "dist/o.js", { target: "lf" }).ok && !fixLineEndings(d6, "p.png", { target: "lf" }).ok);
    check("lone-CR files are refused rather than reinterpreted", /lone CR/.test(fixLineEndings(d6, "cr.txt", { target: "lf" }).reason ?? ""));
    check("missing file is refused", !fixLineEndings(d6, "nope.ts", { target: "lf" }).ok);
}
for (const d of tmpDirs)
    fs.rmSync(d, { recursive: true, force: true });
console.log(failures === 0 ? "\nDIFF QUALITY BENCHMARK: ALL PASS" : `\nDIFF QUALITY BENCHMARK: ${failures} FAILED`);
process.exit(failures ? 1 : 0);
