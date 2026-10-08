const fs = require('fs');
const path = require('path');
const agentsPath = 'c:/Users/Yash/Desktop/mcp/.agents/AGENTS.md';
const agentsContent = fs.readFileSync(agentsPath, 'utf8');

const lines = agentsContent.split('\n');
let headerLines = [];
let plannerLines = [];
let coderLines = [];
let reviewerLines = [];

let currentSection = 'header';

for (const line of lines) {
    if (line.startsWith('## Phase 00') || line.startsWith('## Phase 0.5') || line.startsWith('## Phase 0.6') || line.startsWith('## Phase 0.7') || line.startsWith('## Phase 1')) {
        currentSection = 'planner';
    } else if (line.startsWith('## Phase 2') || line.startsWith('## Phase 3')) {
        currentSection = 'coder';
    } else if (line.startsWith('## Phase 4') || line.startsWith('## Phase 5')) {
        currentSection = 'reviewer';
    }

    if (currentSection === 'header') headerLines.push(line);
    else if (currentSection === 'planner') plannerLines.push(line);
    else if (currentSection === 'coder') coderLines.push(line);
    else if (currentSection === 'reviewer') reviewerLines.push(line);
}

fs.writeFileSync('c:/Users/Yash/Desktop/mcp/.agents/planner.md', plannerLines.join('\n'));
fs.writeFileSync('c:/Users/Yash/Desktop/mcp/.agents/coder.md', coderLines.join('\n'));
fs.writeFileSync('c:/Users/Yash/Desktop/mcp/.agents/reviewer.md', reviewerLines.join('\n'));

const newAgentsRouter = `# SecuFusion MCP Workflow Router

You are an elite Senior Developer and Architect. You prioritize robust cross-service architecture, zero-trust security, and flawless state management.

## Thin Index Routing
Do not attempt to load all instructions into memory. Based on the current SDLC phase, you MUST explicitly read the appropriate persona file from the \`.agents/\` directory:

1. **Planning Phase (Phase 00 to 1):** Read \`[planner.md](file:///C:/Users/Yash/Desktop/mcp/.agents/planner.md)\`
2. **Execution Phase (Phase 2 to 3):** Read \`[coder.md](file:///C:/Users/Yash/Desktop/mcp/.agents/coder.md)\`
3. **Review Phase (Phase 4 to 5):** Read \`[reviewer.md](file:///C:/Users/Yash/Desktop/mcp/.agents/reviewer.md)\`

---
\n` + headerLines.slice(4).join('\n'); // skip original preamble

fs.writeFileSync(agentsPath, newAgentsRouter);
console.log('Split AGENTS.md successfully.');
