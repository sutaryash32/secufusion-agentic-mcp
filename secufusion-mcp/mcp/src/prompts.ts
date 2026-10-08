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

export function registerPrompts(server: any): void {


// ─── MCP Prompts (appear as slash commands in Claude IDE picker) ──────────────

server.prompt(
  "sfn-init",
  "Prime the SecuFusion ecosystem — scan the entire codebase, map the architectural DNA (services, models, APIs, events), and write it to .secufusion/dna.json. Run this once when you first open a new project.",
  {
    workspace_root: z.string().describe("Absolute path to the project root. Leave blank to use the current working directory.")
  },
  ({ workspace_root }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `You are executing **sfn:init** — the SecuFusion DNA bootstrap command.

Workspace root: ${workspace_root || process.cwd()}

**This is a learn-first command. Do NOT write implementation code. Study THIS project and produce real findings.**

## Phase 1 — SCAN (run all 4 tool calls concurrently in a single message)
1. Call \`scan_repository_stack\` — identify language, framework, microservices, build/test commands. Flag monorepos.
2. Call \`extract_domain_models\` — map all domain entities, fields, and relationships.
3. Call \`extract_api_endpoints\` — map all REST/GraphQL endpoints, methods, and owning services.
4. Call \`extract_event_topics\` — map all Kafka/event-bus topics, producers, and consumers.

## Phase 2 — WRITE DNA
- Write combined findings to \`.secufusion/dna.json\` at the workspace root.
- Update the \`<MEMORY>\` block in \`agents/claude.md\`: set \`DNA_LOADED = true\`, \`LAST_INIT\` = now, and \`ARCHITECTURE_SUMMARY\` = a 2-3 sentence human-readable summary.

## Phase 3 — REPORT
- Count: services, domain models, API endpoints, event topics found.
- Flag anything marked \`(inferred)\` that the human should verify.
- Confirm \`.secufusion/dna.json\` was written successfully.

**Next step:** Run \`/sfn-spec\` with a ticket ID to start your first task.`
      }
    }]
  })
);


server.prompt(
  "sfn-watch",
  "Enable continuous background DNA learning — starts a file watcher that automatically re-syncs .secufusion/dna.json whenever source files change.",
  {
    workspace_root: z.string().describe("Absolute path to the project root to watch.")
  },
  ({ workspace_root }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `You are executing **sfn:watch** — the SecuFusion continuous DNA watcher.

Workspace root: ${workspace_root || process.cwd()}

Call \`start_dna_watcher\` with workspace_root = "${workspace_root || process.cwd()}".

This will start a background file watcher that automatically re-scans and updates \`.secufusion/dna.json\` whenever source files are modified, keeping the architectural knowledge graph fresh without manual re-runs of \`/sfn-init\`.

Confirm to the user when the watcher is active and which directory is being watched.`
      }
    }]
  })
);
}
