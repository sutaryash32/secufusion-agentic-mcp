#!/usr/bin/env node
/**
 * Fetch the client's review of a pull request from Azure DevOps, as a calibration answer key.
 *
 * Run it yourself, in your own terminal. The token is typed into a hidden prompt: it is NOT a command-line argument (that
 * would sit in your shell history and the process list) and it must never be pasted into a chat with the assistant (the
 * conversation transcript is stored on disk). It is held in memory for this run only, used for read-only requests, and
 * discarded when the run ends. Nothing about it is written anywhere.
 *
 *   node parity/tools/ado-fetch.mjs --pr-url https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>
 *   node parity/tools/ado-fetch.mjs --org https://dev.azure.com/<org> --project <p> --repo <r> --pr <id>
 *   (any missing value is asked for; --out <dir> sets where the files go, default .secufusion/parity/ado)
 *
 * Token scopes: Code (Read) and Work Items (Read). No write scope is needed or used.
 * For an unattended run the token may come from the environment variable AZURE_DEVOPS_PAT, which is removed from the
 * environment of this process as soon as it is read.
 *
 * Output: <out>/ado-<project>-<repo>-<pr>.client.json  the review comments (do NOT open it before you have sealed findings)
 *         <out>/ado-<project>-<repo>-<pr>.meta.json    counts, iterations, the pre-review commit (safe to show the reviewer)
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ado = await import(pathToFileURL(path.resolve(here, "../../mcp/dist/ado.js")).href);

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes("--pat")) { console.error("Refused: the token is never taken as an argument. Run without --pat and type it at the hidden prompt."); process.exit(2); }

function ask(q, secret = false) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl.stdoutMuted = false;
        rl._writeToOutput = (s) => { if (rl.stdoutMuted && !s.startsWith(q)) rl.output.write(s.includes("\n") ? "\n" : "*"); else rl.output.write(s); };
        rl.question(q, (a) => { rl.close(); if (secret) process.stdout.write("\n"); resolve(a); });
        rl.stdoutMuted = secret;
    });
}

let target = flag("pr-url") ? ado.parsePrUrl(flag("pr-url")) : null;
if (flag("pr-url") && !target) { console.error("That does not look like an Azure DevOps pull request URL."); process.exit(2); }
if (!target) {
    const org = flag("org") ?? (await ask("Azure DevOps organization URL (https://dev.azure.com/<org>): "));
    const project = flag("project") ?? (await ask("Project name: "));
    const repo = flag("repo") ?? (await ask("Repository name: "));
    const prArg = flag("pr") ?? (await ask("Pull request id or URL: "));
    const fromUrl = /^https?:/.test(prArg) ? ado.parsePrUrl(prArg) : null;
    target = fromUrl ?? { orgUrl: ado.normalizeOrg(org), project: project.trim(), repo: repo.trim(), pr: Number(prArg) };
}
if (!target.pr || !target.project || !target.repo) { console.error("Organization, project, repository and a pull request id are all needed."); process.exit(2); }

let pat = process.env.AZURE_DEVOPS_PAT;
delete process.env.AZURE_DEVOPS_PAT;
if (!pat) {
    if (!process.stdin.isTTY) { console.error("No terminal for a hidden prompt, and AZURE_DEVOPS_PAT is not set."); process.exit(2); }
    pat = await ask("Read-only personal access token (Code: Read, Work Items: Read; input is hidden): ", true);
}

const client = new ado.AdoClient(target.orgUrl, pat);
pat = null; // the client holds the only copy now
try {
    const review = await ado.fetchPullRequestReview(client, target);
    const out = path.resolve(flag("out") ?? ".secufusion/parity/ado");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, ".gitignore"), "*\n");
    const id = `ado-${target.project}-${target.repo}-${target.pr}`.replace(/[^\w.-]+/g, "_");
    const { comments, ...rest } = review;
    fs.writeFileSync(path.join(out, `${id}.client.json`), JSON.stringify({ review, benchmark: ado.adoBenchmark(review, id) }, null, 2));
    fs.writeFileSync(path.join(out, `${id}.meta.json`), JSON.stringify({ ...rest, comment_threads: comments.length }, null, 2));
    console.log(`\nPull request ${review.pr.id}: ${review.iterations.length} iteration(s), ${comments.length} review thread(s) stored, ${review.skipped.system} system and ${review.skipped.deleted} deleted comment(s) skipped, ${review.work_items.length} linked work item(s).`);
    console.log(`Pre-review commit: ${review.pre_review.commit}  (iteration ${review.pre_review.iteration}: ${review.pre_review.reason})`);
    console.log(`Comments are in ${path.join(out, id + ".client.json")}. Do not open it until your findings are sealed.`);
    console.log("Next: give the assistant the pre-review commit and the .meta.json path. The token has been discarded; nothing about it was written.");
} catch (e) {
    console.error("Failed: " + e.message);
    process.exitCode = 1;
} finally {
    client.discard();
}
