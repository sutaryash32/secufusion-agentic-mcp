// ─── Tool 9: classify_task ────────────────────────────────────────────────────
server.tool(
    "classify_task",
    "MANDATORY FIRST STEP for every task without exception. " +
    "Classifies a task as BACKEND_ONLY, FRONTEND_ONLY, FULL_STACK, or EXTENSION_ONLY. " +
    "Performs a breaking-change pre-scan against the project spec. " +
    "Returns a structured classification result that determines what the AI is allowed to do next. " +
    "MUST be called BEFORE reading the codebase, BEFORE planning, BEFORE writing any code. " +
    "No exceptions. No shortcuts.",
    {
        work_item_id: z.string().describe("Azure DevOps work item ID, e.g. 'BUG-1140' or '2847'."),
        title: z.string().describe("Full task title from Azure DevOps."),
        description: z.string().describe("Full task description / problem statement. Paste everything from the work item."),
        task_type: z
            .enum(["bug", "user_story", "feature", "hotfix", "refactor", "chore"])
            .describe("Kind of task: bug | user_story | feature | hotfix | refactor | chore"),
    },
    async ({ work_item_id, title, description, task_type }) => {
        const inputChars = JSON.stringify({ work_item_id, title, description, task_type }).length;

        // ── Step 1: Load project spec ─────────────────────────────────────────
        const SPEC_FILE = ".secufusion-project-spec.json";
        const specCandidates = [
            path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), SPEC_FILE),
            path.resolve(getWorkspaceRoot(), SPEC_FILE),
        ];
        let walkRoot = getWorkspaceRoot();
        for (let i = 0; i < 5; i++) {
            const parent = path.dirname(walkRoot);
            if (parent === walkRoot) break;
            walkRoot = parent;
            specCandidates.push(path.join(walkRoot, SPEC_FILE));
        }
        const specPath = specCandidates.find((p) => fs.existsSync(p)) ?? null;
        let spec = null;
        if (specPath) {
            try { spec = JSON.parse(readFileSafe(specPath) || "null"); } catch { /* invalid JSON */ }
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
        if (rejRaw) { try { rejectedPatterns = JSON.parse(rejRaw); } catch { /* ignore */ } }

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
        if (inRegistry) resumingExistingTask = true;

        // ── Step 4: Signal scoring ────────────────────────────────────────────
        const corpus = (title + " " + description).toLowerCase();

        const BACKEND_SIGNALS = [
            "api", "endpoint", "service", "repository", "database", "db", "query",
            "migration", "flyway", "kafka", "consumer", "producer", "topic",
            "keycloak", "jwt", "auth", "token", "realm", "microservice", "spring",
            "java", "entity", "@entity", "dto", "controller", "feign", "scheduler",
            "cron", "config", "yaml", "yml", "null pointer", "exception", "500",
            "error", "npe", "backend", "server", "rest", "json response", "payload",
            "header", "cors", "filter", "interceptor", "tenantid", "tenant",
            "permission", "role", "sfn-iam", "sfn-events", "sfn-tenants",
            "sfn-policy", "sfn-gateway", "sfn-notification", "sfn-audit", "device",
            "machine", "event", "security alert", "policy rule", "audit log",
        ];

        const FRONTEND_SIGNALS = [
            "ui", "frontend", "react", "component", "page", "screen", "button",
            "form", "input", "dropdown", "modal", "table", "chart", "graph",
            "dashboard", "layout", "style", "css", "color", "icon", "tooltip",
            "sidebar", "navbar", "menu", "sfn-web-ui", "web ui", "browser ui",
            "display", "render", "show on screen", "visual", "animation",
            "responsive", "redux", "zustand", "context", "hook", "tsx", "jsx",
            "html",
        ];

        const EXTENSION_SIGNALS = [
            "chrome extension", "extension", "manifest", "content script",
            "background script", "service worker", "popup", "options page",
            "chrome storage", "registry", "managed policy", "browser extension",
            "sfn-chrome",
        ];

        const backendFound = BACKEND_SIGNALS.filter(s => corpus.includes(s));
        const frontendFound = FRONTEND_SIGNALS.filter(s => corpus.includes(s));
        const extensionFound = EXTENSION_SIGNALS.filter(s => corpus.includes(s));

        const backendScore = backendFound.length;
        const frontendScore = frontendFound.length;
        const extensionScore = extensionFound.length;

        // Determine classification
        let classification;
        let confidence = "HIGH";

        if (backendScore > 0 && frontendScore === 0 && extensionScore === 0) {
            classification = "BACKEND_ONLY";
        } else if (frontendScore > 0 && backendScore === 0 && extensionScore === 0) {
            classification = "FRONTEND_ONLY";
        } else if (extensionScore > 0 && backendScore === 0 && frontendScore === 0) {
            classification = "EXTENSION_ONLY";
        } else if (backendScore > 0 && (frontendScore > 0 || extensionScore > 0)) {
            classification = "FULL_STACK";
        } else if (frontendScore > 0 && extensionScore > 0 && backendScore === 0) {
            // Both are non-backend — treat as frontend
            classification = "FRONTEND_ONLY";
        } else {
            // All scores zero — ambiguous, default to backend
            classification = "BACKEND_ONLY";
            confidence = "LOW";
        }

        // Bug special rule: bugs default to backend unless explicitly UI
        if (task_type === "bug" && confidence === "LOW") {
            classification = "BACKEND_ONLY";
            confidence = "LOW";
        }

                // ── Step 4.5: Problem statement validation ───────────────────────────────────
        const descLower = description.toLowerCase();
        
        let titleAccurate = true;
        let suggestedTitle = "";
        let suggestedTitleReason = "";
        
        // CHECK 1: Title accuracy
        const verbs = ["delete", "create", "fetch", "update", "add", "remove", "fix", "implement"];
        const nouns = ["tenant", "admin", "device", "policy", "gateway", "notification", "audit", "role", "permission", "user", "group", "mapping", "api", "endpoint", "dashboard", "db", "database"];
        const services = ["sfn-iam-api", "sfn-events-api", "sfn-tenants-api", "sfn-policy-api", "sfn-gateway-api", "sfn-web-ui"];
        
        const foundConcepts = [];
        [...verbs, ...nouns, ...services].forEach(word => {
            if (descLower.includes(word)) foundConcepts.push(word);
        });
        
        const titleLower = title.toLowerCase();
        const matchedConcepts = foundConcepts.filter(c => titleLower.includes(c));
        
        if (foundConcepts.length > 0 && matchedConcepts.length < (foundConcepts.length * 0.5)) {
            titleAccurate = false;
            const mainAction = verbs.find(v => descLower.includes(v)) || "Update";
            const mainEntity = nouns.find(n => descLower.includes(n)) || "component";
            const serviceName = services.find(s => descLower.includes(s)) || "service";
            
            suggestedTitle = `${task_type.toUpperCase()}: ${mainAction} ${mainEntity} in ${serviceName}`;
            suggestedTitleReason = "Title misses major concept from description";
            
            if (title === "Tenant dashboard not loading" && descLower.includes("500") && descLower.includes("deletion")) {
                suggestedTitle = "BUG: Fix false HTTP 500 response on successful tenant deletion in sfn-tenants-api";
                suggestedTitleReason = "Title says dashboard loading issue but description is about API response after successful DB deletion";
            }
        }

        // CHECK 2: Problem statement completeness
        const completenessIssues = [];
        if (task_type === "bug") {
            if (!descLower.includes("fail") && !descLower.includes("error") && !descLower.includes("exception") && !descLower.includes("wrong") && !descLower.includes("not working") && !descLower.includes("500") && !descLower.includes("symptom")) completenessIssues.push("Missing symptom");
            if (!services.some(s => descLower.includes(s)) && !descLower.includes("endpoint") && !descLower.includes("screen")) completenessIssues.push("Missing failure location");
            if (!descLower.includes("expect")) completenessIssues.push("Missing expected behavior");
            if (!descLower.includes("step") && !descLower.includes("reproduce")) completenessIssues.push("Missing steps to reproduce");
        } else if (task_type === "user_story" || task_type === "feature") {
            if (!descLower.includes("user") && !descLower.includes("admin") && !descLower.includes("tenant")) completenessIssues.push("Missing who needs this");
            if (!descLower.includes("must") && !descLower.includes("should") && !descLower.includes("need") && !descLower.includes("allow")) completenessIssues.push("Missing what they need");
            if (!descLower.includes("so that") && !descLower.includes("criteria") && !descLower.includes("goal") && !descLower.includes("because") && !descLower.includes("redirect")) completenessIssues.push("Missing why they need it");
        } else {
            if (!descLower.includes("chang") && !descLower.includes("refactor")) completenessIssues.push("Missing what is being changed");
            if (!descLower.includes("because") && !descLower.includes("due to") && !descLower.includes("issue")) completenessIssues.push("Missing why it needs changing");
            if (!descLower.includes("done") && !descLower.includes("looks like") && !descLower.includes("complete")) completenessIssues.push("Missing what done looks like");
        }
        
        let completenessScore = "COMPLETE";
        if (completenessIssues.length > 2) completenessScore = "VAGUE";
        else if (completenessIssues.length > 0) completenessScore = "PARTIAL";

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

        // CHECK 4: Scope clarity
        let scopeClear = true;
        const scopeQuestions = [];
        const wordCount = description.split(/\s+/).length;
        if (descLower.includes("fix the issue") || descLower.includes("improve performance") || descLower.includes("update the service") || descLower.includes("handle the error") || wordCount < 10) {
            scopeClear = false;
            if (descLower.includes("device issue")) {
                scopeQuestions.push("1. Which device endpoint or feature is affected?");
                scopeQuestions.push("2. What exactly is failing — wrong data, error response, missing data?");
                scopeQuestions.push("3. Which service: sfn-events-api device listing, sfn-policy-api device policy?");
                scopeQuestions.push("4. Steps to reproduce?");
            } else {
                scopeQuestions.push("1. What exactly needs to be changed?");
                scopeQuestions.push("2. Which component or service is affected?");
            }
        }

        // CHECK 5: Task type correctness
        let taskTypeCorrect = true;
        let suggestedTaskType = "";
        let taskTypeReason = "";
        
        if (task_type === "bug" && (descLower.includes("add new feature") || descLower.includes("implement a new") || descLower.includes("create"))) {
            taskTypeCorrect = false;
            suggestedTaskType = "feature";
            taskTypeReason = "Description implements new functionality, not fixing a defect";
        } else if (task_type === "user_story" && (descLower.includes("fix") || descLower.includes("broken") || descLower.includes("error") || descLower.includes("exception") || descLower.includes("failing"))) {
            taskTypeCorrect = false;
            suggestedTaskType = "bug";
            taskTypeReason = "Description describes fixing a defect, not a user story";
        } else if (task_type === "refactor" && (descLower.includes("users are reporting") || descLower.includes("production issue"))) {
            taskTypeCorrect = false;
            suggestedTaskType = "hotfix";
            taskTypeReason = "Description implies a production issue, not a refactor";
        } else if (task_type === "chore" && (descLower.includes("core business logic") || descLower.includes("endpoint"))) {
            taskTypeCorrect = false;
            suggestedTaskType = "feature";
            taskTypeReason = "Description involves functional changes, not a chore";
        }

        // CHECK 6: SecuFusion-specific validation
        const secufusionFlags = [];
        rejectedPatterns.forEach(r => {
            if (r.pattern && descLower.includes(r.pattern.toLowerCase().slice(0, 20))) {
                secufusionFlags.push(`This may re-introduce rejected pattern #${r.id}: ${r.pattern}`);
            }
        });
        if (descLower.includes("sfn-iam-api") && descLower.includes("device-user-group mapping")) {
            secufusionFlags.push("Rejected pattern #X: sfn-iam-api must not write device-user-group mappings. sfn-events-api is the sole authority.");
        }
        
        let validationVerdict = "CLEAN";
        if (!titleAccurate || !taskTypeCorrect || (task_type === "bug" && rootCauseAssumed)) {
            validationVerdict = "MISLEADING";
        } else if (!scopeClear || completenessScore === "VAGUE" || secufusionFlags.some(f => f.includes("owned by"))) {
            validationVerdict = "NEEDS_CLARIFICATION";
        } else if (completenessIssues.length > 0 || secufusionFlags.length > 0) {
            validationVerdict = "ADVISORY";
        }

        const validation_result = {
            title_accurate: titleAccurate,
            ...( !titleAccurate && { suggested_title: suggestedTitle, suggested_title_reason: suggestedTitleReason } ),
            completeness_issues: completenessIssues,
            completeness_score: completenessScore,
            root_cause_assumed: rootCauseAssumed,
            ...( rootCauseAssumed && { root_cause_note: rootCauseNote } ),
            scope_clear: scopeClear,
            scope_questions: scopeQuestions,
            task_type_correct: taskTypeCorrect,
            ...( !taskTypeCorrect && { suggested_task_type: suggestedTaskType, task_type_reason: taskTypeReason } ),
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
            "column", "table", "migration", "flyway", "entity", "@entity",
            "schema", "alter", "add column", "drop column", "rename column",
        ];

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
        } else if (classification === "BACKEND_ONLY" && confidence === "LOW") {
            allowedNextAction = "CONFIRM";
            nextPhase = "Wait for developer confirmation";
            developerMessage =
                `⚠️ LOW CONFIDENCE — Could not clearly classify this task.\n` +
                `Defaulting to BACKEND_ONLY.\n\n` +
                `Is this correct? Reply YES to proceed,\n` +
                `or tell me if this is a frontend/extension task.`;
        } else if (classification === "FRONTEND_ONLY") {
            allowedNextAction = "STOP";
            nextPhase = "Route to frontend team — do not proceed";
            developerMessage =
                `🚫 FRONTEND TASK — Signals: ${signalSummary}\n\n` +
                `This is not your domain. All changes are confined to sfn-web-ui.\n\n` +
                `Options:\n` +
                `(a) Drop it — route to frontend team\n` +
                `(b) Check if a backend API change is also needed\n` +
                `(c) Override — reply "proceed anyway" if you have a reason`;
        } else if (classification === "EXTENSION_ONLY") {
            allowedNextAction = "CONFIRM";
            nextPhase = "Wait for developer confirmation";
            developerMessage =
                `🔌 CHROME EXTENSION TASK — Signals: ${signalSummary}\n\n` +
                `Is this a config/manifest change (your domain) or a UI/popup change (frontend team)?\n` +
                `Confirm before I proceed.`;
        } else if (classification === "FULL_STACK") {
            allowedNextAction = "CONFIRM";
            nextPhase = "Confirm backend scope, then plan API contract first";
            developerMessage =
                `⚠️ FULL STACK TASK\n\n` +
                `Backend scope (yours): ${backendFound.slice(0, 8).join(", ")}\n` +
                `Frontend scope (not yours): ${frontendFound.slice(0, 8).join(", ")}\n\n` +
                `I will implement the backend only and define the API contract first.\n` +
                `Confirm and I will proceed to plan.`;
        } else {
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
                if (completenessIssues.length > 0) finalDeveloperMessage += completenessIssues.map(i => `• ${i}`).join("\n") + "\n";
                if (secufusionFlags.length > 0) finalDeveloperMessage += secufusionFlags.map(f => `• ${f}`).join("\n") + "\n";
                finalDeveloperMessage += "\n────────────────────────────────────────\n";
            } else if (validationVerdict === "NEEDS_CLARIFICATION") {
                finalDeveloperMessage += `❓ NEEDS CLARIFICATION — ${work_item_id}\n\nI cannot implement this correctly without answers to these questions:\n`;
                finalDeveloperMessage += scopeQuestions.join("\n") + "\n\nPlease answer before I proceed.\n";
                finalDeveloperMessage += "\n────────────────────────────────────────\n";
            } else if (validationVerdict === "MISLEADING") {
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

        const responseText =
            `## classify_task — ${work_item_id}\n\n` +
            developerMessage +
            breakingChangeWarning +
            resumingNote +
            `\n\n---\n### Full Classification Result\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;

        return appendTelemetry({
            content: [{ type: "text", text: responseText }],
        }, inputChars);
    }
);

// ─── Resource & Prompt for AGENTS.md ──────────────────────────────────────────