import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const serverPath = path.join(__dirname, 'secufusion-mcp', 'index.js');
const mcp = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

const req = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
        name: "classify_task",
        arguments: {
            work_item_id: "BUG-0001",
            title: "Incident creation modal shows raw UTC time instead of local time",
            description: "The incident creation modal is displaying UTC timestamps instead of the user's local timezone. Backend already sends UTC correctly per architecture standards.",
            task_type: "bug"
        }
    }
};

let output = '';

mcp.stdout.on('data', (data) => {
    output += data.toString();
    if (output.includes('"id":1')) {
        const lines = output.split('\n');
        for (const line of lines) {
            if (line.includes('"id":1')) {
                const res = JSON.parse(line);
                console.log(res.result.content[0].text);
                process.exit(0);
            }
        }
    }
});

mcp.stdin.write(JSON.stringify(req) + '\n');

setTimeout(() => {
    console.error("Timeout");
    process.exit(1);
}, 3000);
