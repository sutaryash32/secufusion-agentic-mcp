export function generateTestObligations(plan) {
    const obligations = [];
    if (plan.api_changes.length > 0) {
        obligations.push("API tests covering happy/sad paths and authorization limits");
    }
    if (plan.database_changes.length > 0) {
        obligations.push("Persistence tests for new schema constraints and transaction limits");
    }
    if (plan.event_changes.length > 0) {
        obligations.push("Event publication/consumption tests for retry and idempotency");
    }
    if (plan.security_implications.length > 0) {
        obligations.push("Tenant isolation and authorization boundary tests");
    }
    return obligations;
}
export function aggregateValidation(reqStatus, planErrors, testObligations, testResults, traceabilityGaps, hasSecurityUnknowns) {
    let requirement = reqStatus === "CONFIRMED" ? "PASS" : "BLOCKED";
    let tests = "PASS";
    if (testObligations.length > 0) {
        if (testResults.length === 0) {
            tests = "UNKNOWN";
        }
        else {
            const hasFail = testResults.some(r => r.status === "FAIL" || r.status === "ERROR" || r.status === "TIMEOUT");
            const hasUnknown = testResults.some(r => r.status === "UNKNOWN" || r.status === "NOT_FOUND");
            if (hasFail) {
                tests = "FAIL";
            }
            else if (hasUnknown) {
                tests = "UNKNOWN";
            }
            else {
                tests = "PASS";
            }
        }
    }
    else {
        // No obligations, but maybe we should still fail if required. For now PASS.
    }
    let traceability = traceabilityGaps.length === 0 ? "PASS" : "FAIL";
    let authorization = hasSecurityUnknowns ? "UNKNOWN" : "PASS";
    if (planErrors.includes("STALE_EVIDENCE"))
        requirement = "STALE";
    if (planErrors.includes("USER_DECISION_REQUIRED: Destructive operations detected"))
        requirement = "BLOCKED";
    let overall = "PASS";
    // Evaluate overall state based on priority
    if (requirement === "BLOCKED" || planErrors.includes("BLOCKED")) {
        overall = "BLOCKED";
    }
    else if (requirement === "STALE") {
        overall = "STALE";
    }
    else if (authorization === "UNKNOWN" || planErrors.includes("UNRESOLVED_UNKNOWNS")) {
        overall = "UNKNOWN"; // Never convert UNKNOWN into PASS
    }
    else if (tests === "FAIL" || tests === "UNKNOWN" || traceability === "FAIL" || planErrors.length > 0) {
        overall = "FAIL";
    }
    return {
        overall,
        requirement,
        tests,
        traceability,
        authorization,
        details: planErrors.concat(traceabilityGaps.map(g => g.type))
    };
}
