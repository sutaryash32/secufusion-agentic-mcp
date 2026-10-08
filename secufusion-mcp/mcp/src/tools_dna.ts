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




let watcher: any = null;

export function registerDnaTools(server: any): void {




server.tool(
  "scan_repository_stack",
  "Analyzes the ecosystem root to identify the framework and infrastructure",
  {
    workspace_root: z.string().describe("Root directory of the workspace")
  },
  async ({ workspace_root }) => {
    try {
      const ecosystemRoot = getEcosystemRoot(workspace_root);
      ensureDnaFile(ecosystemRoot);
      const files = fs.readdirSync(ecosystemRoot);
      // Markers are looked for at the root AND one level down: a poly-repo workspace keeps its services in subfolders.
      const MARKERS: Array<[string, string[]]> = [
        ["Java/Spring", ["pom.xml", "build.gradle", "build.gradle.kts"]],
        ["Node.js", ["package.json"]],
        ["Go", ["go.mod"]],
        ["Python", ["requirements.txt", "pyproject.toml"]],
        ["Rust", ["Cargo.toml"]],
        ["Docker", ["docker-compose.yml", "docker-compose.yaml", "Dockerfile"]],
      ];
      const found: Record<string, string[]> = {};
      const note = (label: string, where: string) => { (found[label] ??= []).includes(where) || found[label].push(where); };
      for (const [label, names] of MARKERS) if (names.some((n) => files.includes(n))) note(label, "(root)");
      for (const f of files) {
        const full = path.join(ecosystemRoot, f);
        if (f.startsWith(".") || f === "node_modules") continue;
        let kids: string[] = [];
        try { if (!fs.statSync(full).isDirectory()) continue; kids = fs.readdirSync(full); } catch { continue; }
        for (const [label, names] of MARKERS) if (names.some((n) => kids.includes(n))) note(label, f);
      }
      const stack = Object.entries(found).map(([label, where]) => {
        const sub = where.filter((w) => w !== "(root)");
        return sub.length ? `${label} (${sub.length} project${sub.length === 1 ? "" : "s"}: ${sub.slice(0, 8).join(", ")}${sub.length > 8 ? ", …" : ""}${where.includes("(root)") ? ", root" : ""})` : label;
      });
      
      let warningMsg = "";
      
      // Look for .secufusion-project-spec.json in ecosystemRoot or workspaceRoot
      const specPathEcosystem = path.join(ecosystemRoot, ".secufusion-project-spec.json");
      const specPathWorkspace = path.join(workspace_root, ".secufusion-project-spec.json");
      const specPath = fs.existsSync(specPathWorkspace) ? specPathWorkspace : (fs.existsSync(specPathEcosystem) ? specPathEcosystem : null);

      if (specPath) {
        try {
          const specData = JSON.parse(fs.readFileSync(specPath, "utf-8"));
          if (specData) {
            let expectedServices: string[] = [];
            if (specData.microservices) {
              expectedServices = expectedServices.concat(Object.keys(specData.microservices));
            }
            if (specData.frontend && specData.frontend.repo) {
              expectedServices.push(specData.frontend.repo);
            }
            if (specData.chrome_extension && specData.chrome_extension.repo) {
              expectedServices.push(specData.chrome_extension.repo);
            }
            
            const physicalDirs = files.filter(f => fs.statSync(path.join(ecosystemRoot, f)).isDirectory());
            const missingServices = expectedServices.filter(svc => !physicalDirs.includes(svc));
            
            if (missingServices.length > 0) {
              warningMsg = `\n\n[WARNING] According to .secufusion-project-spec.json, the following mandatory repositories (microservices/frontend/ext) are missing from your local workspace: ${missingServices.join(", ")}. Please clone them to ensure a complete DNA map.`;
            }
          }
        } catch(e) {
           warningMsg = `\n\n[WARNING] Failed to parse .secufusion-project-spec.json: ${e.message}`;
        }
      }

      return {
        content: [{ type: "text", text: `Scanned ecosystem at ${ecosystemRoot}. Detected stack: ${stack.join(", ")}${warningMsg}` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);


server.tool(
  "extract_domain_models",
  "Parses files across the ecosystem to build the Domain Encyclopedia and checks Golden Rules",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
  },
  async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const stats = performFullExtraction(ecosystemRoot);
        return {
        content: [{ type: "text", text: `Extracted ${stats.modelsCount} domain models. Derived ${stats.inferredCount} architectural patterns.${stats.missingWarning}` }]
        };
    } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);


server.tool(
  "extract_api_endpoints",
  "Scans for REST/GraphQL endpoints across the ecosystem",
  {
    workspace_root: z.string().describe("Root directory of the workspace")
  },
  async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const stats = performFullExtraction(ecosystemRoot);
        return {
        content: [{ type: "text", text: `Extracted ${stats.apisCount} API controllers. Derived ${stats.inferredCount} architectural patterns.${stats.missingWarning}` }]
        };
    } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);


server.tool(
  "extract_event_topics",
  "Scans for event listener/producer usage across the ecosystem",
  {
    workspace_root: z.string().describe("Root directory of the workspace")
  },
  async ({ workspace_root }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const stats = performFullExtraction(ecosystemRoot);
        return {
        content: [{ type: "text", text: `Extracted ${stats.eventsCount} event classes. Derived ${stats.inferredCount} architectural patterns.${stats.missingWarning}` }]
        };
    } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);


server.tool(
  "investigate_entity",
  "Deterministically searches the repository evidence graph for a specific entity.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    entity_name: z.string().describe("Name of the entity to investigate (e.g. 'User', 'Tenant')")
  },
  async ({ workspace_root, entity_name }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: `No DNA found. Run extraction first.` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph) return { content: [{ type: "text", text: "No graph in DNA." }] };
        
        const res = investigateEntity(graph, entity_name);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);


server.tool(
  "investigate_relationship",
  "Deterministically searches the repository evidence graph for relationships between two entities.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    source_entity: z.string().describe("First entity"),
    target_entity: z.string().describe("Second entity")
  },
  async ({ workspace_root, source_entity, target_entity }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: `No DNA found. Run extraction first.` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph) return { content: [{ type: "text", text: "No graph in DNA." }] };
        
        const res = investigateRelationship(graph, source_entity, target_entity);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);


server.tool(
  "query_knowledge_graph",
  "Targeted querying against the SecuFusion knowledge graph.",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    query: z.string().describe("What to search for (e.g., 'User', 'tenantId', 'DeviceEntity'). Matches against name, id, and properties."),
    node_type: z.string().optional().describe("Optional filter by node type (e.g., 'SERVICE', 'CLASS', 'TOPIC')."),
    max_depth: z.number().optional().describe("Max relationship traversal depth (default 1).")
  },
  async ({ workspace_root, query, node_type, max_depth }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: `No DNA found at ${dnaPath}.` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph) return { content: [{ type: "text", text: "Graph snapshot not found in DNA. Run an extraction first." }] };

        const queryLower = query.toLowerCase();
        const depth = max_depth || 1;
        
        let startNodes = graph.nodes.filter(n => 
            (n.id.toLowerCase().includes(queryLower) || n.name.toLowerCase().includes(queryLower)) &&
            (!node_type || n.type === node_type)
        );

        const resultNodes = new Map();
        const resultEdges = new Map();

        let currentLayer = startNodes;
        for (let d = 0; d <= depth; d++) {
            const nextLayer = [];
            for (const n of currentLayer) {
                if (!resultNodes.has(n.id)) resultNodes.set(n.id, n);
            }
            if (d < depth) {
                for (const edge of graph.edges) {
                    if (resultNodes.has(edge.source) || resultNodes.has(edge.target)) {
                        if (!resultEdges.has(edge.id)) {
                            resultEdges.set(edge.id, edge);
                            const sourceNode = graph.nodes.find(n => n.id === edge.source);
                            const targetNode = graph.nodes.find(n => n.id === edge.target);
                            if (sourceNode && !resultNodes.has(sourceNode.id)) nextLayer.push(sourceNode);
                            if (targetNode && !resultNodes.has(targetNode.id)) nextLayer.push(targetNode);
                        }
                    }
                }
            }
            currentLayer = nextLayer;
        }

        const result = {
            query,
            depth_searched: depth,
            nodes_found: resultNodes.size,
            edges_found: resultEdges.size,
            nodes: Array.from(resultNodes.values()),
            edges: Array.from(resultEdges.values())
        };

        return { content: [{ type: "text", text: `EVIDENCE_GRAPH:\n${JSON.stringify(result, null, 2)}` }] };
    } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);


