const fs = require('fs');
const file = 'c:\\Users\\Yash\\Desktop\\mcp\\secufusion-mcp\\mcp\\src\\server.ts';
let content = fs.readFileSync(file, 'utf8');

const startStr = "const hasBackend = (models.length > 0 || apis.length > 0 || nodeApis.length > 0);";
const endStr = "extensionCount: extension.length,";

const startIndex = content.indexOf(startStr);
const endIndex = content.indexOf(endStr, startIndex);

if (startIndex !== -1 && endIndex !== -1) {
    const s2 = `const hasFrontend = frontend.length > 0;
    const hasExtension = extension.length > 0;
    
    const inspection = inspectWorkspaceRepositories(ecosystemRoot);
    const missing = inspection.core_missing;
    const missingWarning = missing.length > 0 ? \`\\n\\n[CRITICAL CORE CHECK] The following core repositories are missing from the workspace: \${missing.join(', ')}. Evidence logic and planning will be blocked or degraded.\` : "";

    return { 
       missingWarning,
       inspectionStatus: inspection.status,
       extensionCount: extension.length,`;
       
    const fullEndIndex = endIndex + endStr.length;
    content = content.slice(0, startIndex) + s2 + content.slice(fullEndIndex);
    fs.writeFileSync(file, content, 'utf8');
    console.log("REPLACED OK");
} else {
    console.log("NOT FOUND", startIndex, endIndex);
}
