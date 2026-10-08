const fs = require('fs');
const file = 'c:\\Users\\Yash\\Desktop\\mcp\\secufusion-mcp\\mcp\\src\\server.ts';
let content = fs.readFileSync(file, 'utf8');

const s1 = `        const hasBackend = (models.length > 0 || apis.length > 0 || nodeApis.length > 0);
    const hasFrontend = frontend.length > 0;
    const hasExtension = extension.length > 0;
    const missing = [];
    if (!hasBackend) missing.push("backend");
    if (!hasFrontend) missing.push("frontend");
    if (!hasExtension) missing.push("snf-browser-extn");
    const missingWarning = missing.length > 0 ? \`\\n\\n[CRITICAL CORE CHECK] The following core components are missing from the DNA map: \${missing.join(', ')}. Please verify if this is expected.\` : "";

    return { 
       missingWarning,
       extensionCount: extension.length,`;

const s2 = `    const hasFrontend = frontend.length > 0;
    const hasExtension = extension.length > 0;
    
    const inspection = inspectWorkspaceRepositories(ecosystemRoot);
    const missing = inspection.core_missing;
    const missingWarning = missing.length > 0 ? \`\\n\\n[CRITICAL CORE CHECK] The following core repositories are missing from the workspace: \${missing.join(', ')}. Evidence logic and planning will be blocked or degraded.\` : "";

    return { 
       missingWarning,
       inspectionStatus: inspection.status,
       extensionCount: extension.length,`;

if (content.indexOf(s1) !== -1) {
    content = content.replace(s1, s2);
    fs.writeFileSync(file, content, 'utf8');
    console.log("REPLACED OK");
} else {
    console.log("NOT FOUND S1");
}

