import fs from 'fs';
import path from 'path';
import { GraphSnapshot } from './graph_builder.js';
import { TraceabilityEdge } from './traceability_engine.js';
import { execSync } from 'child_process';

export interface TestResult {
    id: string;
    test_name: string;
    suite_name: string;
    repository: string;
    file_path: string;
    status: "PASS" | "FAIL" | "SKIPPED" | "ERROR" | "TIMEOUT" | "NOT_FOUND" | "BLOCKED" | "UNKNOWN";
    duration_ms: number;
    exit_code: number;
    failure_message?: string;
    failure_type?: "ASSERTION_FAILURE" | "COMPILATION_FAILURE" | "RUNTIME_EXCEPTION" | "TIMEOUT" | "CONFIGURATION_FAILURE" | "DEPENDENCY_FAILURE" | "DATABASE_FAILURE" | "EVENT_CONSUMPTION_FAILURE" | "AUTHORIZATION_FAILURE" | "TENANCY_FAILURE" | "NETWORK_FAILURE" | "TEST_DISCOVERY_FAILURE" | "UNKNOWN_FAILURE";
    stack_trace?: string;
    timestamp: string;
    execution_identity: string;
}

export function discoverTests(graph: GraphSnapshot, targetArtifacts: string[]): string[] {
    // Simulates mapping target artifacts (CLASS, API, etc.) to existing Test nodes in the graph
    const discoveredTests = new Set<string>();
    
    for (const artifact of targetArtifacts) {
        // e.g., if artifact is "CLASS:UserService", look for "CLASS:UserServiceTest"
        const artifactName = artifact.split(":").pop();
        if (!artifactName) continue;
        
        const possibleTests = graph.nodes.filter(n => n.name && n.name.includes(artifactName) && n.name.toLowerCase().includes("test"));
        for (const t of possibleTests) {
            discoveredTests.add(t.id);
        }
    }
    
    return Array.from(discoveredTests);
}

export function executeTests(ecosystemRoot: string, testCommand: string, workingDir: string): TestResult[] {
    // Bounded and controlled execution
    const results: TestResult[] = [];
    const executionIdentity = `EXEC-${Date.now()}`;
    
    if (testCommand.includes("rm ") || testCommand.includes("del ") || testCommand.includes(">") || testCommand.includes("&")) {
        throw new Error("SECURITY_VIOLATION: Arbitrary shell execution rejected.");
    }
    
    try {
        const start = Date.now();
        // We capture output deterministically
        const output = execSync(testCommand, { 
            cwd: path.join(ecosystemRoot, workingDir),
            timeout: 30000,
            encoding: "utf-8"
        });
        const duration = Date.now() - start;
        
        let parsed = false;
        // Attempt to parse output as JSON (e.g., if jest --json was used)
        try {
            const jsonStart = output.indexOf('{');
            const jsonEnd = output.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                const jsonStr = output.substring(jsonStart, jsonEnd + 1);
                const jsonOut = JSON.parse(jsonStr);
                if (jsonOut.testResults) {
                jsonOut.testResults.forEach((tr: any) => {
                    results.push({
                        id: `TR-${Date.now()}-${Math.random()}`,
                        test_name: tr.name || "Test",
                        suite_name: testCommand,
                        repository: workingDir,
                        file_path: tr.name || "UNKNOWN",
                        status: tr.status === "passed" ? "PASS" : "FAIL",
                        duration_ms: tr.endTime - tr.startTime || duration,
                        exit_code: 0,
                        timestamp: new Date().toISOString(),
                        execution_identity: executionIdentity
                    });
                });
                parsed = true;
                }
            }
        } catch (e) {
            // Not JSON output, fallback
        }
        
        if (!parsed) {
            results.push({
                id: `TR-${Date.now()}`,
                test_name: "Generic Test Execution",
                suite_name: testCommand,
                repository: workingDir,
                file_path: "UNKNOWN",
                status: "PASS",
                duration_ms: duration,
                exit_code: 0,
                timestamp: new Date().toISOString(),
                execution_identity: executionIdentity
            });
        }
    } catch (e: any) {
        let parsed = false;
        if (e.stdout || e.output) {
            try {
                const outStr = e.stdout ? e.stdout.toString() : e.output.toString();
                const jsonStart = outStr.indexOf('{');
                const jsonEnd = outStr.lastIndexOf('}');
                if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                    const jsonStr = outStr.substring(jsonStart, jsonEnd + 1);
                    const jsonOut = JSON.parse(jsonStr);
                    if (jsonOut.testResults) {
                    jsonOut.testResults.forEach((tr: any) => {
                        results.push({
                            id: `TR-${Date.now()}-${Math.random()}`,
                            test_name: tr.name || "Test",
                            suite_name: testCommand,
                            repository: workingDir,
                            file_path: tr.name || "UNKNOWN",
                            status: tr.status === "passed" ? "PASS" : "FAIL",
                            duration_ms: tr.endTime - tr.startTime || 0,
                            exit_code: e.status || 1,
                            failure_message: tr.message || "Failed",
                            failure_type: "ASSERTION_FAILURE",
                            timestamp: new Date().toISOString(),
                            execution_identity: executionIdentity
                        });
                    });
                    parsed = true;
                    }
                }
            } catch (err) {}
        }
        
        if (!parsed) {
            results.push({
                id: `TR-${Date.now()}`,
                test_name: "Generic Test Execution",
                suite_name: testCommand,
                repository: workingDir,
                file_path: "UNKNOWN",
                status: "FAIL",
                duration_ms: 0,
                exit_code: e.status || 1,
                failure_message: e.message || "Command failed",
                failure_type: "UNKNOWN_FAILURE",
                timestamp: new Date().toISOString(),
                execution_identity: executionIdentity
            });
        }
    }
    
    saveTestResults(ecosystemRoot, results);
    return results;
}

export function ingestTestResults(ecosystemRoot: string, resultArtifacts: TestResult[]) {
    saveTestResults(ecosystemRoot, resultArtifacts);
    return resultArtifacts.length;
}

export function loadTestResults(ecosystemRoot: string): TestResult[] {
    const p = path.join(ecosystemRoot, '.secufusion', 'tests', 'results.json');
    if (!fs.existsSync(p)) return [];
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
        return [];
    }
}

export function saveTestResults(ecosystemRoot: string, results: TestResult[]) {
    const dir = path.join(ecosystemRoot, '.secufusion', 'tests');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const existing = loadTestResults(ecosystemRoot);
    const combined = [...existing, ...results];
    
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(combined, null, 2));
}

export function correlateTestFailure(graph: GraphSnapshot, traceability: TraceabilityEdge[], failure: TestResult) {
    const correlated = [];
    
    // Exact Test File Match
    if (failure.file_path && failure.file_path !== "UNKNOWN") {
        const fileNode = graph.nodes.find(n => n.evidence?.filePath === failure.file_path);
        if (fileNode) correlated.push({ id: fileNode.id, confidence: "DIRECT" });
    }
    
    // Stack Trace Inference
    if (failure.stack_trace) {
        for (const node of graph.nodes) {
            if (node.name && failure.stack_trace.includes(node.name)) {
                correlated.push({ id: node.id, confidence: "INFERRED" });
            }
        }
    }
    
    // Traceability links from the test
    const testLinks = traceability.filter(t => t.source === `TEST:${failure.test_name}` || t.source === `CLASS:${failure.suite_name}`);
    for (const link of testLinks) {
        correlated.push({ id: link.target, confidence: "SUPPORTED" });
    }
    
    return correlated;
}
