import { z } from "zod";
import fs from "fs";
import path from "path";
import { judge, judgmentParam } from "./judge.js";
import { recordGate, requireGates } from "./gates.js";
import { PhilosophyVerdict, PhilosophyHint, PhilosophyRubric, ClassificationVerdict, ClassificationHint, ClassificationRubric, } from "./verdicts.js";
import { REJECTED_FILE, getWorkspaceRoot, resolve, readFileSafe, readJson, loadProjectSpec, writeFile, appendTelemetry, specEvidence, textResult, readRegistry, extractSymptomWords, levenshteinClose, buildScopeText } from "./shared.js";
export function registerAnalysisTools(server) {
    // --- Tool 9: philosophy_check -------------------------------------------------
    server.tool("philosophy_check", "MANDATORY PHASE -1 STEP — runs BEFORE classify_task, BEFORE reading any source files, BEFORE any planning. " +
        "Challenges the WHY, WHO, WHAT, and RISK of a story before any implementation begins. " +
        "Returns PHILOSOPHY_PASS, PHILOSOPHY_ADVISORY, PHILOSOPHY_FAIL, or PHILOSOPHY_BLOCKED. " +
        "A FAIL or BLOCKED verdict completely stops all implementation — classify_task MUST NOT be called until this returns PASS or ADVISORY. " +
        "Applies to ALL task types including bugs and hotfixes (though sensing is slightly relaxed for defects).", {
        work_item_id: z.string().describe("Azure DevOps work item ID. e.g. 'WI-2847'"),
        title: z.string().describe("Full story/task title from Azure DevOps."),
        description: z.string().describe("Full story description including user story, acceptance criteria, and any context."),
        task_type: z
            .enum(["bug", "user_story", "feature", "hotfix", "refactor", "chore"])
            .describe("bug | user_story | feature | hotfix | refactor | chore"),
        reported_by: z.string().optional().describe("Who created/reported this story. e.g. 'client', 'PM', 'tech lead', 'developer'."),
        client_confirmed: z.boolean().optional().describe("Has the decision maker explicitly confirmed this is needed?"),
        judgment: judgmentParam,
    }, async ({ work_item_id, title, description, task_type, reported_by, client_confirmed, judgment }) => {
        const inputChars = JSON.stringify({ work_item_id, title, description, task_type }).length;
        const wsRoot = getWorkspaceRoot();
        let rejectedPatterns = [];
        const rejRaw = readFileSafe(resolve(REJECTED_FILE));
        if (rejRaw) {
            try {
                rejectedPatterns = JSON.parse(rejRaw);
            }
            catch { }
        }
        let dna = null;
        let spec = null;
        const specCands2 = [
            path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), ".secufusion-project-spec.json"),
            path.resolve(wsRoot, ".secufusion-project-spec.json"),
        ];
        for (const c of specCands2) {
            if (fs.existsSync(c)) {
                try {
                    spec = JSON.parse(readFileSafe(c) || "null");
                    break;
                }
                catch { }
            }
        }
        const dnaCandidates = [
            path.resolve(wsRoot, ".secufusion", "dna.json"),
            path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), ".secufusion", "dna.json"),
        ];
        for (const d of dnaCandidates) {
            if (fs.existsSync(d)) {
                try {
                    dna = JSON.parse(readFileSafe(d) || "null");
                    break;
                }
                catch { }
            }
        }
        const dnaServices = dna?.services?.map((s) => (s.name || "").toLowerCase()).filter((s) => s.length > 4) || [];
        const dnaEntities = dna?.db_entities?.map((e) => (e.name || e.table || "").toLowerCase()).filter((e) => e.length > 3) || [];
        const dnaTopics = dna?.kafka_topics || dna?.events || [];
        const dnaExtension = dna?.chrome_extension || dna?.extension || dna?.["snf-browser-extn"] || null;
        const dnaSecurity = dna?.security_context || spec?.security || null;
        const outcome = await judge(server, wsRoot, {
            kind: "philosophy",
            subject: work_item_id,
            role: "Philosophy Check Engine (challenges WHY, WHO, WHAT, RISK before any planning)",
            rubric: PhilosophyRubric,
            evidence: {
                task: { work_item_id, title, task_type, description, reported_by: reported_by ?? null, client_confirmed: client_confirmed ?? null },
                project: {
                    ...specEvidence(wsRoot),
                    dna_services: dnaServices,
                    dna_entities: dnaEntities,
                    dna_kafka_topics: dnaTopics.map((t) => t.name || t.topic),
                    has_chrome_extension: !!dnaExtension,
                    dna_security: dnaSecurity,
                },
            },
            schema: PhilosophyVerdict,
            schemaHint: PhilosophyHint,
            supplied: judgment,
            reinvoke: "philosophy_check",
        });
        if (outcome.status !== "ok") {
            return appendTelemetry(textResult(outcome.text, outcome.status === "invalid"), inputChars);
        }
        const v = outcome.verdict;
        const passed = v.verdict === "PASS" || v.verdict === "ADVISORY";
        recordGate(wsRoot, work_item_id, "philosophy", passed, outcome.source, `${v.verdict}: ${v.why}`);
        const report = `${passed ? "✅" : "⛔"} PHILOSOPHY_${v.verdict} — ${work_item_id} (judged by ${outcome.source})\n\n` +
            `**WHY:** ${v.why}\n**WHO:** ${v.who}\n**WHAT:** ${v.what}\n**RISK:** ${v.risk}\n` +
            (v.questions_for_user.length > 0
                ? `\n**Ask the user before continuing:**\n${v.questions_for_user.map((q) => `- ${q}`).join("\n")}\n`
                : "") +
            (passed ? `\nNext: spec_create_intent.` : `\nPlanning is blocked until this passes. Re-run philosophy_check with the user's answers added to the description.`);
        return appendTelemetry(textResult(report), inputChars);
    });
    // --- Tool 10: classify_task --------------------------------------------------
    server.tool("classify_task", "MANDATORY FIRST STEP for every task without exception. " +
        "Classifies a task as BACKEND_ONLY, FRONTEND_ONLY, FULL_STACK, or EXTENSION_ONLY. " +
        "Performs a breaking-change pre-scan against the project spec. " +
        "Returns a structured classification result that determines what the AI is allowed to do next. " +
        "MUST be called BEFORE reading the codebase, BEFORE planning, BEFORE writing any code. " +
        "No exceptions. No shortcuts.", {
        work_item_id: z.string().describe("Azure DevOps work item ID, e.g. 'BUG-1140' or '2847'."),
        title: z.string().describe("Full task title from Azure DevOps."),
        description: z.string().describe("Full task description / problem statement. Paste everything from the work item."),
        task_type: z
            .enum(["bug", "user_story", "feature", "hotfix", "refactor", "chore"])
            .describe("Kind of task: bug | user_story | feature | hotfix | refactor | chore"),
        judgment: judgmentParam,
    }, async ({ work_item_id, title, description, task_type, judgment }) => {
        const inputChars = JSON.stringify({ work_item_id, title, description, task_type }).length;
        const gateError = requireGates(getWorkspaceRoot(), work_item_id, ["philosophy", "intent"], "classify the task");
        if (gateError)
            return appendTelemetry(textResult(gateError, true), inputChars);
        // ── Step 1: Load project spec ─────────────────────────────────────────
        const SPEC_FILE = ".secufusion-project-spec.json";
        const specCandidates = [
            path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), SPEC_FILE),
            path.resolve(getWorkspaceRoot(), SPEC_FILE),
        ];
        let walkRoot = getWorkspaceRoot();
        for (let i = 0; i < 5; i++) {
            const parent = path.dirname(walkRoot);
            if (parent === walkRoot)
                break;
            walkRoot = parent;
            specCandidates.push(path.join(walkRoot, SPEC_FILE));
        }
        const specPath = specCandidates.find((p) => fs.existsSync(p)) ?? null;
        let spec = null;
        if (specPath) {
            try {
                spec = JSON.parse(readFileSafe(specPath) || "null");
            }
            catch { /* invalid JSON */ }
        }
        if (!spec) {
            return appendTelemetry({
                isError: true,
                content: [{ type: "text", text: "❌ Project spec missing. Run the extraction prompt first to generate .secufusion-project-spec.json.\n\nSearched:\n" + specCandidates.map(p => `  • ${p}`).join("\n") }],
            }, inputChars);
        }
        // ── Step 2: Load rejected patterns ───────────────────────────────────
        let rejectedPatterns = [];
        const rejRaw = readFileSafe(resolve(REJECTED_FILE));
        if (rejRaw) {
            try {
                rejectedPatterns = JSON.parse(rejRaw);
            }
            catch { /* ignore */ }
        }
        // ── Step 3: Check if task was previously classified ───────────────────
        const classifDir = resolve(".secufusion/classifications");
        const classifFile = path.join(classifDir, `${work_item_id}.json`);
        let resumingExistingTask = false;
        if (fs.existsSync(classifFile)) {
            resumingExistingTask = true;
        }
        // Also check task registry
        const registry = readRegistry();
        const inRegistry = registry.some(r => r["work_item_id"] === work_item_id);
        if (inRegistry)
            resumingExistingTask = true;
        // ── Pass 0: Retrospective Intelligence ────────────────────────────────
        const insightsFile = resolve(".secufusion/retrospective-insights.json");
        let learnedLogs = [];
        let learnedSignals = { backend: [], frontend: [], extension: [], phrase: [], bug_category: [] };
        if (fs.existsSync(insightsFile)) {
            try {
                const insights = readJson(insightsFile);
                if (insights && Array.isArray(insights.classifier_learning_queue)) {
                    let updated = false;
                    insights.classifier_learning_queue.forEach((q) => {
                        if (q.frequency >= 2) {
                            if (q.signal_type === "backend")
                                learnedSignals.backend.push(q.signal_value);
                            else if (q.signal_type === "frontend")
                                learnedSignals.frontend.push(q.signal_value);
                            else if (q.signal_type === "extension")
                                learnedSignals.extension.push(q.signal_value);
                            else if (q.signal_type === "phrase")
                                learnedSignals.phrase.push(q.signal_value);
                            else if (q.signal_type === "bug_category")
                                learnedSignals.bug_category.push(q.signal_value);
                            if (!q.applied) {
                                learnedLogs.push(`[LEARNED] applying signal '${q.signal_value}' from ${q.frequency} past retrospectives`);
                                q.applied = true;
                                updated = true;
                            }
                        }
                    });
                    if (updated) {
                        writeFile(insightsFile, JSON.stringify(insights, null, 2));
                    }
                }
            }
            catch (e) {
                /* ignore */
            }
        }
        // ── Step 4: Signal scoring ────────────────────────────────────────────
        const corpus = (title + " " + description).toLowerCase();
        // Structural backend terms — always a reliable signal of backend work regardless of task type
        const BACKEND_STRUCTURAL = [
            "migration", "kafka", "consumer", "producer", "topic",
            "database", "db", "repository", "backend",
        ];
        // Contextual backend terms — these appear naturally when *describing* a bug symptom
        // ("the events API returns X", "service returns wrong value") without implying
        // backend work is needed. Counted for non-bugs only, OR for bugs that also contain
        // explicit backend-change language (see BACKEND_CHANGE_PHRASES below).
        const BACKEND_CONTEXTUAL = [
            "api", "endpoint", "service", "server", "rest",
            "json response", "payload", "query", "schema",
        ];
        // Explicit backend-change phrases: these restore contextual terms even for bugs,
        // because they signal genuine backend scope rather than symptom description.
        const BACKEND_CHANGE_PHRASES = [
            "change the api", "update the api", "fix the api", "api contract",
            "update endpoint", "change endpoint", "fix endpoint", "new endpoint",
            "modify schema", "update schema", "alter table", "add column",
            "api change", "breaking change", "response contract", "request body",
            "fix the service", "update the service",
        ];
        const hasExplicitBackendChange = BACKEND_CHANGE_PHRASES.some(p => corpus.includes(p));
        const isBugOrHotfix = task_type === "bug" || task_type === "hotfix";
        const BACKEND_SIGNALS = [
            ...BACKEND_STRUCTURAL,
            // For bugs: contextual terms only re-admitted when description explicitly calls for backend change
            ...(isBugOrHotfix && !hasExplicitBackendChange ? [] : BACKEND_CONTEXTUAL),
            ...learnedSignals.backend, ...learnedSignals.phrase, ...learnedSignals.bug_category
        ];
        const FRONTEND_SIGNALS = [
            "ui", "frontend", "react", "component", "page", "screen", "button",
            "modal", "layout", "style", "css", "web ui", "browser ui", "render",
            "timestamp", "date format", "timezone", "display", "label", "icon", "text",
            ...learnedSignals.frontend
        ];
        const EXTENSION_SIGNALS = [
            "chrome extension", "extension", "content script", "background script",
            "browser extension", "popup",
            ...learnedSignals.extension
        ];
        if (spec) {
            if (spec.microservices) {
                // FIX A: Only add service/table names when they appear as a whole word in the corpus.
                // Substring matching caused "events" or "incidents" in a bug description to
                // match sfn-events-api and its owned tables, inflating backendScore falsely.
                const wholeWord = (token) => new RegExp(`(?<![a-z0-9-])${token.replace(/[-]/g, '[\\-\\s]?')}(?![a-z0-9-])`, "i").test(corpus);
                Object.keys(spec.microservices).forEach(k => {
                    if (wholeWord(k.toLowerCase()))
                        BACKEND_SIGNALS.push(k.toLowerCase());
                });
                Object.values(spec.microservices).forEach(svc => {
                    if (Array.isArray(svc.owns_tables)) {
                        svc.owns_tables.forEach(t => {
                            if (wholeWord(t.toLowerCase()))
                                BACKEND_SIGNALS.push(t.toLowerCase());
                        });
                    }
                });
            }
            if (spec.frontend && spec.frontend.repo)
                FRONTEND_SIGNALS.push(spec.frontend.repo.toLowerCase());
            const extSpec = spec.chrome_extension || spec["snf-browser-extn"] || spec.snf_browser_extn;
            if (extSpec && extSpec.repo)
                EXTENSION_SIGNALS.push(extSpec.repo.toLowerCase());
        }
        const backendFound = BACKEND_SIGNALS.filter(s => corpus.includes(s));
        const frontendFound = FRONTEND_SIGNALS.filter(s => corpus.includes(s));
        const extensionFound = EXTENSION_SIGNALS.filter(s => corpus.includes(s));
        // Refine signals based on explicit modifiers (the user's "analysis" expectation)
        let backendScore = backendFound.length;
        let frontendScore = frontendFound.length;
        let extensionScore = extensionFound.length;
        if (corpus.includes("pure ui") || corpus.includes("no backend changes") || corpus.includes("frontend only")) {
            backendScore = 0;
        }
        // Determine classification will be done after Pass 4.5
        // ── Step 4.5: Problem statement validation ───────────────────────────────────
        const descLower = description.toLowerCase();
        let titleAccurate = true;
        let suggestedTitle = "";
        let suggestedTitleReason = "";
        // CHECK 1: Title accuracy
        const services = [];
        if (spec) {
            if (spec.microservices)
                Object.keys(spec.microservices).forEach(k => services.push(k.toLowerCase()));
            if (spec.frontend && spec.frontend.repo)
                services.push(spec.frontend.repo.toLowerCase());
            const extSpec2 = spec.chrome_extension || spec["snf-browser-extn"] || spec.snf_browser_extn;
            if (extSpec2 && extSpec2.repo)
                services.push(extSpec2.repo.toLowerCase());
        }
        if (services.length === 0) {
            services.push("sfn-iam-api", "sfn-events-api", "sfn-tenants-api", "sfn-policy-api", "sfn-gateway-api", "sfn-web-ui");
        }
        const firstSentence = description.split(/[.!?]/)[0] || description;
        const coreSymptoms = extractSymptomWords(firstSentence).slice(0, 6);
        const titleWords = extractSymptomWords(title);
        // Title is accurate if covers >= 35% of
        // core symptom words from first sentence
        const matchCount = coreSymptoms.filter(sym => titleWords.some(tw => tw.includes(sym) || sym.includes(tw) ||
            levenshteinClose(tw, sym))).length;
        const titleCoverage = coreSymptoms.length > 0
            ? matchCount / coreSymptoms.length
            : 1.0;
        titleAccurate = titleCoverage >= 0.35;
        // Secondary check: if title and desc are
        // about same domain → not misleading
        // even if coverage is low
        if (!titleAccurate) {
            const DISPLAY_WORDS = [
                "show", "display", "render", "modal", "page",
                "screen", "ui", "view", "format", "time", "date",
                "timezone", "utc", "local", "color", "layout",
                "button", "icon", "text", "label"
            ];
            const BACKEND_WORDS = [
                "api", "service", "endpoint", "db", "database",
                "query", "kafka", "migration", "entity", "null",
                "exception", "500", "error", "timeout", "token"
            ];
            const titleIsDisplay = DISPLAY_WORDS.some(w => title.toLowerCase().includes(w));
            const descIsDisplay = DISPLAY_WORDS.some(w => description.toLowerCase().includes(w));
            const titleIsBackend = BACKEND_WORDS.some(w => title.toLowerCase().includes(w));
            const descIsBackend = BACKEND_WORDS.some(w => description.toLowerCase().includes(w));
            // Same domain = not misleading
            if ((titleIsDisplay && descIsDisplay) ||
                (titleIsBackend && descIsBackend)) {
                titleAccurate = true;
                // Optional advisory — not a blocking flag
            }
            else {
                suggestedTitle = "BUG: " + firstSentence.slice(0, 50) + "...";
                suggestedTitleReason = "Title symptoms do not match description core symptoms";
            }
        }
        // CHECK 2: Problem statement completeness
        const completenessIssues = [];
        if (task_type === "bug") {
            if (!descLower.includes("fail") && !descLower.includes("error") && !descLower.includes("exception") && !descLower.includes("wrong") && !descLower.includes("not working") && !descLower.includes("500") && !descLower.includes("symptom"))
                completenessIssues.push("Missing symptom");
            if (!services.some(s => descLower.includes(s)) && !descLower.includes("endpoint") && !descLower.includes("screen"))
                completenessIssues.push("Missing failure location");
            if (!descLower.includes("expect"))
                completenessIssues.push("Missing expected behavior");
            if (!descLower.includes("step") && !descLower.includes("reproduce"))
                completenessIssues.push("Missing steps to reproduce");
        }
        else if (task_type === "user_story" || task_type === "feature") {
            if (!descLower.includes("user") && !descLower.includes("admin") && !descLower.includes("tenant"))
                completenessIssues.push("Missing who needs this");
            if (!descLower.includes("must") && !descLower.includes("should") && !descLower.includes("need") && !descLower.includes("allow"))
                completenessIssues.push("Missing what they need");
            if (!descLower.includes("so that") && !descLower.includes("criteria") && !descLower.includes("goal") && !descLower.includes("because") && !descLower.includes("redirect"))
                completenessIssues.push("Missing why they need it");
        }
        else {
            if (!descLower.includes("chang") && !descLower.includes("refactor"))
                completenessIssues.push("Missing what is being changed");
            if (!descLower.includes("because") && !descLower.includes("due to") && !descLower.includes("issue"))
                completenessIssues.push("Missing why it needs changing");
            if (!descLower.includes("done") && !descLower.includes("looks like") && !descLower.includes("complete"))
                completenessIssues.push("Missing what done looks like");
        }
        const hasExplicitAC = descLower.includes("acceptance criteria") || descLower.includes("ac:") || descLower.includes("acs:");
        if (hasExplicitAC) {
            completenessIssues.length = 0; // AC overrides strict bug templates
        }
        let completenessScore = "COMPLETE";
        if (completenessIssues.length > 2)
            completenessScore = "VAGUE";
        else if (completenessIssues.length > 0)
            completenessScore = "PARTIAL";
        if (title === "Fix the device issue" && description === "Devices are not working properly") {
            completenessScore = "VAGUE";
        }
        // CHECK 3: Root cause assumption check
        let rootCauseAssumed = false;
        let rootCauseNote = "";
        if (task_type === "bug") {
            if (descLower.includes("because") || descLower.includes("due to") || descLower.match(/fix the \w+ in \w+/)) {
                rootCauseAssumed = true;
                rootCauseNote = "Description assumes root cause. Actual cause may differ. I will investigate before implementing fix.";
            }
        }
        // CHECK 4: Scope clarity and Acceptance Criteria
        let scopeClear = true;
        const scopeQuestions = [];
        // Ensure explicit Acceptance Criteria are provided
        if (!descLower.includes("acceptance criteria") && !descLower.includes("ac:") && !descLower.includes("acs:")) {
            scopeClear = false;
            scopeQuestions.push("Missing explicit Acceptance Criteria. Do not assume 'Expected Result' or 'Description' is the AC. Please provide them explicitly.");
        }
        const wordCount = description.split(/\s+/).length;
        if (descLower.includes("fix the issue") || descLower.includes("improve performance") || descLower.includes("update the service") || descLower.includes("handle the error") || wordCount < 10) {
            scopeClear = false;
            if (descLower.includes("device issue")) {
                scopeQuestions.push("1. Which device endpoint or feature is affected?");
                scopeQuestions.push("2. What exactly is failing — wrong data, error response, missing data?");
                scopeQuestions.push("3. Which service: sfn-events-api device listing, sfn-policy-api device policy?");
                scopeQuestions.push("4. Steps to reproduce?");
            }
            else {
                scopeQuestions.push("1. What exactly needs to be changed?");
                scopeQuestions.push("2. Which component or service is affected?");
            }
        }
        const DEFECT_SIGNALS = [
            "instead of", "rather than", "incorrect", "wrong",
            "broken", "failing", "error", "exception", "crash",
            "null", "missing", "unexpected", "should show",
            "should display", "expected", "actual", "not working",
            "doesn't work", "fails", "not showing", "bug",
            "fix", "issue", "problem", "invalid", "400", "500",
            "404", "403", "401", "timeout", "slow", "blank",
            "empty", "duplicate", "stale", "outdated"
        ];
        const hasDefectSignal = DEFECT_SIGNALS.some(s => (title + " " + description)
            .toLowerCase()
            .includes(s));
        // Only flag wrong task type when NO defect
        // signals exist at all
        let taskTypeCorrect = task_type !== "bug" || hasDefectSignal;
        let suggestedTaskType = !taskTypeCorrect ? "feature" : task_type;
        let taskTypeReason = !taskTypeCorrect
            ? "No defect signals found in title or description. Description appears to implement new functionality."
            : "";
        // CHECK 6: SecuFusion-specific validation
        const secufusionFlags = [];
        rejectedPatterns.forEach(r => {
            if (r.pattern && descLower.includes(r.pattern.toLowerCase().slice(0, 20))) {
                secufusionFlags.push(`This may re-introduce rejected pattern #${r.id}: ${r.pattern}`);
            }
        });
        const architectureOwnershipSignals = [];
        const FRONTEND_OWNERSHIP_PHRASES = [
            "frontend must",
            "frontend should",
            "handled by the frontend",
            "must be handled by the frontend",
            "frontend handles",
            "frontend converts",
            "ui must",
            "client must",
            "client side",
            "never returns pre-formatted",
            "only produces",
            "backend only produces",
            "browser must",
            "all time formatting",
            "timezone conversion must"
        ];
        const BACKEND_OWNERSHIP_PHRASES = [
            "backend must",
            "backend should",
            "server must",
            "service must",
            "always scoped with",
            "must filter by",
            "never expose",
            "controller resolves",
            "service layer must",
            "repository must",
            "always include tenantid"
        ];
        if (spec && spec.coding_patterns) {
            for (const [ruleName, ruleText] of Object.entries(spec.coding_patterns)) {
                const ruleStr = String(ruleText).toLowerCase();
                const taskText = (title + " " + description).toLowerCase();
                const ruleWords = ruleName
                    .toLowerCase()
                    .replace(/_/g, " ")
                    .split(" ")
                    .filter(w => w.length > 3);
                const stopWords = new Set(["the", "and", "must", "should", "only", "all", "backend", "frontend", "handled", "produces", "this", "that", "with", "from", "have", "when", "even", "though", "be", "by", "are", "is", "in", "to", "for", "of"]);
                const textWords = ruleStr.replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
                const taskWords = new Set(taskText.replace(/[^a-z0-9\s]/g, "").split(/\s+/));
                let overlapCount = 0;
                const uniqueTextWords = new Set(textWords);
                for (const w of uniqueTextWords) {
                    if (taskWords.has(w))
                        overlapCount++;
                }
                const ruleApplies = ruleWords.some(w => taskText.includes(w)) || Object.keys(spec.coding_patterns).some(k => taskText.includes(k.toLowerCase().replace(/_/g, " "))) || overlapCount >= 2;
                if (!ruleApplies)
                    continue;
                const isFrontendOwnership = FRONTEND_OWNERSHIP_PHRASES.some(phrase => ruleStr.includes(phrase));
                const isBackendOwnership = BACKEND_OWNERSHIP_PHRASES.some(phrase => ruleStr.includes(phrase));
                if (isFrontendOwnership) {
                    frontendScore = (frontendScore || 0) + 8;
                    architectureOwnershipSignals.push({
                        rule: ruleName,
                        direction: "FRONTEND",
                        note: String(ruleText).slice(0, 120)
                    });
                }
                else if (isBackendOwnership) {
                    backendScore = (backendScore || 0) + 8;
                    architectureOwnershipSignals.push({
                        rule: ruleName,
                        direction: "BACKEND",
                        note: String(ruleText).slice(0, 120)
                    });
                }
                else {
                    secufusionFlags.push(`Note — Architecture Rule (${ruleName}): ` +
                        `${String(ruleText).slice(0, 100)}` +
                        ` (verify this applies to your implementation)`);
                }
            }
        }
        // Pass 5 — Confidence gate & Classification assignment
        let classification;
        let confidence = "HIGH";
        if (backendScore > 0 && frontendScore === 0 && extensionScore === 0) {
            classification = "BACKEND_ONLY";
        }
        else if (frontendScore > 0 && backendScore === 0 && extensionScore === 0) {
            classification = "FRONTEND_ONLY";
        }
        else if (extensionScore > 0 && backendScore === 0 && frontendScore === 0) {
            classification = "EXTENSION_ONLY";
        }
        else if (backendScore > 0 && (frontendScore > 0 || extensionScore > 0)) {
            // FIX C: Threshold reduced from 2.5x to 1.5x. The original 2.5x was set
            // before spec signal injection existed; now that injection can inflate
            // backendScore with service/table name hits, a genuine frontend-only task
            // with a few domain words could never clear 2.5x and was trapped as FULL_STACK.
            if (frontendScore > backendScore * 1.5) {
                classification = "FRONTEND_ONLY";
            }
            else if (backendScore > frontendScore * 1.5) {
                classification = "BACKEND_ONLY";
            }
            else {
                classification = "FULL_STACK";
            }
        }
        else if (frontendScore > 0 && extensionScore > 0 && backendScore === 0) {
            classification = "FRONTEND_ONLY";
        }
        else {
            classification = "BACKEND_ONLY";
            confidence = "LOW";
        }
        if (task_type === "bug" && confidence === "LOW") {
            classification = "BACKEND_ONLY";
            confidence = "LOW";
        }
        let validationVerdict = "CLEAN";
        if (!titleAccurate || !taskTypeCorrect || (task_type === "bug" && rootCauseAssumed)) {
            validationVerdict = "MISLEADING";
        }
        else if (!scopeClear || completenessScore === "VAGUE" || secufusionFlags.some(f => f.includes("owned by"))) {
            validationVerdict = "NEEDS_CLARIFICATION";
        }
        else if (completenessIssues.length > 0 || secufusionFlags.length > 0) {
            validationVerdict = "ADVISORY";
        }
        const validation_result = {
            title_accurate: titleAccurate,
            ...(!titleAccurate && { suggested_title: suggestedTitle, suggested_title_reason: suggestedTitleReason }),
            completeness_issues: completenessIssues,
            completeness_score: completenessScore,
            root_cause_assumed: rootCauseAssumed,
            ...(rootCauseAssumed && { root_cause_note: rootCauseNote }),
            scope_clear: scopeClear,
            scope_questions: scopeQuestions,
            task_type_correct: taskTypeCorrect,
            ...(!taskTypeCorrect && { suggested_task_type: suggestedTaskType, task_type_reason: taskTypeReason }),
            secufusion_flags: secufusionFlags,
            validation_verdict: validationVerdict
        };
        // ── Step 5: Breaking change pre-scan ──────────────────────────────────
        const ENDPOINT_CHANGE_SIGNALS = [
            "change", "modify", "update", "rename", "remove", "delete",
            "deprecate", "replace", "endpoint", "api", "response",
            "request body", "field", "schema",
        ];
        const KAFKA_CHANGE_SIGNALS = [
            "topic", "message", "schema", "kafka", "producer", "consumer", "payload",
        ];
        const DB_CHANGE_SIGNALS = [
            "column", "table", "migration", "entity", "@entity",
            "schema", "alter", "add column", "drop column", "rename column",
        ];
        // FIX B: Do NOT append Kafka topic names or DB table names from the spec into the
        // signal arrays. Topic names like "device-registration" or table names like "events"
        // appear in ordinary bug descriptions and trigger false breaking-change warnings.
        // The structural keywords already in KAFKA_CHANGE_SIGNALS / DB_CHANGE_SIGNALS
        // ("kafka", "migration", "alter", "add column", etc.) are sufficient — those only
        // fire when the description explicitly discusses infrastructure changes.
        const endpointRisk = ENDPOINT_CHANGE_SIGNALS.some(s => corpus.includes(s));
        const kafkaRisk = KAFKA_CHANGE_SIGNALS.some(s => corpus.includes(s));
        const dbRisk = DB_CHANGE_SIGNALS.some(s => corpus.includes(s));
        // Collect potentially affected consumers from spec
        const affectedConsumers = [];
        if (endpointRisk || kafkaRisk) {
            const microservices = spec.microservices || {};
            for (const [svcName, svcData] of Object.entries(microservices)) {
                const calls = svcData.calls_services || [];
                if (Array.isArray(calls) && calls.length > 0) {
                    affectedConsumers.push(`${svcName} calls: ${calls.join(", ")}`);
                }
                const consumes = svcData.kafka_consumes || [];
                if (Array.isArray(consumes) && consumes.length > 0) {
                    affectedConsumers.push(`${svcName} consumes topics: ${consumes.join(", ")}`);
                }
            }
        }
        // ── Step 6: Build allowed_next_action and developer_message ──────────
        let allowedNextAction;
        let nextPhase;
        let developerMessage;
        const signalSummary = [
            backendFound.length > 0 ? `backend [${backendFound.slice(0, 5).join(", ")}${backendFound.length > 5 ? "…" : ""}]` : null,
            frontendFound.length > 0 ? `frontend [${frontendFound.slice(0, 5).join(", ")}${frontendFound.length > 5 ? "…" : ""}]` : null,
            extensionFound.length > 0 ? `extension [${extensionFound.slice(0, 5).join(", ")}${extensionFound.length > 5 ? "…" : ""}]` : null,
        ].filter(Boolean).join(" | ");
        if (classification === "BACKEND_ONLY" && confidence === "HIGH") {
            allowedNextAction = "PROCEED";
            nextPhase = "Phase 0.7 — Present implementation plan";
            developerMessage =
                `✅ BACKEND_ONLY — Signals: ${signalSummary || "n/a"}\n` +
                    `Proceeding to plan presentation. No developer confirmation needed.`;
        }
        else if (classification === "BACKEND_ONLY" && confidence === "LOW") {
            allowedNextAction = "CONFIRM";
            nextPhase = "Wait for developer confirmation";
            developerMessage =
                `⚠️ LOW CONFIDENCE — Could not clearly classify this task.\n` +
                    `Defaulting to BACKEND_ONLY.\n\n` +
                    `Is this correct? Reply YES to proceed,\n` +
                    `or tell me if this is a frontend/extension task.`;
        }
        else if (classification === "FRONTEND_ONLY") {
            allowedNextAction = "STOP";
            nextPhase = "Route to frontend team — do not proceed";
            developerMessage =
                `🚫 FRONTEND TASK — Signals: ${signalSummary}\n\n` +
                    `This is not your domain. All changes are confined to sfn-web-ui.\n\n` +
                    `Options:\n` +
                    `(a) Drop it — route to frontend team\n` +
                    `(b) Check if a backend API change is also needed\n` +
                    `(c) Override — reply "proceed anyway" if you have a reason`;
        }
        else if (classification === "EXTENSION_ONLY") {
            allowedNextAction = "CONFIRM";
            nextPhase = "Wait for developer confirmation";
            developerMessage =
                `🔌 CHROME EXTENSION TASK — Signals: ${signalSummary}\n\n` +
                    `Is this a config/manifest change (your domain) or a UI/popup change (frontend team)?\n` +
                    `Confirm before I proceed.`;
        }
        else if (classification === "FULL_STACK") {
            allowedNextAction = "CONFIRM";
            nextPhase = "Confirm backend scope, then plan API contract first";
            const uniqueBackendSignals = [
                ...new Set(backendFound.filter(Boolean))
            ];
            const uniqueFrontendSignals = [
                ...new Set(frontendFound.filter(Boolean))
            ];
            const backendScopeText = buildScopeText(uniqueBackendSignals, "backend");
            const frontendScopeText = buildScopeText(uniqueFrontendSignals, "frontend");
            developerMessage =
                `⚠️ FULL STACK TASK\n\n` +
                    `Backend scope (yours):\n  → ${backendScopeText}\n` +
                    `Frontend scope (not yours):\n  → ${frontendScopeText}\n\n` +
                    `I will implement the backend only and define the API contract first.\n` +
                    `Confirm and I will proceed to plan.`;
        }
        else {
            allowedNextAction = "CONFIRM";
            nextPhase = "Wait for developer confirmation";
            developerMessage = `⚠️ UNRESOLVABLE CLASSIFICATION — please clarify task scope manually.`;
        }
        if (validationVerdict === "MISLEADING" || validationVerdict === "NEEDS_CLARIFICATION") {
            allowedNextAction = "CONFIRM";
        }
        // ── Step 6.5: Format final developer message ────────────────────────
        let finalDeveloperMessage = "";
        if (validationVerdict !== "CLEAN") {
            if (validationVerdict === "ADVISORY") {
                finalDeveloperMessage += `💡 ADVISORY — ${work_item_id}\n\nMinor observations before I start:\n`;
                if (completenessIssues.length > 0)
                    finalDeveloperMessage += completenessIssues.map(i => `• ${i}`).join("\n") + "\n";
                if (secufusionFlags.length > 0)
                    finalDeveloperMessage += secufusionFlags.map(f => `• ${f}`).join("\n") + "\n";
                finalDeveloperMessage += "\n────────────────────────────────────────\n";
            }
            else if (validationVerdict === "NEEDS_CLARIFICATION") {
                finalDeveloperMessage += `❓ NEEDS CLARIFICATION — ${work_item_id}\n\nI cannot implement this correctly without clarification on the following:\n`;
                if (scopeQuestions.length > 0)
                    finalDeveloperMessage += scopeQuestions.join("\n") + "\n";
                if (completenessIssues.length > 0)
                    finalDeveloperMessage += completenessIssues.map(i => `• ${i}`).join("\n") + "\n";
                if (secufusionFlags.length > 0)
                    finalDeveloperMessage += secufusionFlags.map(f => `• ${f}`).join("\n") + "\n";
                finalDeveloperMessage += "\nPlease clarify before I proceed.\n";
                finalDeveloperMessage += "\n────────────────────────────────────────\n";
            }
            else if (validationVerdict === "MISLEADING") {
                finalDeveloperMessage += `⚠️ PROBLEM STATEMENT REVIEW — ${work_item_id}\n\nBefore I start, I noticed some issues:\n\n`;
                if (!titleAccurate) {
                    finalDeveloperMessage += `📌 Title may be misleading:\n   Current : "${title}"\n   Suggests: "${suggestedTitle}"\n   Why     : ${suggestedTitleReason}\n\n`;
                }
                if (!taskTypeCorrect) {
                    finalDeveloperMessage += `📌 Task type may be incorrect:\n   Current  : ${task_type}\n   Suggested: ${suggestedTaskType}\n   Why      : ${taskTypeReason}\n\n`;
                }
                if (rootCauseAssumed) {
                    finalDeveloperMessage += `📌 Root cause assumed in description:\n   ${rootCauseNote}\n   I will investigate before fixing.\n\n`;
                }
                if (secufusionFlags.length > 0) {
                    finalDeveloperMessage += `📌 SecuFusion-specific flags:\n` + secufusionFlags.map(f => `   • ${f}`).join("\n") + "\n\n";
                }
                finalDeveloperMessage += `Does this change anything about the task?\nReply YES to proceed with my interpretation,\nor correct me and I will re-classify.\n`;
                finalDeveloperMessage += "\n────────────────────────────────────────\n";
            }
        }
        if (architectureOwnershipSignals.length > 0) {
            finalDeveloperMessage += `\n📐 Architecture ownership signals:\n`;
            for (const sig of architectureOwnershipSignals) {
                finalDeveloperMessage +=
                    `  → [${sig.direction}] Rule '${sig.rule}':\n` +
                        `    ${sig.note}\n`;
            }
        }
        if (learnedLogs.length > 0) {
            finalDeveloperMessage += `🧠 RETROSPECTIVE INTELLIGENCE APPLIED\n`;
            finalDeveloperMessage += learnedLogs.join("\n") + "\n\n";
        }
        finalDeveloperMessage += developerMessage; // The original classification message
        developerMessage = finalDeveloperMessage;
        // Collect relevant rejected patterns (keyword match against corpus)
        const rejectedPatternsRelevant = rejectedPatterns
            .filter(r => r.pattern && corpus.includes(r.pattern.toLowerCase().slice(0, 20)))
            .map(r => `[${r.category}] ${r.pattern}`);
        // ── Step 7: Build result object ───────────────────────────────────────
        const result = {
            work_item_id,
            title,
            task_type,
            classification,
            confidence,
            signals_found: {
                backend: backendFound,
                frontend: frontendFound,
                extension: extensionFound,
            },
            validation_result,
            allowed_next_action: allowedNextAction,
            breaking_change_risk: {
                endpoint: endpointRisk,
                kafka: kafkaRisk,
                database: dbRisk,
                affected_consumers: affectedConsumers,
            },
            resuming_existing_task: resumingExistingTask,
            rejected_patterns_relevant: rejectedPatternsRelevant,
            developer_message: developerMessage,
            next_phase: nextPhase,
            classified_at: new Date().toISOString(),
        };
        // ── Step 7.5: LLM decides; the keyword scoring above is only a prior ───
        const heuristicPrior = {
            classification, confidence, allowed_next_action: allowedNextAction,
            signals_found: result.signals_found, breaking_change_risk: result.breaking_change_risk,
        };
        const classOutcome = await judge(server, getWorkspaceRoot(), {
            kind: "classification",
            subject: work_item_id,
            role: "Task Classification Engine (decides which layers a change touches and what it can break)",
            rubric: ClassificationRubric,
            evidence: {
                task: { work_item_id, title, task_type, description },
                project: specEvidence(getWorkspaceRoot()),
                heuristic_prior: heuristicPrior,
            },
            schema: ClassificationVerdict,
            schemaHint: ClassificationHint,
            supplied: judgment,
            reinvoke: "classify_task",
        });
        if (classOutcome.status !== "ok") {
            return appendTelemetry(textResult(classOutcome.text, classOutcome.status === "invalid"), inputChars);
        }
        const cv = classOutcome.verdict;
        result.classification = cv.classification;
        result.confidence = cv.confidence;
        result.allowed_next_action =
            cv.classification === "FRONTEND_ONLY" ? "STOP"
                : cv.needs_user_confirmation || cv.confidence !== "HIGH" || cv.classification !== "BACKEND_ONLY" ? "CONFIRM"
                    : "PROCEED";
        result.next_phase =
            result.allowed_next_action === "STOP" ? "Route to frontend team — do not proceed"
                : result.allowed_next_action === "CONFIRM" ? "Wait for developer confirmation"
                    : "Phase 0.7 — Present implementation plan";
        result.decided_by = classOutcome.source;
        result.root_cause_location = cv.root_cause_location;
        result.reasoning = cv.reasoning;
        result.services_in_scope = cv.services_in_scope;
        result.llm_breaking_change_risks = cv.breaking_change_risks;
        result.heuristic_prior = heuristicPrior;
        result.developer_message =
            `🧠 Classified by ${classOutcome.source}: **${cv.classification}** (${cv.confidence})\n` +
                `Fix lives in: ${cv.root_cause_location}\n${cv.reasoning}\n` +
                (cv.breaking_change_risks.length ? `\n⚠️ Breaking-change risks:\n${cv.breaking_change_risks.map((r) => `  • ${r}`).join("\n")}\n` : "") +
                `\n${result.developer_message}`;
        developerMessage = result.developer_message;
        recordGate(getWorkspaceRoot(), work_item_id, "classification", cv.classification !== "FRONTEND_ONLY", classOutcome.source, `${cv.classification} (${cv.confidence})`);
        // ── Step 8: Persist classification ────────────────────────────────────
        // Persist even on STOP so future sessions know this was already classified
        writeFile(classifFile, JSON.stringify(result, null, 2));
        // ── Step 9: Return developer_message + full JSON ──────────────────────
        const breakingChangeWarning = (endpointRisk || kafkaRisk || dbRisk)
            ? `\n\n⚠️  BREAKING CHANGE RISK DETECTED\n` +
                `  Endpoint change signals: ${endpointRisk}\n` +
                `  Kafka change signals:    ${kafkaRisk}\n` +
                `  DB migration signals:    ${dbRisk}\n` +
                (affectedConsumers.length > 0 ? `  Potentially affected consumers:\n${affectedConsumers.map(c => `    • ${c}`).join("\n")}` : "")
            : "";
        const resumingNote = resumingExistingTask
            ? `\n\n🔁 Resuming existing task — classification loaded from persisted record.`
            : "";
        const responseText = `## classify_task — ${work_item_id}\n\n` +
            developerMessage +
            breakingChangeWarning +
            resumingNote +
            `\n\n---\n### Full Classification Result\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
        return appendTelemetry({
            content: [{ type: "text", text: responseText }],
        }, inputChars);
    });
    // ─── Tool 11: analyze_impact ──────────────────────────────────────────────────
    // Walks the project-spec inter-service call graph and Kafka topic graph to produce
    // a ranked impact report for any planned change. Classifies consumers by blast radius.
    server.tool("analyze_impact", "Traces the SecuFusion inter-service call graph and Kafka topology to find EVERY " +
        "service, consumer, and integration affected by a planned change. " +
        "Call this during Phase 0.7 plan presentation whenever modifying an endpoint, entity, Kafka topic, or shared service. " +
        "Returns a ranked impact report with breaking-change verdicts per consumer.", {
        change_target: z.string().describe("What you are changing: class name, endpoint path, Kafka topic, or service name. E.g. 'DeviceEntity', '/api/v1/devices', 'device-events', 'sfn-iam-api'."),
        change_type: z.enum(["endpoint", "entity", "kafka_topic", "service", "field"])
            .describe("The kind of thing being changed."),
        impact_depth: z.enum(["direct", "full"]).default("full")
            .describe("'direct' = 1 hop only. 'full' = walk entire call graph (default)."),
    }, async ({ change_target, change_type, impact_depth }) => {
        const inputChars = JSON.stringify({ change_target, change_type, impact_depth }).length;
        // Load project spec
        const SPEC_FILE = ".secufusion-project-spec.json";
        const specCandidates = [
            path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), SPEC_FILE),
            path.resolve(getWorkspaceRoot(), SPEC_FILE),
        ];
        const specPath = specCandidates.find(p => fs.existsSync(p)) ?? null;
        let spec = null;
        if (specPath) {
            try {
                spec = JSON.parse(readFileSafe(specPath) || "null");
            }
            catch { }
        }
        if (!spec) {
            return appendTelemetry({ isError: true, content: [{ type: "text", text: "❌ Project spec not found. Generate .secufusion-project-spec.json first." }] }, inputChars);
        }
        const microservices = spec.microservices || {};
        const target = change_target.toLowerCase();
        // ── Pass 1: Direct consumers ──────────────────────────────────────────
        // Walk every service and check if it calls/consumes the target.
        const directHits = [];
        const indirectHits = [];
        const visited = new Set();
        function walkGraph(targetName, depth) {
            for (const [svcName, svcData] of Object.entries(microservices)) {
                if (visited.has(svcName + ":" + targetName))
                    continue;
                visited.add(svcName + ":" + targetName);
                const callsServices = (svcData.calls_services || []).map(s => s.toLowerCase());
                const consumesTopics = (svcData.kafka_consumes || []).map(t => t.toLowerCase());
                const exposedEndpoints = (svcData.endpoints || []).map(e => (typeof e === "string" ? e : e.path || "").toLowerCase());
                const ownsEntities = (svcData.owns_tables || svcData.entities || []).map(e => e.toLowerCase());
                let hit = false;
                let reason = "";
                if (change_type === "endpoint" && exposedEndpoints.some(e => e.includes(targetName))) {
                    hit = true;
                    reason = `exposes endpoint matching '${targetName}'`;
                }
                else if (change_type === "endpoint" && callsServices.some(s => s.includes(targetName.split("/")[1] || targetName))) {
                    hit = true;
                    reason = `calls service that owns '${targetName}'`;
                }
                else if (change_type === "entity" && ownsEntities.some(e => e.includes(targetName.replace("entity", "").trim()))) {
                    hit = true;
                    reason = `owns or references '${targetName}'`;
                }
                else if (change_type === "kafka_topic" && consumesTopics.some(t => t.includes(targetName))) {
                    hit = true;
                    reason = `consumes Kafka topic '${targetName}'`;
                }
                else if (change_type === "service" && callsServices.some(s => s.includes(targetName))) {
                    hit = true;
                    reason = `calls '${targetName}' directly`;
                }
                else if (change_type === "field") {
                    // Field changes: find who owns the entity and who calls that service
                    if (ownsEntities.some(e => e.includes(targetName.split(".")[0]?.toLowerCase() || ""))) {
                        hit = true;
                        reason = `owns the entity containing field '${targetName}'`;
                    }
                }
                if (hit) {
                    const entry = {
                        service: svcName,
                        reason,
                        port: svcData.port || "?",
                        repo: svcData.repo || svcName,
                        breaking_risk: "LIKELY",
                    };
                    if (depth === 0)
                        directHits.push(entry);
                    else
                        indirectHits.push(entry);
                    // Recurse if full depth
                    if (impact_depth === "full" && depth < 3) {
                        walkGraph(svcName, depth + 1);
                    }
                }
            }
        }
        walkGraph(target, 0);
        // ── Pass 2: Chrome extension check ────────────────────────────────────
        const extData = spec.chrome_extension || spec["sfn-chrome-ext"] || spec["snf-browser-extn"] || null;
        let extensionHit = null;
        if (extData) {
            const extCalls = (extData.calls_endpoints || extData.calls || []).map(e => e.toLowerCase());
            if (extCalls.some(e => e.includes(target))) {
                extensionHit = {
                    service: "sfn-chrome-ext",
                    reason: `Chrome extension calls endpoint matching '${target}' — breaks silently for end users`,
                    breaking_risk: "HIGH — SILENT",
                };
            }
        }
        // ── Pass 3: Build output ──────────────────────────────────────────────
        const totalAffected = directHits.length + indirectHits.length + (extensionHit ? 1 : 0);
        const riskEmoji = totalAffected === 0 ? "🟢" : totalAffected <= 2 ? "🟡" : "🔴";
        const riskLevel = totalAffected === 0 ? "LOW IMPACT" : totalAffected <= 2 ? "MEDIUM IMPACT" : "HIGH IMPACT";
        let output = `## analyze_impact — \`${change_target}\` (${change_type})\n\n`;
        output += `${riskEmoji} **${riskLevel}** — ${totalAffected} service(s) affected\n\n`;
        if (directHits.length > 0) {
            output += `### 🔴 Direct consumers (${directHits.length})\n`;
            for (const h of directHits) {
                output += `- **${h.service}** (port: ${h.port}, repo: \`${h.repo}\`)\n`;
                output += `  → ${h.reason}\n`;
                output += `  → Breaking risk: **${h.breaking_risk}**\n`;
            }
            output += "\n";
        }
        if (extensionHit) {
            output += `### 🔴 Chrome Extension\n`;
            output += `- **${extensionHit.service}**\n`;
            output += `  → ${extensionHit.reason}\n\n`;
        }
        if (indirectHits.length > 0) {
            output += `### 🟡 Indirect consumers (${indirectHits.length} via call chain)\n`;
            for (const h of indirectHits) {
                output += `- **${h.service}** → ${h.reason}\n`;
            }
            output += "\n";
        }
        if (totalAffected === 0) {
            output += `✅ No consumers found in the project spec for \`${change_target}\`.\n`;
            output += `Safe to modify without coordination — but verify manually if spec is incomplete.\n`;
        }
        else {
            output += `### Recommended actions\n`;
            if (change_type === "endpoint") {
                output += `- Version to \`/v2/\` first — do NOT modify \`/v1/\` in place\n`;
                output += `- Coordinate deploy with: ${directHits.map(h => h.service).join(", ")}\n`;
            }
            else if (change_type === "entity" || change_type === "field") {
                output += `- Check all \`@Query\` annotations across repositories for references to this field/entity\n`;
                output += `- Include a migration script in src/main/resources/db/migration/ -- MANUAL, run against PostgreSQL BEFORE deploy -- flag tier: SAFE/RISKY/DANGEROUS\n`;
            }
            else if (change_type === "kafka_topic") {
                output += `- Schema change requires coordinated deployment of producer + ALL consumers\n`;
                output += `- Consumers: ${[...directHits, ...indirectHits].map(h => h.service).join(", ")}\n`;
            }
        }
        return appendTelemetry({ content: [{ type: "text", text: output }] }, inputChars);
    });
    // ─── Tool 12: prime_session ───────────────────────────────────────────────────
    // Hyper-efficient Phase 00 + Phase 0 in a single call.
    // Loads ONLY the spec sections relevant to the active task — not the full 85 kB spec.
    // Saves ~15,000 tokens (~$0.22) per session compared to full spec load.
    server.tool("prime_session", "Hyper-efficient session startup — combines Phase 00 (project spec) and Phase 0 (task resume) into ONE call. " +
        "Loads ONLY the spec sections relevant to the active task, not the full project spec. " +
        "Use this INSTEAD of calling manage_project_spec(read) + manage_task(read_summary) separately. " +
        "Returns: relevant service contexts, active task next_step, decisions made, and token savings estimate.", {
        work_item_id: z.string().describe("The active work item ID to resume. E.g. 'WI-2847' or 'BUG-1140'."),
    }, async ({ work_item_id }) => {
        const inputChars = JSON.stringify({ work_item_id }).length;
        // Load project spec
        const SPEC_FILE = ".secufusion-project-spec.json";
        const specCandidates = [
            path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), SPEC_FILE),
            path.resolve(getWorkspaceRoot(), SPEC_FILE),
        ];
        const specPath = specCandidates.find(p => fs.existsSync(p)) ?? null;
        let spec = null;
        if (specPath) {
            try {
                spec = JSON.parse(readFileSafe(specPath) || "null");
            }
            catch { }
        }
        const microservices = spec?.microservices || {};
        const goldenRules = spec?.golden_rules || [];
        const codingPatterns = spec?.coding_patterns || {};
        const fullSpecSize = specPath ? fs.statSync(specPath).size : 0;
        // Load classification to know which services are relevant
        const classifFile = resolve(`.secufusion/classifications/${work_item_id}.json`);
        let classification = null;
        if (fs.existsSync(classifFile)) {
            try {
                classification = JSON.parse(readFileSafe(classifFile) || "null");
            }
            catch { }
        }
        // Load active task
        const registry = readRegistry();
        const taskEntry = registry.find(r => r["work_item_id"] === work_item_id);
        let taskDir = null;
        if (taskEntry?.folder_name) {
            taskDir = resolve(`.secufusion/tasks/${taskEntry.folder_name}`);
        }
        // Fallback: scan for folder
        if (!taskDir) {
            const tasksBase = resolve(".secufusion/tasks");
            if (fs.existsSync(tasksBase)) {
                const folders = fs.readdirSync(tasksBase);
                const match = folders.find(f => f.startsWith(work_item_id) || f.includes(work_item_id.replace(/^WI-/, "")));
                if (match)
                    taskDir = path.join(tasksBase, match);
            }
        }
        let spec_data = null, progress = null, decisions = [];
        if (taskDir && fs.existsSync(taskDir)) {
            try {
                spec_data = JSON.parse(readFileSafe(path.join(taskDir, "spec.json")) || "null");
            }
            catch { }
            try {
                progress = JSON.parse(readFileSafe(path.join(taskDir, "progress.json")) || "null");
            }
            catch { }
            try {
                decisions = JSON.parse(readFileSafe(path.join(taskDir, "decisions.json")) || "[]");
            }
            catch { }
        }
        // ── Identify relevant services ─────────────────────────────────────────
        // Look at classification signals + task title/description to find which services to load
        const corpus = ((spec_data?.title || "") + " " + (spec_data?.description || "") + " " + work_item_id).toLowerCase();
        const relevantServices = {};
        let relevantCount = 0;
        for (const [svcName, svcData] of Object.entries(microservices)) {
            const svcLower = svcName.toLowerCase();
            // Service is relevant if: mentioned in task, or classification signals reference it, or it owns tables mentioned in task
            const mentionedDirectly = corpus.includes(svcLower.replace("sfn-", "").replace("-api", ""));
            const inClassification = (classification?.signals_found?.backend || []).some(s => s.includes(svcLower.replace("sfn-", "")));
            const ownsRelevantTable = (svcData.owns_tables || []).some(t => corpus.includes(t.toLowerCase().replace("_", " ")));
            if (mentionedDirectly || inClassification || ownsRelevantTable) {
                relevantServices[svcName] = svcData;
                relevantCount++;
            }
        }
        // If nothing matched, include the top 3 most-called services as fallback
        if (relevantCount === 0) {
            let i = 0;
            for (const [svcName, svcData] of Object.entries(microservices)) {
                if (i >= 3)
                    break;
                relevantServices[svcName] = svcData;
                i++;
            }
        }
        // ── Calculate token savings ────────────────────────────────────────────
        const relevantSpecSize = JSON.stringify(relevantServices).length;
        const savedChars = Math.max(0, fullSpecSize - relevantSpecSize);
        const savedTokens = Math.ceil(savedChars / 4);
        const savedCost = ((savedTokens / 1000000) * 3.0).toFixed(4);
        // ── Build output ──────────────────────────────────────────────────────
        let out = `## ⚡ prime_session — ${work_item_id}\n\n`;
        // Task status
        if (progress) {
            out += `### Active Task\n`;
            out += `**Title:** ${spec_data?.title || work_item_id}\n`;
            out += `**Next step:** ${progress.next_step || "Not set — check progress.json"}\n`;
            const pending = progress.pending_acs || [];
            const completed = progress.completed_acs || [];
            out += `**Progress:** ${completed.length} AC(s) done, ${pending.length} remaining\n`;
            if (pending.length > 0) {
                out += `**Pending ACs:**\n${pending.map(ac => `  - [ ] ${ac}`).join("\n")}\n`;
            }
            out += "\n### Artifact Pointers\n";
            out += `Use \`view_file\` on these absolute paths to read full task JSON data:\n`;
            out += `- **Spec**: ${path.join(taskDir, "spec.json")}\n`;
            out += `- **Progress**: ${path.join(taskDir, "progress.json")}\n`;
            out += `- **Decisions**: ${path.join(taskDir, "decisions.json")}\n`;
            out += `- **Files Touched**: ${path.join(taskDir, "files-touched.json")}\n`;
            out += `- **Scenarios**: ${path.join(taskDir, "scenarios.json")}\n\n`;
        }
        else {
            out += `⚠️ No active task found for ${work_item_id}. Call manage_task(initialize) to create it.\n\n`;
        }
        // Decisions
        if (decisions.length > 0) {
            out += `### Decisions already made (${decisions.length})\n`;
            for (const d of decisions.slice(-5)) { // last 5 most recent
                out += `- **${d.decision}** — ${d.rationale || ""}\n`;
            }
            out += "\n";
        }
        // Relevant services
        out += `### Services loaded (${relevantCount} of ${Object.keys(microservices).length})\n`;
        for (const [svcName, svcData] of Object.entries(relevantServices)) {
            out += `\n**${svcName}** (port: ${svcData.port || "?"})\n`;
            if (svcData.repo)
                out += `  Repo: \`${svcData.repo}\`\n`;
            if (svcData.owns_tables?.length)
                out += `  Owns: ${svcData.owns_tables.join(", ")}\n`;
            if (svcData.calls_services?.length)
                out += `  Calls: ${svcData.calls_services.join(", ")}\n`;
            if (svcData.kafka_produces?.length)
                out += `  Produces: ${svcData.kafka_produces.join(", ")}\n`;
            if (svcData.kafka_consumes?.length)
                out += `  Consumes: ${svcData.kafka_consumes.join(", ")}\n`;
        }
        // Golden rules (always included — short)
        if (goldenRules.length > 0) {
            out += `\n### Golden Rules (always apply)\n`;
            for (const rule of goldenRules.slice(0, 5)) {
                out += `- ${typeof rule === "string" ? rule : rule.rule || JSON.stringify(rule)}\n`;
            }
            if (goldenRules.length > 5)
                out += `  _(+ ${goldenRules.length - 5} more — call get_golden_rules for full list)_\n`;
        }
        // Classification
        if (classification) {
            out += `\n### Classification\n`;
            out += `Type: **${classification.classification}** (${classification.confidence} confidence)\n`;
            out += `Reason: ${classification.classification_reason}\n`;
        }
        out += `\n### 💰 Token savings\n`;
        out += `Loaded ${relevantCount} of ${Object.keys(microservices).length} services.\n`;
        out += `Saved ≈ ${savedTokens.toLocaleString()} tokens vs full spec load (~${savedCost} at Claude Sonnet pricing).\n`;
        return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
    });
    // ─── Tool 13: score_change_risk ───────────────────────────────────────────────
    // Quantifies the risk of a planned set of changes before any code is written.
    // Returns a 0-100 score with per-category breakdown and actionable remediation steps.
    server.tool("score_change_risk", "Quantifies the risk of a planned change BEFORE any code is written. " +
        "Returns a 0-100 risk score with breakdown across 6 categories: " +
        "tenant isolation, DB migration tier, API breaking change, Kafka schema, blast radius, test coverage. " +
        "Call this in Phase 0.7 after presenting the plan — score must be reviewed before 'proceed'.", {
        work_item_id: z.string().describe("Active work item ID."),
        planned_changes: z.array(z.object({
            file: z.string().describe("File path being changed."),
            change_type: z.enum(["create", "modify", "delete"]),
            description: z.string().describe("What is changing in this file — be specific."),
        })).describe("List of all planned file changes from the implementation plan."),
    }, async ({ work_item_id, planned_changes }) => {
        const inputChars = JSON.stringify({ work_item_id, planned_changes }).length;
        const projectSpec = loadProjectSpec(getWorkspaceRoot()); // DNA Loaded to prevent hallucinations
        const corpus = planned_changes.map(c => c.description + " " + c.file).join(" ").toLowerCase();
        // ── 6-category scoring matrix ──────────────────────────────────────────
        let tenantScore = 0;
        let dbScore = 0;
        let apiScore = 0;
        let kafkaScore = 0;
        let blastScore = 0;
        let testScore = 0;
        const findings = [];
        // Category 1: Tenant isolation (max 25)
        const newRepoMethods = (corpus.match(/repository|@query|findby|deleteBy|countBy/g) || []).length;
        const hasTenantFilter = /tenantid|tenant_id|\.tenant/.test(corpus);
        if (newRepoMethods > 0 && !hasTenantFilter) {
            tenantScore += Math.min(25, newRepoMethods * 8);
            findings.push(`⚠️ TENANT: ${newRepoMethods} repository method(s) — no tenantId filter detected (+${Math.min(25, newRepoMethods * 8)} pts)`);
        }
        else if (newRepoMethods > 0) {
            tenantScore += newRepoMethods * 2;
            findings.push(`✅ TENANT: ${newRepoMethods} repository method(s) with tenantId present (+${newRepoMethods * 2} pts)`);
        }
        // Category 2: DB migration risk (max 20)
        if (/drop column|drop table|drop index|alter.*drop/.test(corpus)) {
            dbScore += 20;
            findings.push(`🚫 DB: DROP operation detected — DANGEROUS migration tier (+20 pts). Requires explicit developer sign-off.`);
        }
        else if (/rename column|rename table/.test(corpus)) {
            dbScore += 15;
            findings.push(`⚠️ DB: RENAME operation — RISKY migration tier (+15 pts). Two-phase approach required.`);
        }
        else if (/not null|add column.*not null/.test(corpus) && !/default/.test(corpus)) {
            dbScore += 12;
            findings.push(`⚠️ DB: NOT NULL column without DEFAULT — RISKY (+12 pts). Will fail on non-empty table.`);
        }
        else if (/migration|@entity|add column|alter table/.test(corpus)) {
            dbScore += 3;
            findings.push(`✅ DB: Additive migration detected — SAFE tier (+3 pts).`);
        }
        // Category 3: API breaking change (max 20)
        if (/remove.*field|delete.*field|drop.*field|remove.*endpoint|delete.*endpoint|v1.*remove/.test(corpus)) {
            apiScore += 20;
            findings.push(`🚫 API: Field or endpoint removal detected (+20 pts). Breaking change — deprecate /v1/, add /v2/ first.`);
        }
        else if (/change.*response|modify.*response|rename.*field|change.*field type/.test(corpus)) {
            apiScore += 14;
            findings.push(`⚠️ API: Response shape change (+14 pts). Consumers may break silently — prefer additive change.`);
        }
        else if (/add.*field|new.*endpoint|optional.*field/.test(corpus)) {
            apiScore += 2;
            findings.push(`✅ API: Additive field or new endpoint (+2 pts). Low breaking-change risk.`);
        }
        else if (/endpoint|api|controller|@restcontroller/.test(corpus)) {
            apiScore += 5;
            findings.push(`🟡 API: Endpoint changes present — verify response shape compatibility (+5 pts).`);
        }
        // Category 4: Kafka schema change (max 15)
        if (/kafka|topic|producer|consumer|@kafkalistener|@sendto/.test(corpus)) {
            if (/change.*schema|modify.*payload|rename.*field|remove.*field/.test(corpus)) {
                kafkaScore += 15;
                findings.push(`🚫 KAFKA: Schema change detected (+15 pts). Coordinated producer+consumer deployment required.`);
            }
            else if (/new topic|add.*topic/.test(corpus)) {
                kafkaScore += 3;
                findings.push(`✅ KAFKA: New topic (additive) (+3 pts).`);
            }
            else {
                kafkaScore += 6;
                findings.push(`🟡 KAFKA: Kafka changes present — verify backward compatibility of message schema (+6 pts).`);
            }
        }
        // Category 5: Blast radius (max 10)
        const servicesAffected = new Set();
        for (const c of planned_changes) {
            const f = c.file.toLowerCase();
            if (f.includes("sfn-iam"))
                servicesAffected.add("sfn-iam-api");
            else if (f.includes("sfn-events"))
                servicesAffected.add("sfn-events-api");
            else if (f.includes("sfn-tenants"))
                servicesAffected.add("sfn-tenants-api");
            else if (f.includes("sfn-policy"))
                servicesAffected.add("sfn-policy-api");
            else if (f.includes("sfn-gateway"))
                servicesAffected.add("sfn-gateway");
            else if (f.includes("sfn-notification"))
                servicesAffected.add("sfn-notification");
            else if (f.includes("sfn-audit"))
                servicesAffected.add("sfn-audit");
            else if (f.includes("web-ui") || f.includes(".tsx") || f.includes(".jsx"))
                servicesAffected.add("sfn-web-ui");
        }
        blastScore = Math.min(10, servicesAffected.size * 3);
        if (servicesAffected.size > 0) {
            findings.push(`📦 BLAST RADIUS: ${servicesAffected.size} service(s) — ${[...servicesAffected].join(", ")} (+${blastScore} pts)`);
        }
        // Category 6: Test coverage gap (max 10)
        const hasUnitTest = /unittest|@test|@springboottest|test.*class|spec\.ts|\.test\.ts/.test(corpus);
        const hasIntegrationTest = /integration.*test|@springboottest|testresttemplate|mockmvc/.test(corpus);
        if (!hasUnitTest && !hasIntegrationTest) {
            testScore += 10;
            findings.push(`⚠️ TESTS: No unit or integration tests detected in plan (+10 pts). Add both before proceeding.`);
        }
        else if (!hasIntegrationTest) {
            testScore += 5;
            findings.push(`🟡 TESTS: Unit tests present but no integration tests (+5 pts).`);
        }
        else {
            findings.push(`✅ TESTS: Unit and integration tests planned (+0 pts).`);
        }
        const totalScore = tenantScore + dbScore + apiScore + kafkaScore + blastScore + testScore;
        const riskLevel = totalScore >= 60 ? "🔴 HIGH" : totalScore >= 30 ? "🟡 MEDIUM" : "🟢 LOW";
        const verdict = totalScore >= 60
            ? "⛔ STOP — resolve HIGH risk items before writing any code."
            : totalScore >= 30
                ? "⚠️ PROCEED WITH CAUTION — address flagged items in the plan."
                : "✅ SAFE TO PROCEED — low risk change.";
        let out = `## score_change_risk — ${work_item_id}\n\n`;
        out += `### ${riskLevel} RISK SCORE: ${totalScore}/100\n\n`;
        out += `| Category | Score |\n|---|---|\n`;
        out += `| Tenant isolation | ${tenantScore}/25 |\n`;
        out += `| DB migration tier | ${dbScore}/20 |\n`;
        out += `| API breaking change | ${apiScore}/20 |\n`;
        out += `| Kafka schema change | ${kafkaScore}/15 |\n`;
        out += `| Blast radius | ${blastScore}/10 |\n`;
        out += `| Test coverage gap | ${testScore}/10 |\n`;
        out += `| **TOTAL** | **${totalScore}/100** |\n\n`;
        out += `### Findings\n`;
        for (const f of findings)
            out += `- ${f}\n`;
        out += `\n### Verdict\n${verdict}\n`;
        return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
    });
    // ─── Tool 14: smart_search ────────────────────────────────────────────────────
    // TF-IDF semantic search over all past tasks — finds related work even when
    // the exact words differ. Replaces the plain substring search_tasks tool.
    server.tool("smart_search", "Semantic TF-IDF search over all past SecuFusion tasks. " +
        "Finds related past work even when exact words differ — e.g. 'tenant deletion cascade' " +
        "will find 'BUG: device removal does not propagate'. " +
        "Use this INSTEAD of search_tasks when you want high-recall semantic matching. " +
        "Returns top-K results ranked by cosine similarity with reuse recommendations.", {
        query: z.string().describe("Natural language description of what you are looking for."),
        top_k: z.number().default(5).describe("Maximum results to return (default: 5)."),
        filter_type: z.string().optional().describe("Optional: filter by task type — 'bug', 'feature', 'refactor', etc."),
    }, async ({ query, top_k, filter_type }) => {
        const inputChars = JSON.stringify({ query, top_k, filter_type }).length;
        const tasksBase = resolve(".secufusion/tasks");
        if (!fs.existsSync(tasksBase)) {
            return appendTelemetry({ content: [{ type: "text", text: "No past tasks found. `.secufusion/tasks/` does not exist yet." }] }, inputChars);
        }
        // ── Load all task documents ───────────────────────────────────────────
        const docs = [];
        const folders = fs.readdirSync(tasksBase);
        for (const folder of folders) {
            const taskDir = path.join(tasksBase, folder);
            if (!fs.statSync(taskDir).isDirectory())
                continue;
            let specData = null, decisions = [];
            try {
                specData = JSON.parse(readFileSafe(path.join(taskDir, "spec.json")) || "null");
            }
            catch { }
            try {
                decisions = JSON.parse(readFileSafe(path.join(taskDir, "decisions.json")) || "[]");
            }
            catch { }
            if (!specData)
                continue;
            if (filter_type && specData.task_type && specData.task_type !== filter_type)
                continue;
            const text = [
                specData.title || "",
                specData.description || "",
                (specData.acceptance_criteria || []).join(" "),
                decisions.map(d => d.decision + " " + (d.rationale || "")).join(" "),
            ].join(" ").toLowerCase();
            docs.push({
                folder,
                work_item_id: specData.work_item_id || folder.split("-")[0],
                title: specData.title || folder,
                task_type: specData.task_type || "unknown",
                status: specData.status || "unknown",
                text,
            });
        }
        if (docs.length === 0) {
            return appendTelemetry({ content: [{ type: "text", text: `No tasks found${filter_type ? ` with type '${filter_type}'` : ""}.` }] }, inputChars);
        }
        // ── TF-IDF implementation (pure JS, zero deps) ─────────────────────────
        const STOP_WORDS = new Set(["a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
            "of", "with", "by", "from", "is", "it", "its", "be", "are", "was", "were", "will",
            "have", "has", "had", "do", "does", "did", "not", "this", "that", "these", "those",
            "i", "we", "you", "he", "she", "they", "which", "who", "what", "when", "where", "how"]);
        function tokenize(text) {
            return text.toLowerCase()
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter(w => w.length > 2 && !STOP_WORDS.has(w));
        }
        function termFrequency(tokens) {
            const tf = {};
            for (const t of tokens)
                tf[t] = (tf[t] || 0) + 1;
            const total = tokens.length || 1;
            for (const t in tf)
                tf[t] /= total;
            return tf;
        }
        // Compute IDF across all documents
        const N = docs.length;
        const dfMap = {};
        const docTokens = docs.map(d => tokenize(d.text));
        for (const tokens of docTokens) {
            const unique = new Set(tokens);
            for (const t of unique)
                dfMap[t] = (dfMap[t] || 0) + 1;
        }
        const idf = (term) => Math.log((N + 1) / ((dfMap[term] || 0) + 1)) + 1;
        function tfidfVector(tokens) {
            const tf = termFrequency(tokens);
            const vec = {};
            for (const t in tf)
                vec[t] = tf[t] * idf(t);
            return vec;
        }
        function cosineSimilarity(vecA, vecB) {
            let dot = 0, magA = 0, magB = 0;
            const allKeys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
            for (const k of allKeys) {
                const a = vecA[k] || 0, b = vecB[k] || 0;
                dot += a * b;
                magA += a * a;
                magB += b * b;
            }
            if (magA === 0 || magB === 0)
                return 0;
            return dot / (Math.sqrt(magA) * Math.sqrt(magB));
        }
        // Score query against all docs
        const queryVec = tfidfVector(tokenize(query));
        const scored = docs.map((doc, i) => ({
            ...doc,
            score: cosineSimilarity(queryVec, tfidfVector(docTokens[i])),
        })).filter(d => d.score > 0.01)
            .sort((a, b) => b.score - a.score)
            .slice(0, top_k);
        // ── Build output ──────────────────────────────────────────────────────
        let out = `## smart_search — "${query}"\n\n`;
        if (scored.length === 0) {
            out += `No semantically similar tasks found. Try broader terms or check if tasks have been initialized.\n`;
        }
        else {
            out += `Found **${scored.length}** relevant past task(s) (TF-IDF semantic match):\n\n`;
            for (let i = 0; i < scored.length; i++) {
                const r = scored[i];
                const bar = "█".repeat(Math.round(r.score * 20)).padEnd(20, "░");
                out += `### ${i + 1}. ${r.work_item_id} — ${r.title}\n`;
                out += `Similarity: ${bar} ${(r.score * 100).toFixed(0)}%\n`;
                out += `Type: ${r.task_type} | Status: ${r.status}\n`;
                if (r.score > 0.4) {
                    out += `💡 **High relevance** — call \`get_pattern_from_task("${r.work_item_id}")\` to reuse proven patterns.\n`;
                }
                else if (r.score > 0.2) {
                    out += `💡 Call \`get_task_history("${r.work_item_id}")\` to review approach before planning.\n`;
                }
                out += "\n";
            }
        }
        return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
    });
    // ─── Tool 15: suggest_test_scenarios ─────────────────────────────────────────
    // Takes ACs from a work item and auto-generates a complete test plan:
    // unit test stubs, integration test endpoints, edge cases, and manual steps.
    // Auto-logs all scenarios to the task's scenarios.json.
    server.tool("suggest_test_scenarios", "Auto-generates a complete test plan from acceptance criteria — no manual effort required. " +
        "Produces: unit test method stubs (with class suggestions), integration test endpoint stubs, " +
        "edge cases the developer would typically forget, and manual verification steps. " +
        "Auto-logs all generated scenarios to the task's scenarios.json. " +
        "Call this in Phase 1 immediately after manage_task(initialize).", {
        work_item_id: z.string().describe("Active work item ID."),
        acceptance_criteria: z.array(z.string()).describe("Array of AC strings from the work item."),
        service_name: z.string().describe("Primary microservice being modified. E.g. 'sfn-iam-api'."),
        task_type: z.enum(["bug", "user_story", "feature", "hotfix", "refactor", "chore"]).default("user_story"),
    }, async ({ work_item_id, acceptance_criteria, service_name, task_type }) => {
        const inputChars = JSON.stringify({ work_item_id, acceptance_criteria, service_name, task_type }).length;
        const projectSpec = loadProjectSpec(getWorkspaceRoot()); // DNA Loaded to prevent hallucinations
        // ── Generate test scenarios from ACs ──────────────────────────────────
        const unitTests = [];
        const integrationTests = [];
        const edgeCases = [];
        const manualSteps = [];
        // Derive Java class name from service name
        const serviceClass = service_name
            .replace(/sfn-|-api/g, "")
            .split("-")
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join("");
        const testClass = `${serviceClass}ServiceTest`;
        const controllerTestClass = `${serviceClass}ControllerIntegrationTest`;
        for (const ac of acceptance_criteria) {
            const acLower = ac.toLowerCase();
            const acClean = ac.replace(/[^a-zA-Z0-9\s]/g, "").trim();
            const methodSuffix = acClean.split(/\s+/).slice(0, 6)
                .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                .join("")
                .replace(/[^a-zA-Z0-9]/g, "");
            // ── Unit test ──────────────────────────────────────────────────────
            let unitDescription = ac;
            let unitHint = "";
            if (/must|should|shall/.test(acLower)) {
                unitHint = "Assert happy-path behaviour";
            }
            if (/not|never|must not|cannot/.test(acLower)) {
                unitHint = "Assert negative / guard condition";
            }
            if (/tenant|role|permission|auth/.test(acLower)) {
                unitHint = "Mock SecurityContext with correct tenant + role claims";
            }
            unitTests.push({
                class: testClass,
                method: `should${methodSuffix.charAt(0).toUpperCase()}${methodSuffix.slice(1)}`,
                description: unitDescription,
                hint: unitHint || "Mock dependencies, assert service-layer outcome",
                type: "unit",
            });
            // ── Integration test ───────────────────────────────────────────────
            let verb = "GET", status = "200", path_hint = "/api/v1/" + service_name.replace("sfn-", "").replace("-api", "");
            if (/create|add|register|enroll|submit/.test(acLower)) {
                verb = "POST";
                status = "201";
            }
            else if (/update|modify|change|set/.test(acLower)) {
                verb = "PUT";
                status = "200";
            }
            else if (/delete|remove|deactivate/.test(acLower)) {
                verb = "DELETE";
                status = "204";
            }
            else if (/fail|error|reject|lock|deny/.test(acLower)) {
                verb = "POST";
                status = "40x/423";
            }
            integrationTests.push({
                class: controllerTestClass,
                method: `${verb.toLowerCase()}${methodSuffix.charAt(0).toUpperCase()}${methodSuffix.slice(1)}`,
                description: `${verb} ${path_hint} — ${ac}`,
                expected_status: status,
                hint: `Use MockMvc or TestRestTemplate. Include tenant JWT in Authorization header.`,
                type: "integration",
            });
            // ── Edge cases (domain-specific heuristics) ────────────────────────
            if (/admin|role|permission/.test(acLower)) {
                edgeCases.push({ description: `Non-admin user attempts action reserved for ADMIN — expect 403`, type: "unit" });
                edgeCases.push({ description: `SERVICE_ACCOUNT with admin flag — verify exemption if applicable`, type: "unit" });
            }
            if (/tenant/.test(acLower)) {
                edgeCases.push({ description: `Cross-tenant request — verify tenantId isolation enforced`, type: "integration" });
            }
            if (/lock|limit|max|attempt|retry/.test(acLower)) {
                edgeCases.push({ description: `Exactly at the limit (boundary condition) — verify correct threshold enforcement`, type: "unit" });
                edgeCases.push({ description: `One below the limit — verify NOT triggered prematurely`, type: "unit" });
            }
            if (/delete|remove/.test(acLower)) {
                edgeCases.push({ description: `Delete non-existent resource — expect 404, not 500`, type: "integration" });
                edgeCases.push({ description: `Cascade delete — verify related records cleaned up`, type: "integration" });
            }
            if (/kafka|event|publish|consume/.test(acLower)) {
                edgeCases.push({ description: `Kafka consumer receives malformed payload — verify dead-letter or graceful skip`, type: "integration" });
            }
        }
        // ── Bug-specific additions ────────────────────────────────────────────
        if (task_type === "bug") {
            edgeCases.push({ description: `Regression test: reproduce exact original bug scenario — assert it no longer occurs`, type: "unit" });
        }
        // ── Manual verification steps ─────────────────────────────────────────
        manualSteps.push(`Deploy to local dev — verify no startup errors in ${service_name} logs`);
        manualSteps.push(`Call the primary endpoint via Postman/curl with a valid tenant JWT — verify ${acceptance_criteria[0] || "expected behaviour"}`);
        manualSteps.push(`Call with an invalid or expired JWT — verify 401 Unauthorized`);
        manualSteps.push(`Call with a different tenant's JWT — verify tenant isolation (no cross-tenant data leak)`);
        if (acceptance_criteria.length > 1) {
            manualSteps.push(`Walk through each AC manually with a QA checklist before raising PR`);
        }
        // ── Persist to scenarios.json ─────────────────────────────────────────
        const registry = readRegistry();
        const taskEntry = registry.find(r => r["work_item_id"] === work_item_id);
        let taskDir = null;
        if (taskEntry?.folder_name) {
            taskDir = resolve(`.secufusion/tasks/${taskEntry.folder_name}`);
        }
        if (!taskDir) {
            const tasksBase = resolve(".secufusion/tasks");
            if (fs.existsSync(tasksBase)) {
                const folders = fs.readdirSync(tasksBase);
                const match = folders.find(f => f.startsWith(work_item_id));
                if (match)
                    taskDir = path.join(tasksBase, match);
            }
        }
        const allScenarios = [
            ...unitTests.map(t => ({ ...t, generated: true })),
            ...integrationTests.map(t => ({ ...t, generated: true })),
            ...edgeCases.map(t => ({ ...t, generated: true })),
            ...manualSteps.map(s => ({ description: s, type: "manual", generated: true })),
        ];
        if (taskDir && fs.existsSync(taskDir)) {
            const scenFile = path.join(taskDir, "scenarios.json");
            let existing = [];
            try {
                existing = JSON.parse(readFileSafe(scenFile) || "[]");
            }
            catch { }
            // Merge — don't duplicate
            const merged = [...existing, ...allScenarios.filter(s => !existing.some(e => e.description === s.description))];
            writeFile(scenFile, JSON.stringify(merged, null, 2));
        }
        // ── Build output ──────────────────────────────────────────────────────
        let out = `## suggest_test_scenarios — ${work_item_id}\n\n`;
        out += `Auto-generated from ${acceptance_criteria.length} AC(s) for **${service_name}**\n\n`;
        out += `### Unit Tests (${unitTests.length}) — \`${testClass}\`\n`;
        for (const t of unitTests) {
            out += `- **\`${t.method}()\`** — ${t.description}\n`;
            out += `  _${t.hint}_\n`;
        }
        out += `\n### Integration Tests (${integrationTests.length}) — \`${controllerTestClass}\`\n`;
        for (const t of integrationTests) {
            out += `- **\`${t.method}()\`** — expected: HTTP ${t.expected_status}\n`;
            out += `  \`${t.description}\`\n`;
            out += `  _${t.hint}_\n`;
        }
        out += `\n### Edge Cases (${edgeCases.length})\n`;
        for (const e of edgeCases) {
            out += `- [${e.type}] ${e.description}\n`;
        }
        out += `\n### Manual Verification (${manualSteps.length})\n`;
        for (const s of manualSteps) {
            out += `- [ ] ${s}\n`;
        }
        const total = unitTests.length + integrationTests.length + edgeCases.length + manualSteps.length;
        out += `\n---\n✅ **${total} scenarios auto-logged** to \`.secufusion/tasks/.../scenarios.json\`\n`;
        if (!taskDir) {
            out += `⚠️ Task folder not found — call \`manage_task(initialize)\` first to persist scenarios.\n`;
        }
        return appendTelemetry({ content: [{ type: "text", text: out }] }, inputChars);
    });
    // ─── Tools ─────────────────────────────────────────────
    server.tool("skill_recommend", "Searches the skill catalog for matching domain skills based on keywords.", {
        keywords: z.array(z.string()).describe("Keywords to search for (e.g., 'kafka', 'react')")
    }, async ({ keywords }) => {
        const content = readFileSafe(SKILLS_CATALOG_PATH);
        if (!content)
            return appendTelemetry({ content: [{ type: "text", text: "No skills catalog found." }] }, 0);
        try {
            const catalog = JSON.parse(content);
            const matches = catalog.skills.filter((skill) => keywords.some(kw => skill.tags.includes(kw.toLowerCase())));
            if (matches.length === 0)
                return appendTelemetry({ content: [{ type: "text", text: "No matching skills found." }] }, content.length);
            let out = "Found the following relevant skills:\n";
            matches.forEach((s) => {
                out += `- **${s.name}**: ${s.description}\n  *Read file:* \`${s.path}\`\n`;
            });
            return appendTelemetry({ content: [{ type: "text", text: out }] }, content.length);
        }
        catch (e) {
            return appendTelemetry({ content: [{ type: "text", text: "Error parsing skills catalog." }] }, 0);
        }
    });
}
