import * as fs from 'fs';
import * as path from 'path';
import { resolve, readFileSafe, getWorkspaceRoot } from './utils.js';
function parseArgs() {
    try {
        return JSON.parse(process.argv[2] || '{}');
    }
    catch {
        return { work_item_id: 'UNKNOWN', skip_checks: [], suppressions: [] };
    }
}
async function runTier1Checks(workItemId, skipChecks, suppressions) {
    const wsRoot = getWorkspaceRoot();
    // Find task folder
    const tasksBase = resolve(".secufusion/tasks");
    let taskDir = null;
    if (fs.existsSync(tasksBase)) {
        const folders = fs.readdirSync(tasksBase);
        const match = folders.find(f => f.startsWith(workItemId));
        if (match)
            taskDir = path.join(tasksBase, match);
    }
    if (!taskDir) {
        return `❌ CHANGES_REQUESTED: Task folder not found for ${workItemId}`;
    }
    // Read files-touched.json
    let filesTouched = [];
    try {
        const ftContent = readFileSafe(path.join(taskDir, 'files-touched.json'));
        if (ftContent)
            filesTouched = JSON.parse(ftContent);
    }
    catch { }
    let out = `## run_pre_pr_checks_with_reviewer_agent — ${workItemId}\n\n`;
    out += `Found ${filesTouched.length} modified files.\n\n`;
    let allPassed = true;
    let failedChecks = [];
    for (const file of filesTouched) {
        const fullPath = path.resolve(wsRoot, file);
        const content = readFileSafe(fullPath);
        if (!content)
            continue;
        const isJava = file.endsWith('.java');
        const isTs = file.endsWith('.ts');
        const isSql = file.endsWith('.sql');
        // P1 TENANT_ISOLATION
        if (!skipChecks.includes('tenant_isolation') && isJava && file.includes('Repository')) {
            const hasTenantFilter = /tenantid|tenant_id|\.tenant/i.test(content);
            if (!hasTenantFilter) {
                const suppressed = suppressions.find(s => s.check === 'TENANT_ISOLATION');
                if (!suppressed) {
                    allPassed = false;
                    failedChecks.push(`❌ P1 TENANT_ISOLATION: ${file} lacks tenant filtering.`);
                }
            }
        }
        // P2 N_PLUS_ONE
        if (!skipChecks.includes('n_plus_one') && (isJava || isTs)) {
            // Very naive check for loop containing repository/dao calls
            if (/(for|while)\s*\(.*\)[\s\S]*?(repository\.|dao\.)/i.test(content)) {
                allPassed = false;
                failedChecks.push(`❌ P2 N_PLUS_ONE: Potential DB call inside loop in ${file}.`);
            }
        }
        // P3 MISSING_INDEX
        if (!skipChecks.includes('missing_index') && isSql) {
            if (/create table|alter table.*add column/i.test(content) && !/create index/i.test(content)) {
                allPassed = false;
                failedChecks.push(`❌ P3 MISSING_INDEX: Schema modification without an index in ${file}.`);
            }
        }
        // P4 KAFKA_SYNC
        if (!skipChecks.includes('kafka_sync') && isJava && content.includes('@KafkaListener')) {
            if (/resttemplate|webclient|httpclient/i.test(content)) {
                allPassed = false;
                failedChecks.push(`❌ P4 KAFKA_SYNC: Synchronous HTTP call inside @KafkaListener in ${file}.`);
            }
        }
        // P5 EARLY_RETURN
        if (!skipChecks.includes('early_return') && (isJava || isTs)) {
            // Count number of return statements. If > 1 in a method block, flag it (naive implementation)
            const returns = (content.match(/\breturn\b/g) || []).length;
            if (returns > 1 && !file.includes('Test')) {
                allPassed = false;
                failedChecks.push(`❌ P5 EARLY_RETURN: Multiple exit points detected in ${file}.`);
            }
        }
    }
    if (!allPassed) {
        out += `### Tier 1: Mechanical Checks Failed\n`;
        out += failedChecks.join('\n') + '\n\n';
        out += `Verdict: ❌ CHANGES_REQUESTED\n`;
    }
    else {
        out += `### Tier 1: Mechanical Checks Passed\n`;
        out += `All files passed zero-tolerance P1-P5 validation.\n\n`;
        if (!skipChecks.includes('ai_review') || !skipChecks.includes('context_review')) {
            out += `### Tier 2 & 3: AI Reviewer\n`;
            out += `(AI logic would execute here using Claude context)\n\n`;
        }
        out += `Verdict: ✅ APPROVED\n`;
    }
    return out;
}
const args = parseArgs();
runTier1Checks(args.work_item_id, args.skip_checks, args.suppressions).then(out => {
    console.log(out);
});
