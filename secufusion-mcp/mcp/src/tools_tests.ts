// @ts-nocheck
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { execSync, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { Requirement, loadRequirement, saveRequirement, validateStateTransition, generateConfirmedSpecification } from "./requirement_manager.js";
import { discoverTests, executeTests, ingestTestResults, loadTestResults, correlateTestFailure } from "./test_engine.js";
import { loadPlan, savePlan, validatePlan, ImplementationPlan } from "./implementation_plan.js";
import { generateTestObligations, aggregateValidation } from "./validation_engine.js";
import { recordExperience, loadExperience, getEngineeringExperience, validateExperience, getExperienceContext, findExperienceConflicts, findRepeatedOutcomes, markExperienceStale, retireExperience, linkExperience, getLearningFeedback } from "./experience_manager.js";
import { loadRequirement } from "./requirement_manager.js";
import { loadTraceability, addTraceabilityLink, traceForward, traceReverse, findTraceabilityGaps } from "./traceability_engine.js";
import { investigateEntity, investigateRelationship } from "./investigation_engine.js";
import { loadSnapshot, saveSnapshot, getRegressionContext, recordRegressionObservation, compareRepositorySnapshots, detectArchitectureDrift, detectRequirementDrift, detectTraceabilityDrift, getChangeHistoryContext, findRegressionTests, analyzeRegressionRisk } from "./regression_engine.js";
import { discoverUIPatterns, generateStaticUIReference, getDesignContext } from "./ui_intelligence.js";
import { buildGraph } from "./graph_builder.js";
import { parseDomainModels, DomainModel } from "./parsers/domain.js";
import { parseApiEndpoints, ApiEndpoint } from "./parsers/api.js";
import { parseEventTopics, EventTopic } from "./parsers/events.js";
import { inferPatterns } from "./parsers/patterns.js";
import { parseFrontend, FrontendComponent } from "./parsers/frontend.js";
import { inspectWorkspaceRepositories, getWorkspaceConfig, getEvidenceCompleteness } from "./workspace_intelligence.js";
import { parseExtension, ExtensionComponent } from "./parsers/extension.js";
import { parseNodeApis, NodeApi } from "./parsers/backend-node.js";
import { parseInfra, InfraResource } from "./parsers/infra.js";
import { parseDatabase, DatabaseEntity } from "./parsers/database.js";
import { parseSecurity, SecurityContext } from "./parsers/security.js";
import { parseConfig, parseExternalEnv, ConfigurationFile } from "./parsers/config.js";
import chokidar from "chokidar";
import { judge, judgmentParam, loadJudgment, hashOf } from "./judge.js";
import { recordGate, requireGates, readLedger, nextPhase, nextStepHint, PHASES } from "./gates.js";
import {
  PhilosophyVerdict, PhilosophyHint, PhilosophyRubric,
  ClassificationVerdict, ClassificationHint, ClassificationRubric,
  RequirementVerdict, RequirementHint, RequirementRubric,
  PlanVerdict, PlanHint, PlanRubric,
  ReviewVerdict, ReviewHint, ReviewRubric,
} from "./verdicts.js";
import { STATE_FILE, REJECTED_FILE, TOKEN_FILE, argv, rootFlag, ROOT, getWorkspaceRoot, resolve, readFileSafe, readJson, loadProjectSpec, writeFile, getCurrentBranch, loadMigrationSpec, getMigrationContextForService, getNextMigrationVersion, getMigrationGaps, findFilesRecursive, compressCode, appendTelemetry, specEvidence, textResult, INTENTS_DIR, TASKS_DIR, CLASSIFICATIONS_DIR, REGISTRY_FILE, slugify, nextIntentNumber, parseIntentFrontmatter, resolveTaskFolder, generateNewTaskFolder, readRegistry, writeRegistry, upsertRegistry, STOP_WORDS, extractSymptomWords, levenshteinClose, buildScopeText, getEcosystemRoot, getDnaPath, ensureDnaFile, readDna, writeDna, VALID_EXTENSIONS, getAllSourceFiles, getPolyRepoSourceFiles, generateMigrationSpec, performFullExtraction } from "./shared.js";

export function registerTestsTools(server: any): void {


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
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
        return { content: [{ type: "text", text: `Ingested ${count} test results.` }] };
    } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);
}
