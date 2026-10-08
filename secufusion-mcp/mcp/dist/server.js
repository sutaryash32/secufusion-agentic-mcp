#!/usr/bin/env node
// @ts-nocheck
/**
 * SecuFusion MCP Server — entry point.
 * Tools live in tools_*.ts (one register function per group); shared helpers are in shared.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTasksTools } from "./tools_tasks.js";
import { registerAnalysisTools } from "./tools_analysis.js";
import { registerSpecTools } from "./tools_spec.js";
import { registerExperienceTools } from "./tools_experience.js";
import { registerTestsTools } from "./tools_tests.js";
import { registerDnaTools } from "./tools_dna.js";
import { registerPrompts } from "./prompts.js";
const server = new McpServer({
    name: "secufusion-mcp",
    version: "1.0.0",
});
registerTasksTools(server);
registerAnalysisTools(server);
registerSpecTools(server);
registerExperienceTools(server);
registerTestsTools(server);
registerDnaTools(server);
registerPrompts(server);
const transport = new StdioServerTransport();
await server.connect(transport);
