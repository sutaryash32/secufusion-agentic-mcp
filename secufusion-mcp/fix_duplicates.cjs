const fs = require('fs');

let content = fs.readFileSync('mcp/src/server.ts', 'utf8');

const marker = 'server.tool(\n  "discover_tests",';
const firstIndex = content.indexOf(marker);
const secondIndex = content.indexOf(marker, firstIndex + 1);

if (secondIndex !== -1) {
    // Slice out from the second index to the line before const transport
    const endMarker = 'const transport = new StdioServerTransport();';
    const endIndex = content.indexOf(endMarker, secondIndex);
    
    if (endIndex !== -1) {
        content = content.slice(0, secondIndex) + content.slice(endIndex);
        fs.writeFileSync('mcp/src/server.ts', content);
        console.log("Removed duplicate tools.");
    }
} else {
    console.log("No duplicate found.");
}
