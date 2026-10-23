#!/usr/bin/env node
// @ts-nocheck
/**
 * SecuFusion MCP Server — entry point.
 * Tools live in tools_*.ts (one register function per group); shared helpers are in shared.ts.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTasksTools } from "./tools_tasks.js";
import { registerAnalysisTools } from "./tools_analysis.js";
import { registerSpecTools } from "./tools_spec.js";
import { registerExperienceTools } from "./tools_experience.js";
import { registerTestsTools } from "./tools_tests.js";
import { registerDnaTools } from "./tools_dna.js";
import { registerExploreTools } from "./tools_explore.js";
import { registerReviewTools } from "./tools_review.js";
import { registerMaturityTools } from "./tools_maturity.js";
import { registerReleaseTools } from "./tools_release.js";
import { registerKnowledgeTools } from "./tools_knowledge.js";
import { registerSharperTools } from "./tools_sharper.js";
import { registerLedgerTools } from "./tools_ledger.js";
import { registerContextTools } from "./tools_context.js";
import { registerPrompts } from "./prompts.js";

// the version the server reports is the package version, never a second hand-maintained number
const packageVersion = (() => {
  try { return JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf-8")).version as string; }
  catch { return "0.0.0-unknown"; }
})();

const server = new McpServer({
  name: "secufusion-mcp",
  version: packageVersion,
});

registerTasksTools(server);
registerAnalysisTools(server);
registerSpecTools(server);
registerExperienceTools(server);
registerTestsTools(server);
registerDnaTools(server);
registerExploreTools(server);
registerReviewTools(server);
registerMaturityTools(server);
registerReleaseTools(server);
registerKnowledgeTools(server);
registerSharperTools(server);
registerLedgerTools(server);
registerContextTools(server);
registerPrompts(server);

const transport = new StdioServerTransport();
await server.connect(transport);
