const fs = require('fs');

let content = fs.readFileSync('mcp/src/server.ts', 'utf8');

// Replace the buggy `findTraceabilityGaps(dna.graph || { nodes: [], edges: [] }, edges);`
// with `findTraceabilityGaps(ecosystemRoot, dna.graph || { nodes: [], edges: [] }, edges);`

content = content.replace(
  "findTraceabilityGaps(dna.graph || { nodes: [], edges: [] }, edges);",
  "findTraceabilityGaps(ecosystemRoot, dna.graph || { nodes: [], edges: [] }, edges);"
);

fs.writeFileSync('mcp/src/server.ts', content);
console.log("Patched server.ts with ecosystemRoot for Phase 3 tools.");
