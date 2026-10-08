import fs from 'fs';
import path from 'path';

let classifyTaskHandler;

global.server = {
    tool: (name, desc, schema, handler) => {
        if (name === 'classify_task') classifyTaskHandler = handler;
    },
    resource: () => { },
    prompt: () => { }
};

global.appendTelemetry = (result) => result.content[0].text;
global.getWorkspaceRoot = () => process.cwd();
global.readFileSafe = (p) => {
    if (p.includes('REJECTED_FILE') || p.includes('.rejected-patterns.json')) return '[]';
    if (p.includes('.secufusion-project-spec.json')) return '{"microservices":{}}';
    return null;
};
global.resolve = (p) => p;
global.writeFile = () => { };
global.readRegistry = () => [];
global.REJECTED_FILE = '.rejected-patterns.json';
import { z } from 'zod';
global.z = z;

// Load index.js to register tools
import './secufusion-mcp/index.js';

setTimeout(async () => {
    if (!classifyTaskHandler) {
        console.error("classifyTaskHandler not found!");
        process.exit(1);
    }

    async function runTest(id, input) {
        console.log(`\n--- Test ${id} ---`);
        const result = await classifyTaskHandler(input);
        console.log(result.substring(0, 1500));
    }

    await runTest('3: misleading title', {
        work_item_id: "BUG-1140",
        title: "Tenant dashboard not loading",
        description: "When a tenant admin clicks delete on a tenant, the API returns HTTP 500 even though the tenant record is successfully deleted from the DB. The deletion works but response fails.",
        task_type: "bug"
    });

    await runTest('4: vague scope', {
        work_item_id: "WI-3050",
        title: "Fix the device issue",
        description: "Devices are not working properly",
        task_type: "bug"
    });

    await runTest('5: wrong task type', {
        work_item_id: "WI-3060",
        title: "Add bulk device export feature",
        description: "Implement a new endpoint that allows tenant admins to export all device data as CSV file",
        task_type: "bug"
    });

    await runTest('6: clean task', {
        work_item_id: "WI-2847",
        title: "Add MFA enforcement for admin login",
        description: "Admin users must complete TOTP verification before accessing any dashboard route. Service accounts are exempt. Redirect to /mfa if not verified.",
        task_type: "user_story"
    });

    await runTest('7: architecture rule', {
        work_item_id: "BUG-1232",
        title: "Incident creation modal shows raw UTC time instead of local time",
        description: "The Incident Creation Modal must display all timestamps converted to the user's local browser timezone. The UI must format the timestamp in a human-readable local format rather than displaying raw ISO 8601 UTC strings. Any timestamp data sent back to the backend during form submission must remain in standard UTC format.",
        task_type: "bug"
    });
}, 500);
