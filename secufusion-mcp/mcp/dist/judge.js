import fs from "fs";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { createEngine } from "./engine.js";
/** Accepts an object or a JSON string, so every client can pass `judgment`. */
export const judgmentParam = z
    .union([z.string(), z.record(z.any())])
    .optional()
    .describe("Your structured verdict, as JSON matching the schema returned by a prior 'needs_judgment' response. " +
    "Omit on the first call; the server asks the client model itself when sampling is available.");
function stableHash(value) {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
export function hashOf(value) {
    return stableHash(value);
}
function extractJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start)
        throw new Error("no JSON object found in model response");
    return JSON.parse(body.slice(start, end + 1));
}
function judgmentPath(root, subject, kind) {
    const safe = subject.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(root, ".secufusion", "judgments", safe, `${kind}.json`);
}
export function loadJudgment(root, subject, kind) {
    try {
        return JSON.parse(fs.readFileSync(judgmentPath(root, subject, kind), "utf-8"));
    }
    catch {
        return null;
    }
}
function persist(root, spec, verdict, source) {
    const p = judgmentPath(root, spec.subject, spec.kind);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const stored = {
        kind: spec.kind,
        subject: spec.subject,
        source,
        verdict,
        evidence_hash: stableHash(spec.evidence),
        judged_at: new Date().toISOString(),
    };
    fs.writeFileSync(p, JSON.stringify(stored, null, 2));
}
function buildPrompt(spec) {
    const system = `You are the ${spec.role} in a spec-driven engineering workflow. ` +
        `Judge only from the evidence provided. If the evidence is insufficient to support a verdict, ` +
        `say so in the verdict rather than assuming. Respond with a single JSON object and nothing else.`;
    const user = `## Judgment: ${spec.kind} (${spec.subject})\n\n` +
        `### Rubric\n${spec.rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\n` +
        `### Evidence\n\`\`\`json\n${JSON.stringify(spec.evidence, null, 2)}\n\`\`\`\n\n` +
        `### Required JSON shape\n${spec.schemaHint}`;
    return { system, user };
}
function needsJudgment(spec, note) {
    const { system, user } = buildPrompt(spec);
    return {
        status: "needs_judgment",
        text: `🧠 JUDGMENT REQUIRED — ${spec.kind} for ${spec.subject}\n` +
            (note ? `(${note})\n` : "") +
            `\nThe server does not decide this itself. Act as: ${system}\n\n${user}\n\n` +
            `Next: call ${spec.reinvoke} again with the same arguments plus \`judgment\` set to your JSON verdict. ` +
            `Nothing has been recorded yet.`,
    };
}
export async function judge(server, root, spec) {
    if (spec.supplied !== undefined && spec.supplied !== null && spec.supplied !== "") {
        try {
            const raw = typeof spec.supplied === "string" ? extractJson(spec.supplied) : spec.supplied;
            const verdict = spec.schema.parse(raw);
            if (spec.persist !== false)
                persist(root, spec, verdict, "caller");
            return { status: "ok", verdict, source: "caller" };
        }
        catch (e) {
            return {
                status: "invalid",
                text: `❌ The supplied judgment does not match the required schema:\n${e?.message ?? e}\n\n${spec.schemaHint}`,
            };
        }
    }
    const { system, user } = buildPrompt(spec);
    const answer = async (text, source) => {
        const verdict = spec.schema.parse(extractJson(text));
        if (spec.persist !== false)
            persist(root, spec, verdict, source);
        return { status: "ok", verdict, source };
    };
    // A configured verification engine wins when a cross-model check was asked for.
    if (spec.engineRole === "verify") {
        const v = createEngine({ role: "verify" });
        if (v.engine) {
            try {
                return await answer(await v.engine.complete({ system, user, maxTokens: 2500 }), "engine");
            }
            catch (e) {
                return needsJudgment(spec, `verification engine failed: ${e?.message ?? e}`);
            }
        }
    }
    const canSample = !!server?.server?.getClientCapabilities?.()?.sampling;
    if (!canSample) {
        // No client model (CI, hook, command line): use the configured engine, if the user turned one on.
        const p = createEngine({ role: "primary" });
        if (!p.engine)
            return needsJudgment(spec);
        try {
            return await answer(await p.engine.complete({ system, user, maxTokens: 2500 }), "engine");
        }
        catch (e) {
            return needsJudgment(spec, `engine failed: ${e?.message ?? e}`);
        }
    }
    try {
        const res = await server.server.createMessage({
            systemPrompt: system,
            messages: [{ role: "user", content: { type: "text", text: user } }],
            maxTokens: 2500,
        });
        return await answer(res?.content?.type === "text" ? res.content.text : "", "sampling");
    }
    catch (e) {
        return needsJudgment(spec, `sampling failed: ${e?.message ?? e}`);
    }
}
