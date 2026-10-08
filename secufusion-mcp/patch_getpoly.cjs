const fs = require('fs');

const file = 'c:\\Users\\Yash\\Desktop\\mcp\\secufusion-mcp\\mcp\\src\\server.ts';
let content = fs.readFileSync(file, 'utf8');

const target = `function getPolyRepoSourceFiles(ecosystemRoot: string): {path: string, repo: string}[] {
  let allFiles: {path: string, repo: string}[] = [];
  const children = fs.readdirSync(ecosystemRoot);
  
  for (const child of children) {
    const childPath = path.join(ecosystemRoot, child);
    if (fs.statSync(childPath).isDirectory() && (child.startsWith("sfn-") || child.startsWith("snf-") || child === "secufusion")) {
      allFiles = allFiles.concat(getAllSourceFiles(childPath, child));
    } else if (fs.statSync(childPath).isDirectory() && ecosystemRoot === childPath) {
       allFiles = allFiles.concat(getAllSourceFiles(childPath, path.basename(childPath)));
    }
  }
  return allFiles;
}`;

const replacement = `function getPolyRepoSourceFiles(ecosystemRoot: string): {path: string, repo: string}[] {
  let allFiles: {path: string, repo: string}[] = [];
  const inspection = inspectWorkspaceRepositories(ecosystemRoot);
  const activeRepos = [...inspection.core_found, ...inspection.optional_found];
  
  for (const child of activeRepos) {
    const childPath = path.join(ecosystemRoot, child);
    allFiles = allFiles.concat(getAllSourceFiles(childPath, child));
  }
  return allFiles;
}`;

content = content.replace(target, replacement);

const target2 = `    const hasFrontend = frontend.length > 0;
    const hasExtension = extension.length > 0;
    const missing = [];
    if (!hasBackend) missing.push("backend");
    if (!hasFrontend) missing.push("frontend");
    if (!hasExtension) missing.push("snf-browser-extn");
    const missingWarning = missing.length > 0 ? \`\\n\\n[CRITICAL CORE CHECK] The following core components are missing from the DNA map: \${missing.join(', ')}. Please verify if this is expected.\` : "";

    return { 
       missingWarning,
       extensionCount: extension.length,`;

const replacement2 = `    const hasFrontend = frontend.length > 0;
    const hasExtension = extension.length > 0;
    
    const inspection = inspectWorkspaceRepositories(ecosystemRoot);
    const missing = inspection.core_missing;
    const missingWarning = missing.length > 0 ? \`\\n\\n[CRITICAL CORE CHECK] The following core repositories are missing from the workspace: \${missing.join(', ')}. Evidence logic and planning will be blocked or degraded.\` : "";

    return { 
       missingWarning,
       inspectionStatus: inspection.status,
       extensionCount: extension.length,`;

content = content.replace(target2, replacement2);
fs.writeFileSync(file, content, 'utf8');
console.log("Patched server.ts");
