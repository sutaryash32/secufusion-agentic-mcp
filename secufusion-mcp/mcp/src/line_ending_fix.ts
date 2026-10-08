import fs from "fs";
import path from "path";
import {
    EolInfo, detectLineEndings, resolveConvention, exclusionReason, gitTop, git, pickBase, THRESHOLDS,
} from "./diff_quality.js";

/**
 * Restores a file to ONE line-ending style. It changes line terminators and nothing else:
 * content, BOM, indentation and whether the file ends with a newline are preserved byte for byte.
 *
 * "When in Rome": the target is the file's own convention (explicit repo config, else what the file
 * was at the base commit). It refuses to guess. Preview is the default; writing needs apply=true.
 */

export type Eol = "lf" | "crlf";

export interface FixResult {
    file: string;
    ok: boolean;
    applied: boolean;
    reason?: string;
    target?: Eol;
    target_source?: string;
    before?: EolInfo;
    after?: EolInfo;
    /** Terminators that differ from the target and would be / were rewritten. */
    lines_changed?: number;
}

function convert(buf: Buffer, target: Eol): Buffer {
    const eol = target === "crlf" ? Buffer.from([13, 10]) : Buffer.from([10]);
    const parts: Buffer[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10) { parts.push(buf.subarray(start, i), eol); i++; start = i + 1; }
        else if (buf[i] === 10) { parts.push(buf.subarray(start, i), eol); start = i + 1; }
    }
    parts.push(buf.subarray(start));
    return Buffer.concat(parts);
}

const stripCr = (b: Buffer) => Buffer.from(b.filter((x) => x !== 13));

export function fixLineEndings(workspaceRoot: string, file: string, opts: { target?: Eol; apply?: boolean } = {}): FixResult {
    const fail = (reason: string): FixResult => ({ file, ok: false, applied: false, reason });
    const top = gitTop(workspaceRoot) ?? path.resolve(workspaceRoot);
    const rel = file.replace(/\\/g, "/");
    const abs = path.resolve(top, rel);

    if (abs !== top && !abs.startsWith(top + path.sep)) return fail("path is outside the repository");
    if (rel.split("/").includes(".git")) return fail("refusing to touch .git");
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return fail("not a regular file");
    if (fs.lstatSync(abs).isSymbolicLink()) return fail("refusing to rewrite a symlink");
    const size = fs.statSync(abs).size;
    if (size > THRESHOLDS.MAX_BYTES) return fail(`larger than ${THRESHOLDS.MAX_BYTES} bytes`);

    const buf = fs.readFileSync(abs);
    const why = exclusionReason(top, rel, buf);
    if (why) return fail(`line-ending changes do not apply: ${why}`);

    const before = detectLineEndings(buf);
    if (before.state === "N/A") return fail("binary file");
    if (before.cr > 0) return fail(`contains ${before.cr} lone CR (old-Mac) line break(s); not converting automatically`);
    if (before.state === "NONE") return { file, ok: true, applied: false, reason: "no line terminators; nothing to do", before, after: before, lines_changed: 0 };

    // target: explicit > repo configuration > the file's own style at the base commit. Never a guess.
    let target = opts.target;
    let source = target ? "explicit request" : "";
    if (!target) {
        const conv = resolveConvention(top, rel);
        if (conv.conflict) return fail("repository configuration conflicts (" + conv.explicit.map((e) => `${e.source}`).join("; ") + "); pass target explicitly");
        if (conv.expected) { target = conv.expected; source = conv.expected_source ?? "repository configuration"; }
    }
    if (!target) {
        const base = pickBase(top).base;
        const blob: Buffer | null = git(top, ["show", `${base}:${rel}`], true);
        const b = blob ? detectLineEndings(blob) : null;
        if (b && (b.state === "LF" || b.state === "CRLF")) { target = b.state.toLowerCase() as Eol; source = `file's style at ${base}`; }
    }
    if (!target) return fail("no convention found (no repo config, no consistent history); pass target explicitly");

    const wantState = target === "crlf" ? "CRLF" : "LF";
    const linesChanged = target === "crlf" ? before.lf : before.crlf;
    if (before.state === wantState) return { file, ok: true, applied: false, reason: `already consistent ${wantState}`, target, target_source: source, before, after: before, lines_changed: 0 };

    const out = convert(buf, target);
    const after = detectLineEndings(out);
    // Hard invariants: one style, and nothing but terminators changed.
    if (after.state !== wantState && after.state !== "NONE") return fail(`internal check failed: result is ${after.state}`);
    if (!stripCr(out).equals(stripCr(buf))) return fail("internal check failed: content would change beyond line endings");

    if (!opts.apply) return { file, ok: true, applied: false, reason: "preview only (apply=false)", target, target_source: source, before, after, lines_changed: linesChanged };

    const tmp = abs + `.eolfix-${process.pid}.tmp`;
    const mode = fs.statSync(abs).mode;
    try {
        fs.writeFileSync(tmp, out, { mode });
        fs.renameSync(tmp, abs);
    } catch (e: any) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        return fail(`write failed: ${e.message}`);
    }
    return { file, ok: true, applied: true, target, target_source: source, before, after, lines_changed: linesChanged };
}
