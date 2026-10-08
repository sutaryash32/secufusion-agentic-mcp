import fs from "fs";
import path from "path";
import { loadRequirement } from "./requirement_manager.js";
export function discoverUIPatterns(ecosystemRoot, query, snapshot) {
    // This looks through the current snapshot for nodes that represent UI_PATTERN or FRONTEND_COMPONENT
    // and matches the query keywords.
    const patterns = [];
    const keywords = query.toLowerCase().split(/\s+/);
    for (const node of snapshot.nodes) {
        if (node.type === "FRONTEND_COMPONENT" || node.type === "UI_PATTERN") {
            const searchableText = `${node.name} ${JSON.stringify(node.metadata || {})}`.toLowerCase();
            const matches = keywords.some(kw => searchableText.includes(kw));
            if (matches) {
                patterns.push({
                    name: node.name,
                    sourceNodeId: node.id,
                    confidence: "HIGH",
                    evidence: {
                        repository: node.repository,
                        metadata: node.metadata,
                        location: node.evidence
                    }
                });
            }
        }
    }
    return patterns;
}
export const MAX_REFERENCE_BYTES = 200_000;
const DESIGN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function isValidDesignId(id) {
    return DESIGN_ID_RE.test(id) && !id.includes("..");
}
/**
 * A reference is a picture of an idea, not an app. Reject anything that could
 * reach the network, read storage, or load code from elsewhere. Returns violations.
 */
export function validateReferenceHtml(html) {
    const v = [];
    if (Buffer.byteLength(html, "utf-8") > MAX_REFERENCE_BYTES)
        v.push(`larger than ${MAX_REFERENCE_BYTES} bytes`);
    const rules = [
        [/<script[^>]*\ssrc\s*=/i, "external <script src>"],
        [/<(iframe|object|embed|link|base|frame|frameset)\b/i, "<iframe>/<object>/<embed>/<link>/<base> are not allowed"],
        [/<meta[^>]*http-equiv/i, "<meta http-equiv> is not allowed (the server sets the CSP)"],
        [/\b(?:src|href|action|poster|data|formaction)\s*=\s*["']?\s*(?:https?:|ftp:|wss?:)?\/\//i, "external URL in an attribute"],
        [/url\(\s*["']?\s*(?:https?:|ftp:)?\/\//i, "external URL in CSS url()"],
        [/@import\b/i, "CSS @import"],
        [/javascript:/i, "javascript: URL"],
        [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|eval)\b\s*[(\.]?/, "network or dynamic-code API"],
        [/\bnew\s+Function\b/, "new Function"],
        [/\b(localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.(?:geolocation|clipboard))\b/, "storage/cookie/device API"],
        [/\bwindow\.open\b|\blocation\s*(?:\.href)?\s*=/, "navigation away from the reference"],
    ];
    for (const [re, why] of rules)
        if (re.test(html))
            v.push(why);
    return v;
}
export function designDir(ecosystemRoot, designId) {
    if (!isValidDesignId(designId))
        throw new Error(`Invalid design id '${designId}' (letters, digits, . _ - ; max 64)`);
    return path.join(ecosystemRoot, ".secufusion", "designs", designId);
}
export function loadDesignMetadata(ecosystemRoot, designId) {
    try {
        return JSON.parse(fs.readFileSync(path.join(designDir(ecosystemRoot, designId), "metadata.json"), "utf-8"));
    }
    catch {
        return null;
    }
}
export function saveDesignMetadata(ecosystemRoot, meta) {
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(designDir(ecosystemRoot, meta.designId), "metadata.json"), JSON.stringify(meta, null, 2), "utf-8");
}
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:";
function withSafetyFrame(html, label) {
    const banner = `<div data-reference-banner style="position:sticky;top:0;z-index:99999;background:#7a1f1f;color:#fff;font:600 12px/1.4 system-ui,sans-serif;padding:6px 12px;text-align:center">REFERENCE_ONLY · NOT_PRODUCTION_CODE · NOT_IMPLEMENTED — ${label}</div>`;
    const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
    let out = html;
    out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, m => `${m}${meta}`) : /<html[^>]*>/i.test(out) ? out.replace(/<html[^>]*>/i, m => `${m}<head>${meta}</head>`) : `<head>${meta}</head>${out}`;
    out = /<body[^>]*>/i.test(out) ? out.replace(/<body[^>]*>/i, m => `${m}${banner}`) : `${out}${banner}`;
    return `<!-- REFERENCE_ONLY: static design reference, not production code -->
${out}`;
}
/**
 * Writes .secufusion/designs/<id>/{index.html,metadata.json,revisions/rN.html}.
 * Only ever writes under .secufusion/designs; never touches repository source.
 * Throws on unsafe HTML or an invalid design id.
 */
export function generateStaticUIReference(ecosystemRoot, designId, htmlContent, metadata = {}) {
    const dir = designDir(ecosystemRoot, designId);
    const violations = validateReferenceHtml(htmlContent);
    if (violations.length > 0)
        throw new Error(`Unsafe or oversized reference HTML: ${violations.join("; ")}`);
    const previous = loadDesignMetadata(ecosystemRoot, designId);
    const revision = (previous?.revision ?? 0) + 1;
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(dir, "revisions"), { recursive: true });
    const label = `${metadata.requirementId ?? previous?.requirementId ?? "unlinked"} · ${designId} r${revision} · design intent, not a screenshot test`;
    const framed = withSafetyFrame(htmlContent, label);
    const indexPath = path.join(dir, "index.html");
    fs.writeFileSync(indexPath, framed, "utf-8");
    fs.writeFileSync(path.join(dir, "revisions", `r${revision}.html`), framed, "utf-8");
    const meta = {
        designId,
        requirementId: metadata.requirementId ?? previous?.requirementId ?? "",
        title: metadata.title ?? previous?.title ?? designId,
        purpose: metadata.purpose ?? previous?.purpose ?? "Reference design for proposed UX",
        status: "REFERENCE_ONLY",
        implementationStatus: "NOT_IMPLEMENTED",
        reviewStatus: "AWAITING_FEEDBACK",
        revision,
        generatedAt: previous?.generatedAt ?? now,
        updatedAt: now,
        workspace: ecosystemRoot,
        affectedComponents: metadata.affectedComponents ?? previous?.affectedComponents ?? [],
        decisions: metadata.decisions ?? previous?.decisions ?? [],
        evidence: metadata.evidence ?? previous?.evidence ?? [],
        traceability: metadata.traceability ?? previous?.traceability ?? [],
    };
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2), "utf-8");
    return indexPath;
}
export function getDesignContext(ecosystemRoot, requirementId, snapshot) {
    const req = loadRequirement(ecosystemRoot, requirementId);
    if (!req)
        return { error: "REQUIREMENT_NOT_FOUND" };
    // Gather related architecture
    const affectedNodes = [];
    if (req.apis) {
        for (const api of req.apis) {
            const node = snapshot.nodes.find(n => n.id === `API:${api}`);
            if (node)
                affectedNodes.push(node);
        }
    }
    if (req.events) {
        for (const ev of req.events) {
            const node = snapshot.nodes.find(n => n.id === `TOPIC:${ev}`);
            if (node)
                affectedNodes.push(node);
        }
    }
    return {
        requirement: req,
        architecture_context: affectedNodes,
        existing_frontend_patterns: snapshot.nodes.filter(n => n.type === "UI_PATTERN" || n.type === "FRONTEND_COMPONENT").slice(0, 50),
        status: "READY_FOR_DESIGN"
    };
}
