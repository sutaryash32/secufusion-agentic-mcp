/**
 * Platform facts: do the facts the instructions rely on match the code?
 *
 * The reviewer is told "these are the topics, these are the services, these files exist". If that is stale, every review
 * built on it is wrong in a confident voice. This checks a markdown document (AGENTS.md, an architecture note) against the
 * workspace, in any language:
 *   - TOPICS    a table of message topics (| `topic` | producer | consumer |) against the topics the code actually produces and
 *               consumes (Kafka in Java, Kotlin, JavaScript, TypeScript, Python, C#, Go; topic names in properties and yaml);
 *               reports topics only in the document, topics only in the code, and services the code attributes differently;
 *   - PATHS     every file or folder the document names in backticks must exist somewhere in the workspace;
 *   - SERVICES  every service name the document lists (sfn-xxx style) against the folders present.
 * It reports a CONTRADICTION only where the code shows something concrete (file:line). Anything it cannot see (a topic name
 * built at runtime, a service in another repository) is reported as UNVERIFIED, never as wrong. READ-ONLY.
 */
import fs from "fs";
import path from "path";
const SKIP_DIR = new Set(["node_modules", "dist", "build", "target", ".git", ".idea", ".vscode", "coverage", "out", "bin", "obj", "vendor", "venv", ".venv", "__pycache__", ".next", ".gradle", ".secufusion"]);
const CODE = /\.(java|kt|kts|scala|js|jsx|mjs|cjs|ts|tsx|py|cs|go|rb|php|properties|ya?ml|json|toml)$/i;
const MANIFEST = /^(pom\.xml|build\.gradle(\.kts)?|package\.json|go\.mod|pyproject\.toml|requirements\.txt|Gemfile|composer\.json|Cargo\.toml|[^/]+\.csproj)$/;
const MAX_FILES = 20000, MAX_BYTES = 600_000;
const TOPIC_PATTERNS = [
    { re: /\bkafkaTemplate\s*\.\s*send\s*\(\s*["']([\w.\-]+)["']/g, role: "producer" },
    { re: /\bnew\s+ProducerRecord\s*<[^>]*>\s*\(\s*["']([\w.\-]+)["']/g, role: "producer" },
    { re: /\bproducer\s*\.\s*(?:send|produce)\s*\(\s*\{?[^)]*?topic\s*:\s*['"`]([\w.\-]+)['"`]/g, role: "producer" },
    { re: /\bproducer\s*\.\s*(?:send|produce)\s*\(\s*['"]([\w.\-]+)['"]/g, role: "producer" },
    { re: /\bProduceAsync\s*\(\s*["']([\w.\-]+)["']/g, role: "producer" },
    { re: /\bProducerMessage\s*\{[^}]*Topic\s*:\s*"([\w.\-]+)"/g, role: "producer" },
    { re: /\bkafka\.Message\s*\{[^}]*Topic\s*:\s*"([\w.\-]+)"/g, role: "producer" },
    { re: /@KafkaListener\s*\([^)]*?topics\s*=\s*\{?\s*"([\w.\-]+)"/g, role: "consumer" },
    { re: /\bconsumer\s*\.\s*subscribe\s*\(\s*\{[^}]*topics?\s*:\s*\[?\s*['"`]([\w.\-]+)['"`]/g, role: "consumer" },
    { re: /\b(?:KafkaConsumer|Consumer)\s*\(\s*['"]([\w.\-]+)['"]/g, role: "consumer" },
    { re: /\.\s*subscribe\s*\(\s*\[\s*['"]([\w.\-]+)['"]/g, role: "consumer" },
    { re: /\.\s*Subscribe\s*\(\s*"([\w.\-]+)"/g, role: "consumer" },
    { re: /\bConsumePartition\s*\(\s*"([\w.\-]+)"/g, role: "consumer" },
    { re: /\bGroupTopics\s*:\s*\[\]string\s*\{\s*"([\w.\-]+)"/g, role: "consumer" },
    { re: /\b(?:static\s+final\s+String|const\s+string|const|final\s+String|val|var)\s+\w*TOPIC\w*\s*(?::\s*\w+\s*)?=\s*["']([\w.\-]+)["']/gi, role: "declared" },
    { re: /^\s*[\w.\-]*topics?[\w.\-]*\s*[=:]\s*["']?([a-z0-9][\w.\-]{2,})["']?\s*$/gim, role: "declared" },
];
function walk(dir, out, budget) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        if (budget.n <= 0)
            return;
        if (e.isDirectory()) {
            if (!SKIP_DIR.has(e.name) && !e.isSymbolicLink())
                walk(path.join(dir, e.name), out, budget);
            continue;
        }
        out.push(path.join(dir, e.name));
        budget.n--;
    }
}
/** The service a file belongs to: the nearest ancestor folder holding a build manifest, else its first path segment. */
function serviceOf(root, file, manifestDirs) {
    let d = path.dirname(file);
    while (d.startsWith(root) && d !== root) {
        if (manifestDirs.has(d))
            return path.basename(d);
        d = path.dirname(d);
    }
    return path.relative(root, file).split(path.sep)[0] ?? "(root)";
}
export function parseDocTopics(md) {
    const out = [];
    md.replace(/\r\n/g, "\n").split("\n").forEach((l, i) => {
        const m = /^\|\s*`([a-z0-9][\w.\-]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(l);
        if (!m)
            return;
        const svc = (s) => [...s.matchAll(/`?\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b`?/g)].map((x) => x[1]).filter((x) => !/^(no|live|dead|self|fan|two|none)$/.test(x));
        out.push({ topic: m[1], producers: svc(m[2]), consumers: svc(m[3]), line: i + 1 });
    });
    return out;
}
export function checkPlatformFacts(root, docPath) {
    const rootAbs = path.resolve(root);
    const docAbs = path.resolve(rootAbs, docPath);
    if (!(docAbs === rootAbs || docAbs.startsWith(rootAbs + path.sep)))
        throw new Error("doc_path is outside the workspace root");
    if (!fs.existsSync(docAbs))
        throw new Error(`document not found: ${docPath}`);
    const md = fs.readFileSync(docAbs, "utf8");
    const files = [];
    walk(rootAbs, files, { n: MAX_FILES });
    const rel = (f) => path.relative(rootAbs, f).split(path.sep).join("/");
    const manifestDirs = new Set(files.filter((f) => MANIFEST.test(path.basename(f))).map((f) => path.dirname(f)));
    const notes = [];
    const findings = [];
    // ---- what the code does
    const uses = [];
    for (const f of files) {
        if (!CODE.test(f))
            continue;
        let text;
        try {
            if (fs.statSync(f).size > MAX_BYTES)
                continue;
            const b = fs.readFileSync(f);
            if (b.includes(0))
                continue;
            text = b.toString("utf8");
        }
        catch {
            continue;
        }
        if (!/[Tt]opic|TOPIC|[Kk]afka|[Pp]roduc|[Cc]onsum|[Ss]ubscribe|[Pp]ublish/.test(text))
            continue;
        const svc = serviceOf(rootAbs, f, manifestDirs);
        for (const p of TOPIC_PATTERNS) {
            p.re.lastIndex = 0;
            for (const m of text.matchAll(p.re)) {
                const line = text.slice(0, m.index ?? 0).split("\n").length;
                if (/^\s*(\/\/|\*|#)/.test(text.split("\n")[line - 1] ?? ""))
                    continue;
                uses.push({ topic: m[1], role: p.role, service: svc, file: rel(f), line });
            }
        }
    }
    const codeTopics = new Map();
    for (const u of uses) {
        if (!codeTopics.has(u.topic))
            codeTopics.set(u.topic, []);
        codeTopics.get(u.topic).push(u);
    }
    // ---- what the document says
    const docTopics = parseDocTopics(md);
    const where = (us) => us.slice(0, 4).map((u) => `${u.file}:${u.line} (${u.role}, ${u.service})`);
    for (const d of docTopics) {
        const us = codeTopics.get(d.topic);
        if (!us) {
            findings.push({ type: "TOPIC_ONLY_IN_DOC", severity: "UNVERIFIED", subject: d.topic, detail: `the document lists the topic (line ${d.line}) but no producer, consumer or declaration of it was found in the scanned code. It may be built at runtime, live in a repository that is not in this workspace, or be stale.`, evidence: [] });
            continue;
        }
        const prod = [...new Set(us.filter((u) => u.role === "producer").map((u) => u.service))];
        const cons = [...new Set(us.filter((u) => u.role === "consumer").map((u) => u.service))];
        const sameSet = (a, b) => b.every((x) => a.includes(x));
        if (prod.length && d.producers.length && !sameSet(d.producers, prod))
            findings.push({ type: "TOPIC_ROLE_MISMATCH", severity: "CONTRADICTION", subject: d.topic, detail: `the document says the producer is ${d.producers.join(", ")}; the code produces it from ${prod.join(", ")}`, evidence: where(us.filter((u) => u.role === "producer")) });
        if (cons.length && d.consumers.length && !sameSet(d.consumers, cons))
            findings.push({ type: "TOPIC_ROLE_MISMATCH", severity: "CONTRADICTION", subject: d.topic, detail: `the document says the consumer is ${d.consumers.join(", ")}; the code consumes it in ${cons.join(", ")}`, evidence: where(us.filter((u) => u.role === "consumer")) });
        if (cons.length && !d.consumers.length && /no live consumer|dead|none/i.test(md.split("\n")[d.line - 1] ?? ""))
            findings.push({ type: "TOPIC_ROLE_MISMATCH", severity: "CONTRADICTION", subject: d.topic, detail: `the document says there is no live consumer; the code consumes it in ${cons.join(", ")}`, evidence: where(us.filter((u) => u.role === "consumer")) });
    }
    for (const [topic, us] of codeTopics) {
        if (docTopics.some((d) => d.topic === topic))
            continue;
        if (us.every((u) => u.role === "declared") && us.length < 2)
            continue;
        findings.push({ type: "TOPIC_ONLY_IN_CODE", severity: "NOTE", subject: topic, detail: "the code produces or consumes this topic but the document does not list it", evidence: where(us) });
    }
    // ---- paths the document names
    const all = new Set();
    for (const f of files) {
        let p = rel(f);
        all.add(p);
        while (p.includes("/")) {
            p = p.slice(0, p.lastIndexOf("/"));
            all.add(p);
        }
    }
    const allArr = [...all];
    const tokens = new Set();
    for (const m of md.matchAll(/`([^`\n]{3,120})`/g)) {
        const tk = m[1].trim();
        if (/[<>{}*$|\s]|^https?:|^\/\/|^--|\.\.\./.test(tk))
            continue;
        if (/^[\w./\-]+$/.test(tk) && (tk.includes("/") || /\.(json|md|sql|ya?ml|xml|java|kt|ts|js|py|cs|go|rb|php|properties|gradle|toml)$/i.test(tk)))
            tokens.add(tk.replace(/^\.\//, "").replace(/\/$/, ""));
    }
    for (const tk of tokens) {
        if (tk.startsWith("/") || /^\$|CLAUDE_PLUGIN_ROOT/.test(tk))
            continue;
        if (!allArr.some((p) => p === tk || p.endsWith("/" + tk))) {
            findings.push({ type: "PATH_MISSING", severity: "UNVERIFIED", subject: tk, detail: "the document names this path but nothing in the workspace ends with it (it may live in another repository, or be generated at runtime, or be gone)", evidence: [] });
        }
    }
    // ---- services the document lists
    const dirs = new Set(files.map((f) => path.relative(rootAbs, f).split(path.sep)[0]));
    for (const d of new Set([...manifestDirs].map((x) => path.basename(x))))
        dirs.add(d);
    const docServices = new Set([...md.matchAll(/`?\b(sfn|snf)-[a-z0-9]+(?:-[a-z0-9]+)*\b`?/g)].map((m) => m[0].replace(/`/g, "")));
    for (const s of docServices) {
        if (![...dirs].some((d) => d === s || d.startsWith(s)))
            findings.push({ type: "SERVICE_NOT_IN_WORKSPACE", severity: "NOTE", subject: s, detail: "the document names this service but no folder with that name is in the workspace: it cannot be cross-checked here", evidence: [] });
    }
    if (!docTopics.length)
        notes.push("no topic table of the form | `topic` | producer | consumer | was found in the document: the topic check did not run");
    if (!uses.length)
        notes.push("no messaging code was recognised in the workspace: a topic named only in the document cannot be confirmed");
    notes.push("a CONTRADICTION always carries file:line evidence; UNVERIFIED means the scan could not see the other side, not that the document is wrong");
    const order = { CONTRADICTION: 0, UNVERIFIED: 1, NOTE: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    return { doc: rel(docAbs), topics_in_doc: docTopics.length, topics_in_code: codeTopics.size, services_in_workspace: [...new Set([...manifestDirs].map((x) => path.basename(x)))].sort(), findings, notes };
}
export function renderFacts(r) {
    const c = (s) => r.findings.filter((f) => f.severity === s).length;
    const out = [`# Platform facts: ${r.doc}`, `topics in the document ${r.topics_in_doc} · topics found in code ${r.topics_in_code} · CONTRADICTION ${c("CONTRADICTION")} · UNVERIFIED ${c("UNVERIFIED")} · NOTE ${c("NOTE")}`, ""];
    for (const f of r.findings) {
        out.push(`${f.severity.padEnd(13)} ${f.type}  ${f.subject}`, `    ${f.detail}`, ...f.evidence.map((e) => `      ${e}`));
    }
    out.push("", ...r.notes.map((n) => `note: ${n}`));
    return out.join("\n");
}
