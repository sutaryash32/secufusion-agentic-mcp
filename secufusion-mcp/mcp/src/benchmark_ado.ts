import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { AdoClient, parsePrUrl, normalizeOrg, fetchPullRequestReview, adoBenchmark, severityHint } from "./ado.js";

/** Azure DevOps as a calibration source: read-only, token never leaves memory, comments hidden until revealed. Mock server only. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const TOKEN = "SECRET-PAT-12345-abcdef";
const BASIC = "Basic " + Buffer.from(":" + TOKEN).toString("base64");

const T0 = "2026-10-10T09:00:00Z", T1 = "2026-10-11T09:00:00Z", REVIEW = "2026-10-12T09:00:00Z", T3 = "2026-10-13T09:00:00Z";
const routes: Record<string, any> = {
    "": { pullRequestId: 7, title: "Transfer ownership", status: "active", sourceRefName: "refs/heads/feature/x", targetRefName: "refs/heads/develop", creationDate: T0 },
    "/iterations": { value: [
        { id: 1, createdDate: T0, sourceRefCommit: { commitId: "aaa111" } }, { id: 2, createdDate: T1, sourceRefCommit: { commitId: "bbb222" } },
        { id: 3, createdDate: T3, sourceRefCommit: { commitId: "ccc333" } }] },
    "/threads": { value: [
        { id: 1, status: "active", publishedDate: REVIEW, threadContext: { filePath: "/src/UserService.java", rightFileStart: { line: 42 } }, comments: [
            { id: 1, content: "Blocking: the IT Admin can be deactivated through the user update.", commentType: "text", publishedDate: REVIEW },
            { id: 2, content: "Fixed in the next iteration.", commentType: "text", publishedDate: T3, parentCommentId: 1 }] },
        { id: 2, status: "closed", publishedDate: "2026-10-12T10:00:00Z", comments: [{ id: 1, content: "Non-blocking: rename this variable.", commentType: "text", publishedDate: "2026-10-12T10:00:00Z" }] },
        { id: 3, status: "unknown", publishedDate: REVIEW, comments: [{ id: 1, content: "Policy update", commentType: "system", publishedDate: REVIEW }] },
        { id: 4, status: "active", isDeleted: true, publishedDate: REVIEW, comments: [{ id: 1, content: "deleted thread", commentType: "text" }] },
        { id: 5, status: "active", publishedDate: "2026-10-12T11:00:00Z", comments: [{ id: 1, content: "Question: why is the tenant email not updated?", commentType: "text", publishedDate: "2026-10-12T11:00:00Z" }, { id: 2, content: "gone", commentType: "text", isDeleted: true }] },
    ] },
    "/commits": { value: [{ commitId: "aaa111", committer: { date: T0, name: "SOMEONE" } }, { commitId: "bbb222", committer: { date: T1 } }] },
    "/workitems": { value: [{ id: "1469", url: "https://x/1469" }, { id: "1657" }] },
};
const seen: Array<{ url: string; auth: string | undefined; method: string }> = [];
const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization, method: req.method ?? "" });
    if (req.headers.authorization !== BASIC) { res.statusCode = 401; res.end(`denied for ${req.headers.authorization}`); return; }
    const m = /^\/proj\/_apis\/git\/repositories\/repo\/pullRequests\/7(\/[a-z]+)?\?api-version=7\.1$/.exec(req.url ?? "");
    if (!m) { res.statusCode = 404; res.end("no"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(routes[m[1] ?? ""]));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as any).port;
const org = `http://127.0.0.1:${port}`;
const target = { orgUrl: org, project: "proj", repo: "repo", pr: 7 };

// ── parsing a pull request URL, and the organization ─────────────────────────
{
    const u = parsePrUrl("https://dev.azure.com/acme/My%20Project/_git/my-repo/pullrequest/123?_a=files");
    check("a dev.azure.com pull request URL yields organization, project, repository and id", u?.orgUrl === "https://dev.azure.com/acme" && u.project === "My Project" && u.repo === "my-repo" && u.pr === 123, JSON.stringify(u));
    check("a visualstudio.com pull request URL is understood", parsePrUrl("https://acme.visualstudio.com/Proj/_git/r/pullrequest/9")?.pr === 9);
    check("something that is not a pull request URL is rejected", parsePrUrl("https://example.com/x") === null);
    check("a bare organization name becomes its URL", normalizeOrg("acme") === "https://dev.azure.com/acme" && normalizeOrg("https://dev.azure.com/acme/") === "https://dev.azure.com/acme");
    check("plain http is refused for anything but a local test server", (() => { try { normalizeOrg("http://dev.azure.com/acme"); return false; } catch { return true; } })());
    check("severity comes from a prefix in the comment, never invented", severityHint("Blocking: x") === "BLOCKING" && severityHint("[Non-blocking] y") === "NON-BLOCKING" && severityHint("Question: z") === "QUESTION" && severityHint("Please rename") === "UNSPECIFIED");
}

// ── fetching the review ──────────────────────────────────────────────────────
const client = new AdoClient(org, TOKEN);
const review = await fetchPullRequestReview(client, target);
{
    check("every request is a read-only GET with Basic auth", seen.length >= 5 && seen.every((s) => s.method === "GET" && s.auth === BASIC));
    check("only the five read endpoints are used: pull request, iterations, threads, commits, linked work items", new Set(seen.map((s) => (/pullRequests\/7(\/[a-z]+)?\?/.exec(s.url) ?? [])[1] ?? "pr")).size === 5, JSON.stringify(seen.map((s) => s.url)));
    check("review threads become comments with file, line, status and a severity hint", review.comments.length === 3 && review.comments[0].text.startsWith("Blocking: the IT Admin") && review.comments[0].file === "/src/UserService.java" && review.comments[0].line === 42 && review.comments[0].severity_hint === "BLOCKING");
    check("replies stay with their thread as discussion", review.comments[0].discussion.length === 1 && /Fixed in the next iteration/.test(review.comments[0].discussion[0]));
    check("system comments, deleted threads and deleted replies are skipped and counted", review.skipped.system === 1 && review.skipped.deleted >= 2 && !review.comments.some((c) => /Policy update|deleted thread|gone/.test(c.text + c.discussion.join())), JSON.stringify(review.skipped));
    check("the pre-review commit is the last iteration created before the first review comment", review.pre_review.iteration === 2 && review.pre_review.commit === "bbb222" && /before the first review comment/.test(review.pre_review.reason), JSON.stringify(review.pre_review));
    check("commits keep id and date only, not authors; linked work items are listed", review.commits.every((c) => Object.keys(c).sort().join() === "date,id") && review.work_items.length === 2 && !JSON.stringify(review).includes("SOMEONE"));
    const bm = adoBenchmark(review, "ado-proj-repo-7");
    check("the review comments become the answer key of a parity benchmark with pre-review code", bm.purpose === "parity" && bm.pre_fix_available && bm.concerns.length === 3 && bm.concerns[0].severity === "BLOCKING" && /canonical/.test(bm.answer_key) && /iteration 2/.test(bm.limitation));
    const early = await fetchPullRequestReview(client, target).then(() => null);
    void early;
}

// ── the token ────────────────────────────────────────────────────────────────
{
    const bad = new AdoClient(org, "WRONG-TOKEN-999");
    let msg = ""; try { await bad.get("proj/_apis/git/repositories/repo/pullRequests/7?api-version=7.1"); } catch (e: any) { msg = e.message; }
    check("a rejected token gives a scope hint and never echoes the token, the header or the body", /401/.test(msg) && /Code \(Read\) and Work Items \(Read\)/.test(msg) && !msg.includes("WRONG-TOKEN-999") && !msg.includes(Buffer.from(":WRONG-TOKEN-999").toString("base64")) && !/denied for/.test(msg), msg);
    let nf = ""; try { await client.get("proj/_apis/git/repositories/nope/pullRequests/7?api-version=7.1"); } catch (e: any) { nf = e.message; }
    check("a missing pull request says what to check", /404/.test(nf) && /organization, project, repository/.test(nf));
    check("the review object carries no token and no credentials", !JSON.stringify(review).includes(TOKEN) && !JSON.stringify(review).includes(BASIC) && !/Authorization/i.test(JSON.stringify(review)));
    client.discard();
    let after = ""; try { await client.get("proj/_apis/git/repositories/repo/pullRequests/7?api-version=7.1"); } catch (e: any) { after = e.message; }
    check("after discard() the client cannot make another request", /discarded/.test(after));
    check("a missing token is refused", (() => { try { new AdoClient(org, "  "); return false; } catch { return true; } })());
}

// ── the user-run CLI: no token argument, no terminal, no leak ─────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../parity/tools/ado-fetch.mjs");
const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile("node", [cli, ...args], { env: { ...process.env, AZURE_DEVOPS_PAT: "", ...env }, cwd: os.tmpdir(), timeout: 60000 }, (e: any, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out, err }));
    child.stdin?.end();
});
{
    const refused = await run(["--pat", TOKEN, "--pr-url", "https://dev.azure.com/a/p/_git/r/pullrequest/1"]);
    check("a token on the command line is refused, and not echoed", refused.code === 2 && /never taken as an argument/.test(refused.err) && !(refused.out + refused.err).includes(TOKEN));
    const noTty = await run(["--org", org, "--project", "proj", "--repo", "repo", "--pr", "7"]);
    check("without a terminal and without AZURE_DEVOPS_PAT there is nothing to prompt: it stops", noTty.code === 2 && /No terminal for a hidden prompt/.test(noTty.err));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "adoout-"));
    const ok = await run(["--org", org, "--project", "proj", "--repo", "repo", "--pr", "7", "--out", out], { AZURE_DEVOPS_PAT: TOKEN });
    check("a run with the token in the environment succeeds", ok.code === 0 && /3 review thread\(s\) stored/.test(ok.out), ok.out + ok.err);
    const files = fs.readdirSync(out);
    const client2 = files.find((f) => f.endsWith(".client.json")), meta = files.find((f) => f.endsWith(".meta.json"));
    check("the comments and the metadata are written to separate files, with a .gitignore that ignores everything", !!client2 && !!meta && fs.readFileSync(path.join(out, ".gitignore"), "utf-8").trim() === "*");
    const all = files.map((f) => fs.readFileSync(path.join(out, f), "utf-8")).join("\n") + ok.out + ok.err;
    check("the token appears in no output file, no stdout and no stderr", !all.includes(TOKEN) && !all.includes(BASIC));
    check("stdout shows counts and the pre-review commit, never a comment", /Pre-review commit: bbb222/.test(ok.out) && !/IT Admin can be deactivated|rename this variable/.test(ok.out + ok.err));
    const metaTxt = fs.readFileSync(path.join(out, meta!), "utf-8");
    check("the metadata file holds no comment text", !/deactivated|rename this variable|tenant email/.test(metaTxt) && JSON.parse(metaTxt).pre_review.commit === "bbb222" && JSON.parse(metaTxt).comment_threads === 3);
    check("the client file holds the comments for the reveal", /IT Admin can be deactivated/.test(fs.readFileSync(path.join(out, client2!), "utf-8")));
}

server.close();
process.exit(failures ? 1 : 0);