server.tool(
  "calculate_blast_radius",
  "Calculates the impact of changing a specific component, entity, or API using graph relationships",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    component_name: z.string().describe("Name of the component, entity, or API to analyze")
  },
  async ({ workspace_root, component_name }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) return { content: [{ type: "text", text: `No DNA found at ${dnaPath}.` }] };
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        const graph = dna.graph;
        if (!graph) return { content: [{ type: "text", text: "Graph snapshot not found in DNA. Run an extraction first." }] };
        
        const compLower = component_name.toLowerCase();
        const startNodes = graph.nodes.filter(n => n.id.toLowerCase().includes(compLower) || n.name.toLowerCase().includes(compLower));
        
        const impacts = [];
        for (const node of startNodes) {
           impacts.push(`Impacts for ${node.id}:`);
           const relatedEdges = graph.edges.filter(e => e.source === node.id || e.target === node.id);
           for (const edge of relatedEdges) {
              const otherId = edge.source === node.id ? edge.target : edge.source;
              const direction = edge.source === node.id ? `-> ${edge.type} ->` : `<- ${edge.type} <-`;
              impacts.push(`  ${node.id} ${direction} ${otherId} (Evidence: ${edge.evidence?.filePath || 'Project Spec'})`);
           }
        }
        
        if (impacts.length === 0) impacts.push("No direct impacts found in graph.");
        
        return { content: [{ type: "text", text: `Blast Radius for '${component_name}':\n${impacts.join('\n')}` }] };
    } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);


