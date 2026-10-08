import fs from 'fs';
import path from 'path';
export function loadPlan(ecosystemRoot, id) {
    const p = path.join(ecosystemRoot, '.secufusion', 'plans', id + '.json');
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
    catch {
        return null;
    }
}
export function savePlan(ecosystemRoot, plan) {
    const dir = path.join(ecosystemRoot, '.secufusion', 'plans');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    plan.updated_at = new Date().toISOString();
    if (!plan.created_at)
        plan.created_at = plan.updated_at;
    fs.writeFileSync(path.join(dir, plan.id + '.json'), JSON.stringify(plan, null, 2));
}
// Destructive operation keywords
const DESTRUCTIVE_KEYWORDS = ["DELETE", "DROP", "PURGE", "REMOVE", "REVOKE", "DISABLE", "HARD_DELETE", "MASS_DELETE", "anonymize", "cleanup", "invalidation"];
export function analyzeDestructiveOperations(plan) {
    const destructive = [];
    const allChanges = [
        ...plan.api_changes,
        ...plan.database_changes,
        ...plan.event_changes,
        ...plan.implementation_steps
    ].join(" ").toLowerCase();
    for (const keyword of DESTRUCTIVE_KEYWORDS) {
        if (allChanges.includes(keyword.toLowerCase())) {
            destructive.push(keyword);
        }
    }
    return destructive;
}
export function validatePlan(ecosystemRoot, plan) {
    const errors = [];
    // 1. Check Requirement exists and is CONFIRMED
    const reqPath = path.join(ecosystemRoot, '.secufusion', 'requirements', plan.requirement_id + '.json');
    if (!fs.existsSync(reqPath)) {
        errors.push("REQUIREMENT_NOT_FOUND");
    }
    else {
        const req = JSON.parse(fs.readFileSync(reqPath, "utf-8"));
        if (req.status !== "CONFIRMED") {
            errors.push("REQUIREMENT_NOT_CONFIRMED (" + req.status + ")");
        }
    }
    // 2. Check Stale Evidence
    // In a real system, we'd check if the snapshot_id matches current git commit or extraction timestamp
    const dnaPath = path.join(ecosystemRoot, ".secufusion", "dna.json");
    if (fs.existsSync(dnaPath)) {
        const stats = fs.statSync(dnaPath);
        // Simplified stale check: if plan is older than last extraction, it might be stale.
        if (new Date(plan.created_at).getTime() < stats.mtime.getTime()) {
            errors.push("STALE_EVIDENCE");
        }
    }
    // 3. Destructive Operations Guardrails
    const destructive = analyzeDestructiveOperations(plan);
    if (destructive.length > 0) {
        // If destructive operations exist, ensure they are explicitly confirmed in the requirement decisions
        let decisionFound = false;
        if (fs.existsSync(reqPath)) {
            const req = JSON.parse(fs.readFileSync(reqPath, "utf-8"));
            const decisionsStr = (req.decisions || []).join(" ").toLowerCase();
            if (destructive.some(d => decisionsStr.includes(d.toLowerCase()))) {
                decisionFound = true;
            }
        }
        if (!decisionFound) {
            errors.push("USER_DECISION_REQUIRED: Destructive operations detected (" + destructive.join(", ") + ") without explicit requirement decision.");
        }
    }
    // 4. Traceability & Tests
    if (!plan.test_obligations || plan.test_obligations.length === 0) {
        errors.push("MISSING_TEST_OBLIGATIONS");
    }
    // 5. Blockers & Unknowns
    if (plan.blockers && plan.blockers.length > 0) {
        errors.push("BLOCKED");
    }
    if (plan.unknowns && plan.unknowns.length > 0) {
        // Implementation-critical unknowns shouldn't exist
        errors.push("UNRESOLVED_UNKNOWNS");
    }
    return errors;
}
