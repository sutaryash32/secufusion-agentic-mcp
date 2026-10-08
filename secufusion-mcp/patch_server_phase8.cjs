const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'mcp', 'src', 'server.ts');
let content = fs.readFileSync(serverPath, 'utf8');

if (!content.includes('import { discoverUIPatterns, generateStaticUIReference, getDesignContext }')) {
    const importStatement = `import { discoverUIPatterns, generateStaticUIReference, getDesignContext } from "./ui_intelligence.js";\n`;
    content = content.replace(
        'import { buildGraph } from "./graph_builder.js";',
        importStatement + 'import { buildGraph } from "./graph_builder.js";'
    );

    const tools = `
server.tool(
  "discover_ui_patterns",
  "Discover existing UI patterns in the frontend repository.",
  { query: z.string() },
  async ({ query }) => {
    const ws = getWorkspaceRoot();
    const dnaPath = path.join(ws, ".secufusion", "dna.json");
    let dna = {};
    if (fs.existsSync(dnaPath)) dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
    const spec = loadProjectSpec(ws);
    const snapshot = buildGraph(dna, spec);
    const patterns = discoverUIPatterns(ws, query, snapshot);
    return { content: [{ type: "text", text: JSON.stringify(patterns, null, 2) }] };
  }
);

server.tool(
  "get_design_context",
  "Retrieve bounded design context for a given requirement.",
  { requirement_id: z.string() },
  async ({ requirement_id }) => {
    const ws = getWorkspaceRoot();
    const dnaPath = path.join(ws, ".secufusion", "dna.json");
    let dna = {};
    if (fs.existsSync(dnaPath)) dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
    const spec = loadProjectSpec(ws);
    const snapshot = buildGraph(dna, spec);
    const context = getDesignContext(ws, requirement_id, snapshot);
    return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
  }
);

server.tool(
  "generate_static_ui_reference",
  "Generate a static HTML UI reference artifact safely sandboxed.",
  { design_id: z.string(), html_content: z.string(), metadata: z.any() },
  async ({ design_id, html_content, metadata }) => {
    const ws = getWorkspaceRoot();
    const indexPath = generateStaticUIReference(ws, design_id, html_content, metadata);
    return { content: [{ type: "text", text: \`DESIGN_GENERATED: \${indexPath}\` }] };
  }
);
`;

    // Insert tools before `async function run()`
    content = content.replace(
        'async function run() {',
        tools + '\nasync function run() {'
    );

    fs.writeFileSync(serverPath, content, 'utf8');
    console.log("Patched server.ts with Phase 8 tools");
}