server.tool(
  "load_external_env_file",
  "Loads an unmasked external environment file to override masked values in the knowledge graph",
  {
    workspace_root: z.string().describe("Root directory of the workspace"),
    absolute_file_path: z.string().describe("Absolute path to the unmasked .env or .properties file")
  },
  async ({ workspace_root, absolute_file_path }) => {
    try {
        const ecosystemRoot = getEcosystemRoot(workspace_root);
        if (!fs.existsSync(absolute_file_path)) {
            return { content: [{ type: "text", text: `File not found: ${absolute_file_path}` }], isError: true };
        }
        
        const content = fs.readFileSync(absolute_file_path, "utf-8");
        const realValues = parseExternalEnv(content);
        
        const dnaPath = getDnaPath(ecosystemRoot);
        if (!fs.existsSync(dnaPath)) {
            return { content: [{ type: "text", text: `No DNA found at ${dnaPath}.` }], isError: true };
        }
        
        const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        let updatedCount = 0;
        
        if (dna.configurations) {
            for (const config of dna.configurations) {
                for (const entry of config.entries) {
                    if (entry.requiresRealValues && realValues[entry.key]) {
                        entry.value = realValues[entry.key];
                        entry.requiresRealValues = false;
                        updatedCount++;
                    }
                }
            }
        }
        
        writeDna(ecosystemRoot, dna);
        
        return {
            content: [{ type: "text", text: `Successfully loaded ${updatedCount} real configuration values into the Knowledge Graph.` }]
        };
    } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);


server.tool(
  "start_dna_watcher",
  "Starts a continuous file watcher to automatically sync the DNA when files are modified",
  {
    workspace_root: z.string().describe("Root directory of the workspace")
  },
  async ({ workspace_root }) => {
    try {
      if (watcher) {
        return { content: [{ type: "text", text: `DNA Watcher is already running.` }] };
      }
      const ecosystemRoot = getEcosystemRoot(workspace_root);
      
      watcher = chokidar.watch(ecosystemRoot, {
        ignored: /(^|[\/\\])\..|node_modules|target|build/,
        persistent: true
      });

      watcher.on('change', (path: string) => {
        if (VALID_EXTENSIONS.some(ext => path.endsWith(ext))) {
           console.log(`[DNA Watcher] Detected change in ${path}. Re-syncing DNA...`);
           performFullExtraction(ecosystemRoot);
        }
      });

      return {
        content: [{ type: "text", text: `Successfully started DNA File Watcher on ${ecosystemRoot}. The knowledge graph will now update automatically in the background.` }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error starting watcher: ${e.message}` }], isError: true };
    }
  }
);


// ─────────────────────────────────────────────────────────────────────────────




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
}
