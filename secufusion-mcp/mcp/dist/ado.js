/** https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id} or https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{id} */
export function parsePrUrl(url) {
    const u = url.trim().replace(/\/+$/, "");
    let m = /^(https:\/\/dev\.azure\.com\/[^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i.exec(u);
    if (!m)
        m = /^(https:\/\/[^/.]+\.visualstudio\.com)\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i.exec(u);
    return m ? { orgUrl: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]), pr: Number(m[4]) } : null;
}
export function normalizeOrg(u) {
    const t = u.trim().replace(/\/+$/, "");
    if (/^https:\/\//i.test(t) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(t))
        return t; // plain http only for a local test server
    if (/^[\w-]+$/.test(t))
        return `https://dev.azure.com/${t}`;
    throw new Error("The organization URL must look like https://dev.azure.com/<organization>.");
}
export class AdoClient {
    orgUrl;
    doFetch;
    pat;
    constructor(orgUrl, pat, doFetch = fetch) {
        this.orgUrl = orgUrl;
        this.doFetch = doFetch;
        if (!pat?.trim())
            throw new Error("A personal access token is required.");
        this.pat = pat.trim();
    }
    /** Overwrites the token held by this client. Call when the benchmark is done. */
    discard() { this.pat = null; }
    async get(pathAndQuery) {
        if (!this.pat)
            throw new Error("The token was discarded; build a new client.");
        const url = `${this.orgUrl}/${pathAndQuery}`;
        let res;
        try {
            res = await this.doFetch(url, { method: "GET", headers: { Authorization: "Basic " + Buffer.from(":" + this.pat).toString("base64"), Accept: "application/json" } });
        }
        catch (e) {
            throw new Error(`Azure DevOps could not be reached for ${pathAndQuery.split("?")[0]}: ${String(e?.message ?? e).split(this.pat).join("***")}`);
        }
        if (!res.ok) {
            // the message never carries the token, the header or the response body
            const why = res.status === 401 || res.status === 403 ? " The token is missing a scope or expired: it needs Code (Read) and Work Items (Read)." : res.status === 404 ? " Check the organization, project, repository and pull request id." : "";
            throw new Error(`Azure DevOps answered ${res.status} for ${pathAndQuery.split("?")[0]}.${why}`);
        }
        return res.json();
    }
}
export function severityHint(text) {
    const t = text.trim().toLowerCase().replace(/^[\[(*_\s]+/, "");
    if (/^(non[- ]?blocking|nit|suggestion|optional|minor)\b/.test(t))
        return "NON-BLOCKING";
    if (/^(blocking|blocker|must|critical|major|required)\b/.test(t))
        return "BLOCKING";
    if (/^(question|q:)/.test(t))
        return "QUESTION";
    if (/^(decision|requires[_ -]?decision|needs? (a )?decision)\b/.test(t))
        return "REQUIRES_DECISION";
    return "UNSPECIFIED";
}
const API = "api-version=7.1";
export async function fetchPullRequestReview(client, t) {
    const base = `${encodeURIComponent(t.project)}/_apis/git/repositories/${encodeURIComponent(t.repo)}/pullRequests/${t.pr}`;
    const pr = await client.get(`${base}?${API}`);
    const iters = (await client.get(`${base}/iterations?${API}`)).value ?? [];
    const threads = (await client.get(`${base}/threads?${API}`)).value ?? [];
    const commitsRaw = (await client.get(`${base}/commits?${API}`)).value ?? [];
    let work_items = [];
    try {
        work_items = ((await client.get(`${base}/workitems?${API}`)).value ?? []).map((w) => ({ id: String(w.id), url: w.url }));
    }
    catch { /* linked work items are optional */ }
    const skipped = { system: 0, deleted: 0, empty_threads: 0 };
    const comments = [];
    for (const th of threads) {
        if (th.isDeleted) {
            skipped.deleted++;
            continue;
        }
        const live = (th.comments ?? []).filter((c) => {
            if (c.isDeleted) {
                skipped.deleted++;
                return false;
            }
            if (c.commentType && c.commentType !== "text") {
                skipped.system++;
                return false;
            }
            return !!String(c.content ?? "").trim();
        });
        if (!live.length) {
            skipped.empty_threads++;
            continue;
        }
        const first = live[0];
        comments.push({
            thread_id: th.id, status: String(th.status ?? "unknown"),
            file: th.threadContext?.filePath ?? null, line: th.threadContext?.rightFileStart?.line ?? th.threadContext?.leftFileStart?.line ?? null,
            published: th.publishedDate ?? first.publishedDate ?? "", text: String(first.content).trim(), severity_hint: severityHint(String(first.content)),
            discussion: live.slice(1).map((c) => String(c.content).trim()),
        });
    }
    comments.sort((a, b) => Date.parse(a.published) - Date.parse(b.published));
    const iterations = iters.map((i) => ({ id: i.id, created: i.createdDate, commit: i.sourceRefCommit?.commitId })).filter((i) => i.commit).sort((a, b) => a.id - b.id);
    if (!iterations.length)
        throw new Error("The pull request has no iterations with a source commit.");
    const firstAt = comments.length ? comments[0].published : null;
    // the pre-review commit: the last iteration created before the first human comment; otherwise the earliest iteration
    let pre = iterations[0], reason = firstAt ? "no iteration predates the first review comment; the earliest iteration is used (it may already contain changes the reviewer saw)" : "the pull request has no review comments; the earliest iteration is used";
    if (firstAt) {
        const before = iterations.filter((i) => Date.parse(i.created) <= Date.parse(firstAt));
        if (before.length) {
            pre = before[before.length - 1];
            reason = `the last iteration created before the first review comment (${firstAt})`;
        }
    }
    return {
        target: t, fetched_at: new Date().toISOString(),
        pr: { id: pr.pullRequestId ?? t.pr, title: pr.title ?? "", status: pr.status ?? "", source_branch: pr.sourceRefName ?? "", target_branch: pr.targetRefName ?? "", created: pr.creationDate ?? "" },
        iterations, pre_review: { iteration: pre.id, commit: pre.commit, reason }, first_comment_at: firstAt,
        comments, commits: commitsRaw.map((c) => ({ id: c.commitId, date: c.committer?.date ?? null })), work_items, skipped,
    };
}
/** The benchmark an ADO review yields: the review comments ARE the answer key. */
export function adoBenchmark(r, id) {
    const concerns = r.comments.map((c, i) => ({
        id: `C${String(i + 1).padStart(2, "0")}`, text: c.text, severity: c.severity_hint, kind: "implementation", entity: c.file ?? "(pull request level)",
        consequence: "(judged at reveal: the business consequence the comment states)", fixed_in_code: false, evidence_checks: [],
        source: `ADO PR ${r.pr.id} thread ${c.thread_id} (${c.status})${c.file ? ` ${c.file}${c.line ? ":" + c.line : ""}` : ""}`,
    }));
    return {
        id, purpose: "parity", title: `ADO PR ${r.pr.id}: ${r.pr.title}`, story_chain: r.work_items.map((w) => w.id), workspace_hint: `${r.target.project}/${r.target.repo}`,
        pre_fix_available: true, answer_key: `the review threads of ADO pull request ${r.pr.id} (canonical), fetched ${r.fetched_at}`,
        limitation: `Code under review is iteration ${r.pre_review.iteration} (${r.pre_review.commit.slice(0, 10)}): ${r.pre_review.reason}. Severity comes from a prefix in the comment text (Blocking:, Non-blocking:, Question:); comments without one are UNSPECIFIED.`,
        concerns,
    };
}
