const fs = require('fs');
const file = 'c:\\Users\\Yash\\Desktop\\mcp\\README.md';
if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');
    const newContent = `
## Phase 9 Features Added
- Config-driven deterministic Workspace Discovery (\`.secufusion/workspace.json\`)
- Dynamic Core vs Optional Repository Classification
- Evidence Completeness Engine (\`get_evidence_completeness\`)
- Portable Workspace Paths (No hardcoded paths)
`;
    content = content + newContent;
    fs.writeFileSync(file, content, 'utf8');
    console.log("Appended Phase 9 to README");
} else {
    console.log("README.md not found");
}
