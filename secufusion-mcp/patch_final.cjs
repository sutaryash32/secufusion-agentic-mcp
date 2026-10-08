const fs = require('fs');

const file = 'c:\\Users\\Yash\\Desktop\\mcp\\secufusion-mcp\\mcp\\src\\server.ts';
let content = fs.readFileSync(file, 'utf8');

// 1. Replace performFullExtraction return body
const target2 = `        const hasBackend = (models.length > 0 || apis.length > 0 || nodeApis.length > 0);
    const hasFrontend = frontend.length > 0;
    const hasExtension = extension.length > 0;
    const missing = [];
    if (!hasBackend) missing.push("backend");
    if (!hasFrontend) missing.push("frontend");
    if (!hasExtension) missing.push("snf-browser-extn");
    const missingWarning = missing.length > 0 ? \`\\n\\n[CRITICAL CORE CHECK] The following core components are missing from the DNA map: \${missing.join(', ')}. Please verify if this is expected.\` : "";

    return { 
       missingWarning,
       extensionCount: extension.length,`;

const replacement2 = `    const hasFrontend = frontend.length > 0;
    const hasExtension = extension.length > 0;
    
    const inspection = inspectWorkspaceRepositories(ecosystemRoot);
    const missing = inspection.core_missing;
    const missingWarning = missing.length > 0 ? \`\\n\\n[CRITICAL CORE CHECK] The following core repositories are missing from the workspace: \${missing.join(', ')}. Evidence logic and planning will be blocked or degraded.\` : "";

    return { 
       missingWarning,
       inspectionStatus: inspection.status,
       extensionCount: extension.length,`;

if (content.includes(target2)) {
    content = content.replace(target2, replacement2);
} else {
    console.log("Could not find target2 for performFullExtraction.");
}

// 2. Add Phase 9 Tools right before 'const transport = new StdioServerTransport();'
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

if (!content.includes('discover_secufusion_workspace')) {
    content = content.replace('const transport = new StdioServerTransport();', tools + 'const transport = new StdioServerTransport();');
}

fs.writeFileSync(file, content, 'utf8');
console.log("Patched server.ts completely.");
