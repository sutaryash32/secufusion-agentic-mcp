import fs from 'fs';
import path from 'path';
function migrateOldRecord(record) {
    return {
        id: record.id,
        title: record.title || "Untitled",
        summary: record.summary || record.description || "",
        category: record.category || "OTHER",
        lesson: record.lesson || record.description || "",
        context: record.context || "",
        trigger: record.trigger || "UNKNOWN",
        outcome: record.outcome || "UNKNOWN",
        confidence: record.confidence || "UNKNOWN",
        status: record.status || "VALIDATED", // legacy records assume validated
        created_at: record.created_at || new Date().toISOString(),
        updated_at: record.updated_at || new Date().toISOString(),
        related_artifacts: record.related_artifacts || [],
        source_requirement_id: record.source_requirement_id,
        source_plan_id: record.source_plan_id,
        source_validation_id: record.source_validation_id,
        source_test_result_ids: record.source_test_result_ids,
        source_traceability_ids: record.source_traceability_ids,
        repository_snapshot: record.repository_snapshot,
        affected_services: record.affected_services,
        affected_components: record.affected_components,
        affected_apis: record.affected_apis,
        affected_events: record.affected_events,
        affected_tables: record.affected_tables,
        evidence: record.evidence
    };
}
export function loadExperience(ecosystemRoot) {
    const p = path.join(ecosystemRoot, '.secufusion', 'experience.json');
    if (!fs.existsSync(p))
        return [];
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(data))
            return [];
        return data.map(record => migrateOldRecord(record));
    }
    catch {
        return [];
    }
}
export function saveExperience(ecosystemRoot, experienceList) {
    const dir = path.join(ecosystemRoot, '.secufusion');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'experience.json'), JSON.stringify(experienceList, null, 2));
}
export function recordExperience(ecosystemRoot, exp) {
    const list = loadExperience(ecosystemRoot);
    const now = new Date().toISOString();
    // Check if updating existing
    const existingIndex = list.findIndex(e => e.id === exp.id);
    if (existingIndex >= 0) {
        const updated = {
            ...list[existingIndex],
            ...exp,
            updated_at: now
        };
        list[existingIndex] = updated;
        saveExperience(ecosystemRoot, list);
        return updated;
    }
    const newExp = {
        id: exp.id || `EXP-${Date.now()}`,
        title: exp.title || "Untitled",
        summary: exp.summary || "",
        category: exp.category || "OTHER",
        lesson: exp.lesson || "",
        context: exp.context || "",
        trigger: exp.trigger || "UNKNOWN",
        outcome: exp.outcome || "UNKNOWN",
        confidence: exp.confidence || "UNKNOWN",
        status: exp.status || "PROPOSED",
        created_at: exp.created_at || now,
        updated_at: now,
        ...exp
    };
    list.push(newExp);
    saveExperience(ecosystemRoot, list);
    return newExp;
}
export function getEngineeringExperience(ecosystemRoot, query, contextFilters = {}) {
    const list = loadExperience(ecosystemRoot);
    // Bounded deterministic retrieval
    let matched = list.filter(exp => {
        let matches = false;
        if (exp.status === "RETIRED")
            return false;
        // Exact artifact relationships
        if (contextFilters.affected_components && exp.affected_components) {
            matches = matches || exp.affected_components.some(c => contextFilters.affected_components.includes(c));
        }
        if (contextFilters.affected_services && exp.affected_services) {
            matches = matches || exp.affected_services.some(s => contextFilters.affected_services.includes(s));
        }
        if (contextFilters.source_requirement_id && exp.source_requirement_id === contextFilters.source_requirement_id) {
            matches = true;
        }
        // Keyword similarity (fallback)
        if (query) {
            const q = query.toLowerCase();
            if (exp.title.toLowerCase().includes(q) || exp.summary.toLowerCase().includes(q) || exp.category.toLowerCase().includes(q)) {
                matches = true;
            }
        }
        return matches;
    });
    // Bound the results
    return matched.slice(0, 5);
}
export function findExperienceConflicts(ecosystemRoot) {
    const list = loadExperience(ecosystemRoot);
    // Simple mock detection for Phase 6
    // E.g. two experiences affecting same component with different outcomes or lessons
    const conflicting = [];
    const componentMap = new Map();
    for (const exp of list) {
        if (exp.status === "VALIDATED" && exp.affected_components) {
            for (const c of exp.affected_components) {
                if (!componentMap.has(c))
                    componentMap.set(c, []);
                componentMap.get(c).push(exp);
            }
        }
    }
    for (const [comp, exps] of componentMap.entries()) {
        if (exps.length > 1) {
            // Check if outcomes differ, or if lessons are different
            const outcomes = new Set(exps.map(e => e.outcome));
            const lessons = new Set(exps.map(e => e.lesson));
            if (outcomes.size > 1 || lessons.size > 1) {
                conflicting.push(...exps);
            }
        }
    }
    return [...new Set(conflicting)];
}
export function validateExperience(ecosystemRoot, id, validationEvidence) {
    const list = loadExperience(ecosystemRoot);
    const exp = list.find(e => e.id === id);
    if (!exp)
        throw new Error("Experience not found.");
    // In a real system we would verify the evidence links to real test results or requirements
    exp.status = "VALIDATED";
    exp.evidence = validationEvidence;
    exp.updated_at = new Date().toISOString();
    saveExperience(ecosystemRoot, list);
    return exp;
}
export function getExperienceContext(ecosystemRoot, id) {
    const list = loadExperience(ecosystemRoot);
    const exp = list.find(e => e.id === id);
    if (!exp)
        throw new Error("Experience not found.");
    return exp;
}
export function findRepeatedOutcomes(ecosystemRoot) {
    const list = loadExperience(ecosystemRoot);
    const outcomeMap = new Map();
    for (const exp of list) {
        if (exp.status === "VALIDATED" && exp.outcome) {
            if (!outcomeMap.has(exp.outcome))
                outcomeMap.set(exp.outcome, []);
            outcomeMap.get(exp.outcome).push(exp);
        }
    }
    const repeated = [];
    for (const [outcome, exps] of outcomeMap.entries()) {
        if (exps.length > 1 && outcome !== "UNKNOWN" && outcome !== "SUCCESS") {
            repeated.push({ outcome, occurrences: exps });
        }
    }
    return repeated;
}
export function markExperienceStale(ecosystemRoot, id, reason) {
    const list = loadExperience(ecosystemRoot);
    const exp = list.find(e => e.id === id);
    if (!exp)
        throw new Error("Experience not found.");
    exp.status = "STALE";
    exp.context = exp.context + `\nStale Reason: ${reason}`;
    exp.updated_at = new Date().toISOString();
    saveExperience(ecosystemRoot, list);
    return exp;
}
export function retireExperience(ecosystemRoot, id, reason) {
    const list = loadExperience(ecosystemRoot);
    const exp = list.find(e => e.id === id);
    if (!exp)
        throw new Error("Experience not found.");
    exp.status = "RETIRED";
    exp.context = exp.context + `\nRetirement Reason: ${reason}`;
    exp.updated_at = new Date().toISOString();
    saveExperience(ecosystemRoot, list);
    return exp;
}
export function linkExperience(ecosystemRoot, id, links) {
    const list = loadExperience(ecosystemRoot);
    const exp = list.find(e => e.id === id);
    if (!exp)
        throw new Error("Experience not found.");
    if (links.source_requirement_id)
        exp.source_requirement_id = links.source_requirement_id;
    if (links.source_plan_id)
        exp.source_plan_id = links.source_plan_id;
    if (links.source_validation_id)
        exp.source_validation_id = links.source_validation_id;
    if (links.source_test_result_ids) {
        exp.source_test_result_ids = [...new Set([...(exp.source_test_result_ids || []), ...links.source_test_result_ids])];
    }
    if (links.source_traceability_ids) {
        exp.source_traceability_ids = [...new Set([...(exp.source_traceability_ids || []), ...links.source_traceability_ids])];
    }
    exp.updated_at = new Date().toISOString();
    saveExperience(ecosystemRoot, list);
    return exp;
}
export function getLearningFeedback(ecosystemRoot, requirementId, planId) {
    const list = loadExperience(ecosystemRoot);
    return list.filter(exp => (exp.source_requirement_id === requirementId) ||
        (planId && exp.source_plan_id === planId));
}
