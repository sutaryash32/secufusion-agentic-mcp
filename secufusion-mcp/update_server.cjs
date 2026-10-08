const fs = require('fs');

let content = fs.readFileSync('mcp/src/server.ts', 'utf8');

const qkgTarget = `const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        
        const result = JSON.stringify(dna, null, 2);
        
        return {
            content: [{ type: "text", text: \`Ecosystem Knowledge Graph Data:\\n\${result}\` }]
        };`;

const qkgReplacement = `const dna = JSON.parse(fs.readFileSync(dnaPath, "utf-8"));
        
        const queryLower = query.toLowerCase();
        const results = {};
        let resultCount = 0;
        
        for (const [key, items] of Object.entries(dna)) {
            if (Array.isArray(items)) {
                const matches = items.filter((item) => JSON.stringify(item).toLowerCase().includes(queryLower));
                if (matches.length > 0) {
                    results[key] = matches;
                    resultCount += matches.length;
                }
            }
        }
        
        const result = JSON.stringify(results, null, 2);
        
        return {
            content: [{ type: "text", text: \`Ecosystem Knowledge Graph Data for query '\${query}' (found \${resultCount} items):\\n\${result}\` }]
        };`;

if (content.includes(qkgTarget)) {
    content = content.replace(qkgTarget, qkgReplacement);
    console.log('query_knowledge_graph updated.');
} else {
    // try removing carriage returns
    const qkgTarget2 = qkgTarget.replace(/\r/g, '');
    const content2 = content.replace(/\r/g, '');
    if (content2.includes(qkgTarget2)) {
        const index = content2.indexOf(qkgTarget2);
        const originalTarget = content.substring(index, index + qkgTarget2.length + (content.length - content2.length) ); // rough approximation
        // safer replacement
        content = content.replace(/const dna = JSON\.parse\(fs\.readFileSync\(dnaPath, "utf-8"\)\);\s*const result = JSON\.stringify\(dna, null, 2\);\s*return \{\s*content: \[\{ type: "text", text: `Ecosystem Knowledge Graph Data:\\n\$\{result\}` \}\]\s*\};/, qkgReplacement);
        console.log('query_knowledge_graph updated via regex.');
    } else {
        console.log('qkgTarget still not found.');
    }
}

fs.writeFileSync('mcp/src/server.ts', content);
