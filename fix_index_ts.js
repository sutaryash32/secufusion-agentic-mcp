const fs = require('fs');

const indexTsPath = './secufusion-mcp/index.ts';
let indexTs = fs.readFileSync(indexTsPath, 'utf8');

let classifyTaskCode = fs.readFileSync('injected_classify_task.js', 'utf8');
const resourceStr = '// ─── Resource & Prompt for AGENTS.md ──────────────────────────────────────────';

// Remove resourceStr from the end of classify_task
classifyTaskCode = classifyTaskCode.replace(resourceStr, '');

// Read tools 11-15
const tools11_15Data = JSON.parse(fs.readFileSync('tools_11_15.json', 'utf8'))[0];
const tools11_15Code = tools11_15Data.args.ReplacementContent;

// Build the injected block
const injectedBlock = classifyTaskCode + '\n' + tools11_15Code + '\n' + resourceStr;

if (indexTs.includes(resourceStr)) {
    indexTs = indexTs.replace(resourceStr, injectedBlock);
    fs.writeFileSync(indexTsPath, indexTs);
    console.log('Successfully injected Tools 9 and 11-15 into index.ts!');
} else {
    console.error('ERROR: target string not found in index.ts');
    process.exit(1);
}
