const fs = require('fs');

const file = 'c:\\Users\\Yash\\Desktop\\mcp\\secufusion-mcp\\mcp\\src\\server.ts';
let content = fs.readFileSync(file, 'utf8');

const importStatement = `import { inspectWorkspaceRepositories, getWorkspaceConfig, getEvidenceCompleteness } from "./workspace_intelligence.js";\n`;
if (!content.includes('import { inspectWorkspaceRepositories, getWorkspaceConfig, getEvidenceCompleteness }')) {
    content = content.replace(
        'import { inspectWorkspaceRepositories } from "./workspace_intelligence.js";',
        importStatement
    );
}

const tools = `
server.tool(
  "discover_secufusion_workspace",
  "Determine the current SecuFusion workspace and return its configuration (core vs optional repositories).",
  { workspace_root: z.string().optional() },
  async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const config = getWorkspaceConfig(root);
    return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
  }
);

server.tool(
  "inspect_workspace_repositories",
  "Inspect which repositories are actually present in the workspace, classifying them as core/optional.",
  { workspace_root: z.string().optional() },
  async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const result = inspectWorkspaceRepositories(root);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "refresh_repository_knowledge",
  "Refresh the deterministic knowledge graph from the current repository state.",
  { workspace_root: z.string().optional() },
  async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const stats = performFullExtraction(root);
    return { content: [{ type: "text", text: JSON.stringify({ status: "REFRESHED", stats }, null, 2) }] };
  }
);

server.tool(
  "get_workspace_status",
  "Get the overall status of the workspace (READY, PARTIAL, BLOCKED, FAILED).",
  { workspace_root: z.string().optional() },
  async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const result = inspectWorkspaceRepositories(root);
    return { content: [{ type: "text", text: result.status }] };
  }
);

server.tool(
  "get_evidence_completeness",
  "Retrieve evidence completeness context, exposing which core/optional repositories are missing.",
  { workspace_root: z.string().optional() },
  async ({ workspace_root }) => {
    const root = workspace_root || getWorkspaceRoot();
    const completeness = getEvidenceCompleteness(root);
    return { content: [{ type: "text", text: JSON.stringify(completeness, null, 2) }] };
  }
);
`;

if (!content.includes('server.tool(\n  "discover_secufusion_workspace"')) {
    content = content.replace(
        'async function run() {',
        tools + '\nasync function run() {'
    );
    fs.writeFileSync(file, content, 'utf8');
    console.log("Patched server.ts with Phase 9 tools");
}
