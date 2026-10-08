const fs = require('fs');
const file = 'c:\\Users\\Yash\\Desktop\\mcp\\secufusion-mcp\\mcp\\src\\server.ts';
let content = fs.readFileSync(file, 'utf8');

const regex = /const hasBackend = .*?\n.*?const missingWarning = .*?;\n\n    return \{ \n       missingWarning,\n       extensionCount/s;

const replacement = `const hasBackend = (models.length > 0 || apis.length > 0 || nodeApis.length > 0);
    const hasFrontend = frontend.length > 0;
    const hasExtension = extension.length > 0;
    
    const inspection = inspectWorkspaceRepositories(ecosystemRoot);
    const missing = inspection.core_missing;
    const missingWarning = missing.length > 0 ? \`\\n\\n[CRITICAL CORE CHECK] The following core repositories are missing from the workspace: \${missing.join(', ')}. Evidence logic and planning will be blocked or degraded.\` : "";

    return { 
       missingWarning,
       inspectionStatus: inspection.status,
       extensionCount`;

content = content.replace(regex, replacement);
fs.writeFileSync(file, content, 'utf8');
console.log("Patched via regex.");
