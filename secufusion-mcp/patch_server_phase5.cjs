const fs = require('fs');

let content = fs.readFileSync('mcp/src/server.ts', 'utf8');

const importsToAdd = `
import { discoverTests, executeTests, ingestTestResults, loadTestResults, correlateTestFailure } from "./test_engine.js";
`;

if (!content.includes('import { discoverTests')) {
    content = importsToAdd + "\n" + content;
}

const phase5Tools = `
server.tool(
  "discover_tests",
  "Discover relevant tests for a given set of artifact IDs.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    artifacts: z.array(z.string()).describe("List of artifact IDs (e.g. CLASS:UserService)")
  },
  async ({ workspace_root, artifacts }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        let graph = { nodes: [], edges: [] };
        if (fs.existsSync(dnaPath)) {
            graph = JSON.parse(fs.readFileSync(dnaPath, "utf-8")).graph || graph;
        }
        
        const discovered = discoverTests(graph as any, artifacts);
        return { content: [{ type: "text", text: JSON.stringify(discovered, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "execute_tests",
  "Execute supported existing repository test commands.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    command: z.string().describe("Test command to execute"),
    working_dir: z.string().describe("Working directory relative to workspace root")
  },
  async ({ workspace_root, command, working_dir }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const results = executeTests(ecosystemRoot, command, working_dir);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "ingest_test_results",
  "Parse and normalize existing test result artifacts.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    results: z.array(z.any()).describe("List of normalized TestResult objects")
  },
  async ({ workspace_root, results }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const count = ingestTestResults(ecosystemRoot, results);
        return { content: [{ type: "text", text: \`Ingested \${count} test results.\` }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "get_test_results",
  "Retrieve bounded normalized execution results.",
  {
    workspace_root: z.string().describe("Root directory of the workspace")
  },
  async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const results = loadTestResults(ecosystemRoot);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);

server.tool(
  "correlate_test_failure",
  "Determine evidence-supported relationships between a test failure and affected implementation artifacts.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    failure: z.any().describe("The failed TestResult object")
  },
  async ({ workspace_root, failure }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        let graph = { nodes: [], edges: [] };
        if (fs.existsSync(dnaPath)) {
            graph = JSON.parse(fs.readFileSync(dnaPath, "utf-8")).graph || graph;
        }
        const edges = loadTraceability(ecosystemRoot);
        
        const correlated = correlateTestFailure(graph as any, edges, failure);
        return { content: [{ type: "text", text: JSON.stringify(correlated, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e.message}\` }], isError: true };
    }
  }
);
`;

if (!content.includes('server.tool(\\n  "discover_tests"')) {
    const transportIndex = content.indexOf('const transport = new StdioServerTransport();');
    if (transportIndex !== -1) {
        content = content.slice(0, transportIndex) + phase5Tools + "\\n" + content.slice(transportIndex);
        fs.writeFileSync('mcp/src/server.ts', content);
        console.log("Patched server.ts with Phase 5 tools.");
    }
}
