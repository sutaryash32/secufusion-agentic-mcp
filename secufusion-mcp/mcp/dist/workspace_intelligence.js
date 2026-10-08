import fs from "fs";
import path from "path";
export const DEFAULT_WORKSPACE_CONFIG = {
    workspace: "SecuFusion",
    coreRepositories: ["sfn-iam-api", "sfn-events-api", "sfn-tenants-api", "sfn-web-ui"],
    optionalRepositories: [
        "sfn-auth-api", "sfn-policy-api", "sfn-notification-api",
        "sfn-packages-api", "sfn-rules", "sfn-browser-ext",
        "sfn-edge-ai", "sfn-gateway-api", "sfn-eureka-api",
        "sfn-devops-terraform", "sfn-k8s-apps-config", "sfn-seed-sql"
    ]
};
export function getWorkspaceConfig(ecosystemRoot) {
    const configPath = path.join(ecosystemRoot, ".secufusion", "workspace.json");
    if (fs.existsSync(configPath)) {
        try {
            return JSON.parse(fs.readFileSync(configPath, "utf-8"));
        }
        catch (e) {
            console.error("Failed to parse workspace.json", e);
        }
    }
    // Auto-generate if missing
    fs.mkdirSync(path.join(ecosystemRoot, ".secufusion"), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_WORKSPACE_CONFIG, null, 2), "utf-8");
    return DEFAULT_WORKSPACE_CONFIG;
}
export function inspectWorkspaceRepositories(ecosystemRoot) {
    const config = getWorkspaceConfig(ecosystemRoot);
    const result = {
        workspace_root: ecosystemRoot,
        workspace_name: config.workspace,
        core_found: [],
        core_missing: [],
        optional_found: [],
        optional_missing: [],
        unreadable: [],
        status: "UNKNOWN",
        snapshot_identity: new Date().toISOString()
    };
    const checkRepo = (repo, isCore) => {
        const repoPath = path.join(ecosystemRoot, repo);
        if (fs.existsSync(repoPath)) {
            try {
                fs.accessSync(repoPath, fs.constants.R_OK);
                if (fs.statSync(repoPath).isDirectory()) {
                    if (isCore)
                        result.core_found.push(repo);
                    else
                        result.optional_found.push(repo);
                }
                else {
                    result.unreadable.push(repo);
                    if (isCore)
                        result.core_missing.push(repo);
                    else
                        result.optional_missing.push(repo);
                }
            }
            catch (e) {
                result.unreadable.push(repo);
                if (isCore)
                    result.core_missing.push(repo);
                else
                    result.optional_missing.push(repo);
            }
        }
        else {
            if (isCore)
                result.core_missing.push(repo);
            else
                result.optional_missing.push(repo);
        }
    };
    config.coreRepositories.forEach(r => checkRepo(r, true));
    config.optionalRepositories.forEach(r => checkRepo(r, false));
    if (result.core_missing.length === 0) {
        result.status = "READY";
    }
    else if (result.core_found.length > 0) {
        result.status = "PARTIAL";
    }
    else {
        result.status = "BLOCKED";
    }
    return result;
}
export function getEvidenceCompleteness(ecosystemRoot) {
    const inspection = inspectWorkspaceRepositories(ecosystemRoot);
    return {
        completeness_status: inspection.status,
        missing_core: inspection.core_missing,
        missing_optional: inspection.optional_missing,
        unreadable: inspection.unreadable,
        message: inspection.status === "READY"
            ? "Core repository evidence is complete."
            : `Missing core evidence for: ${inspection.core_missing.join(', ')}. Reasoning may be blocked.`
    };
}
