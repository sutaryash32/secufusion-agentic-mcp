const fs = require('fs');

let content = fs.readFileSync('mcp/src/server.ts', 'utf8');

const pStart = content.indexOf('// --- Tool 9: philosophy_check');
const cEnd = content.indexOf('// ─── Tool 11: analyze_impact');

if (pStart === -1 || cEnd === -1) {
    console.error("Could not find boundaries for tools 9 and 10.");
    process.exit(1);
}

const replacement = `// --- Tool 9: philosophy_check -------------------------------------------------
server.tool(
    "philosophy_check",
    "Gathers DNA evidence for the philosophy check phase. Returns facts and known patterns for the LLM to analyze.",
    {
        work_item_id: z.string(),
        title: z.string(),
        description: z.string(),
        task_type: z.string(),
        reported_by: z.string().optional(),
        client_confirmed: z.boolean().optional(),
    },
    async ({ work_item_id, title, description, task_type, reported_by, client_confirmed }) => {
        const inputChars = JSON.stringify({ work_item_id, title, description, task_type }).length;
        const wsRoot = getWorkspaceRoot();
        let rejectedPatterns: any[] = [];
        try { rejectedPatterns = JSON.parse(readFileSafe(resolve(REJECTED_FILE)) || "[]"); } catch {}
        
        let dna: any = null;
        const dnaPath = path.resolve(wsRoot, ".secufusion", "dna.json");
        if (fs.existsSync(dnaPath)) {
            try { dna = JSON.parse(readFileSafe(dnaPath) || "null"); } catch {}
        }
        
        const evidence = {
            dna_summary: {
                services: dna?.services?.map((s:any)=>s.name) || [],
                entities: dna?.db_entities?.map((e:any)=>e.name || e.table) || [],
                topics: dna?.kafka_topics || dna?.events || []
            },
            rejected_patterns: rejectedPatterns
        };
        
        return appendTelemetry({ content: [{ type: "text", text: \`[EVIDENCE GATHERED]\\nAnalyze the following facts according to your LLM reasoning:\\n\${JSON.stringify(evidence, null, 2)}\` }] }, inputChars);
    }
);

// --- Tool 10: classify_task --------------------------------------------------
server.tool(
    "classify_task",
    "Gathers repository evidence to classify task scope",
    {
        work_item_id: z.string(),
        title: z.string(),
        description: z.string(),
        task_type: z.string()
    },
    async ({ work_item_id, title, description, task_type }) => {
        const inputChars = JSON.stringify({ work_item_id, title, description, task_type }).length;
        const wsRoot = getWorkspaceRoot();
        const specPath = path.resolve(wsRoot, ".secufusion-project-spec.json");
        let spec: any = null;
        if (fs.existsSync(specPath)) {
            try { spec = JSON.parse(readFileSafe(specPath) || "null"); } catch {}
        }
        
        const evidence = {
            work_item_id,
            spec_summary: spec ? {
                microservices: Object.keys(spec.microservices || {}),
                frontend: spec.frontend?.repo,
                extension: (spec.chrome_extension || spec["snf-browser-extn"])?.repo
            } : null
        };
        
        return appendTelemetry({ content: [{ type: "text", text: \`[SCOPE EVIDENCE GATHERED]\\nLLM Agent: Classify this task and determine if it is FRONTEND_ONLY, BACKEND_ONLY, EXTENSION_ONLY, or FULL_STACK based on the description and evidence:\\n\${JSON.stringify(evidence, null, 2)}\` }] }, inputChars);
    }
);

`;

content = content.substring(0, pStart) + replacement + content.substring(cEnd);
fs.writeFileSync('mcp/src/server.ts', content);
console.log("Replaced Tools 9 and 10.");
