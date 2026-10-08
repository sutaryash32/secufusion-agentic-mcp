const fs = require('fs');
const file = 'c:\\Users\\Yash\\Desktop\\mcp\\secufusion-mcp\\mcp\\src\\server.ts';
let content = fs.readFileSync(file, 'utf8');

const regex = /server\.tool\(\s*['"]get_engineering_experience['"]/g;
let match;
const matches = [];
while ((match = regex.exec(content)) !== null) {
    matches.push(match.index);
}

if (matches.length > 1) {
    // Find the end of the second registration.
    const start = matches[1];
    let end = content.indexOf('server.tool(', start + 10);
    if (end === -1) end = content.indexOf('const transport', start);
    
    // Remove it
    content = content.slice(0, start) + content.slice(end);
    fs.writeFileSync(file, content, 'utf8');
    console.log("Removed duplicate at index", start);
}
