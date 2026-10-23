/**
 * Applied migrations are immutable.
 *
 * A migration that has been applied somewhere is history: an environment that already ran it will never see an edit, so an
 * edited, renamed or deleted migration leaves environments with different schemas and nothing fails. The base branch is the
 * proxy for "applied": every migration file that exists there is treated as applied. Deterministic, no model, any
 * framework:
 *   versioned SQL    V<n>__name.sql                    (Flyway style; R__ repeatable migrations may change)
 *   Rails            db/migrate/<timestamp>_name.rb
 *   Django           <app>/migrations/<nnnn>_name.py
 *   Alembic          alembic/versions/*.py
 *   EF Core          Migrations/<timestamp>_Name.cs     (the *ModelSnapshot.cs is rewritten by design and is ignored)
 *   Prisma           prisma/migrations/<timestamp>_name/migration.sql
 *   Knex / TypeORM / Sequelize / others   migrations/<timestamp or number>_name.(js|ts|sql)
 * It reports, against the base:
 *   APPLIED_MIGRATION_EDITED / DELETED / RENAMED   (BLOCKER)
 *   VERSION_CLASH           a new migration reuses a version number that is already taken (BLOCKER)
 *   VERSION_BELOW_HEAD      a new migration is numbered below the head of the base: environments past it will skip it (WARNING)
 * READ-ONLY. Git is run with an argument array, never through a shell.
 */
import path from "path";
import { execFileSync } from "child_process";

export type Style = "versioned-sql" | "rails" | "django" | "alembic" | "ef-core" | "prisma" | "generic";
export interface MigrationFile { file: string; style: Style; version: number[] | null; repeatable: boolean }
export type Rule = "APPLIED_MIGRATION_EDITED" | "APPLIED_MIGRATION_DELETED" | "APPLIED_MIGRATION_RENAMED" | "VERSION_CLASH" | "VERSION_BELOW_HEAD";
export interface Violation { rule: Rule; severity: "BLOCKER" | "WARNING"; file: string; style: Style; detail: string; fix: string }
export interface MigrationReport {
    base: string | null;
    migration_files_on_base: number;
    changed_migration_files: number;
    violations: Violation[];
    notes: string[];
}

export function classify(file: string): MigrationFile | null {
    const f = file.replace(/\\/g, "/");
    const name = path.posix.basename(f);
    let m: RegExpExecArray | null;
    if (/ModelSnapshot\.cs$/.test(name)) return null;
    if ((m = /^V(\d+(?:[._]\d+)*)__.+\.sql$/i.exec(name)) && /(^|\/)(db|migrations?|sql|flyway|database)(\/|$)/i.test(f)) return { file: f, style: "versioned-sql", version: m[1].split(/[._]/).map(Number), repeatable: false };
    if (/^R__.+\.sql$/i.test(name) && /(^|\/)(db|migrations?|sql|flyway|database)(\/|$)/i.test(f)) return { file: f, style: "versioned-sql", version: null, repeatable: true };
    if ((m = /^(\d{14})_.+\.rb$/.exec(name)) && /(^|\/)db\/migrate\//.test(f)) return { file: f, style: "rails", version: [Number(m[1])], repeatable: false };
    if ((m = /^(\d{4})_.+\.py$/.exec(name)) && /(^|\/)migrations\//.test(f)) return { file: f, style: "django", version: [Number(m[1])], repeatable: false };
    if (/\.py$/.test(name) && /(^|\/)alembic\/versions\//.test(f)) return { file: f, style: "alembic", version: null, repeatable: false };
    if ((m = /^(\d{8,14})_.+\.(Designer\.)?cs$/.exec(name)) && /(^|\/)Migrations\//.test(f)) return { file: f, style: "ef-core", version: [Number(m[1])], repeatable: false };
    if ((m = /(^|\/)prisma\/migrations\/(\d{8,14})_[^/]+\/migration\.sql$/.exec(f))) return { file: f, style: "prisma", version: [Number(m[2])], repeatable: false };
    if ((m = /^(\d{1,14})[_-].+\.(js|ts|mjs|cjs|sql)$/.exec(name)) && /(^|\/)migrations?\//.test(f)) return { file: f, style: "generic", version: [Number(m[1])], repeatable: false };
    return null;
}

function git(root: string, args: string[]): string | null {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
}
const lines = (s: string | null) => (s ?? "").split("\n").map((x) => x.replace(/\r$/, "")).filter(Boolean);
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };
const verText = (v: number[]) => v.join(".");
/** The directory a migration belongs to: versions are compared within the same series, never across services. */
const series = (f: MigrationFile) => `${f.style}|${path.posix.dirname(f.file).replace(/\/[^/]*$/, (x) => (f.style === "prisma" ? "" : x))}`;

export function checkAppliedMigrations(root: string, o: { base?: string } = {}): MigrationReport {
    const rootAbs = path.resolve(root);
    const notes: string[] = [];
    if (o.base && !/^[\w./~^@{}-]+$/.test(o.base)) throw new Error(`unsafe base ref: ${o.base}`);
    if (git(rootAbs, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
        return { base: null, migration_files_on_base: 0, changed_migration_files: 0, violations: [], notes: ["not a git repository: there is no base to call 'applied'"] };
    }
    let base = o.base ?? null;
    if (!base) {
        const head = git(rootAbs, ["rev-parse", "HEAD"])?.trim();
        for (const c of ["origin/main", "origin/master", "origin/develop", "main", "master", "develop"]) {
            const mb = git(rootAbs, ["merge-base", "HEAD", c])?.trim();
            if (mb && (mb !== head || /^origin\//.test(c))) { base = mb; break; }
        }
        if (!base) base = "HEAD";
    }

    const baseFiles = lines(git(rootAbs, ["ls-tree", "-r", "--name-only", base]))
        .map(classify).filter((x): x is MigrationFile => !!x);
    const baseSet = new Set(baseFiles.map((f) => f.file));

    // base against the working tree: committed work, staged and unstaged edits; untracked files are added below
    const changes: Array<{ status: string; file: string; from?: string }> = [];
    for (const l of lines(git(rootAbs, ["diff", "--name-status", "--find-renames=60%", "--no-ext-diff", base, "--"]))) {
        const p = l.split("\t");
        if (p[0].startsWith("R")) changes.push({ status: "R", from: p[1], file: p[2] });
        else changes.push({ status: p[0][0], file: p[1] });
    }
    for (const f of lines(git(rootAbs, ["ls-files", "--others", "--exclude-standard"]))) changes.push({ status: "A", file: f });

    const violations: Violation[] = [];
    let changedMig = 0;
    for (const c of changes) {
        const nu = classify(c.file);
        const old = c.from ? classify(c.from) : nu;
        if (c.status === "M" && nu && baseSet.has(nu.file) && !nu.repeatable) {
            changedMig++;
            violations.push({ rule: "APPLIED_MIGRATION_EDITED", severity: "BLOCKER", file: c.file, style: nu.style, detail: `${path.posix.basename(c.file)} exists on ${base.slice(0, 10)} and was modified. An environment that already applied it will never see this change.`, fix: "Revert the edit and put the change in a new migration with the next version. If the migration was never applied anywhere, say so and record it as a known exception." });
        } else if (c.status === "D" && old && baseSet.has(old.file) && !old.repeatable) {
            changedMig++;
            violations.push({ rule: "APPLIED_MIGRATION_DELETED", severity: "BLOCKER", file: c.file, style: old.style, detail: `${path.posix.basename(c.file)} existed on ${base.slice(0, 10)} and was deleted. Environments that applied it keep its effects, and a fresh environment will not get them.`, fix: "Restore the file. To undo what it did, add a new migration." });
        } else if (c.status === "R" && old && baseSet.has(old.file) && !old.repeatable) {
            changedMig++;
            violations.push({ rule: "APPLIED_MIGRATION_RENAMED", severity: "BLOCKER", file: `${c.from} → ${c.file}`, style: old.style, detail: "An applied migration was renamed or moved. Tools that track applied migrations by name or version will treat it as new, or report a checksum mismatch.", fix: "Restore the original name and location." });
        } else if (c.status === "A" && nu && !baseSet.has(nu.file)) {
            changedMig++;
        }
    }

    // new migrations against the head of their own series on the base
    const added = changes.filter((c) => c.status === "A" || c.status === "R").map((c) => classify(c.file)).filter((x): x is MigrationFile => !!x && !baseSet.has(x.file));
    const headBySeries = new Map<string, MigrationFile>();
    const takenBySeries = new Map<string, Map<string, string>>();
    for (const f of baseFiles) {
        if (!f.version) continue;
        const s = series(f);
        if (!headBySeries.has(s) || cmp(f.version, headBySeries.get(s)!.version!) > 0) headBySeries.set(s, f);
        if (!takenBySeries.has(s)) takenBySeries.set(s, new Map());
        takenBySeries.get(s)!.set(verText(f.version), f.file);
    }
    const seenNew = new Map<string, string>();
    for (const f of added) {
        if (!f.version) continue;
        const s = series(f), key = `${s}|${verText(f.version)}`;
        const taken = takenBySeries.get(s)?.get(verText(f.version)) ?? seenNew.get(key);
        if (taken && f.style !== "django") {
            violations.push({ rule: "VERSION_CLASH", severity: "BLOCKER", file: f.file, style: f.style, detail: `version ${verText(f.version)} is already taken by ${path.posix.basename(taken)}: two migrations share one version, so one of them is never applied in some environment.`, fix: `Renumber to the next free version (after ${headBySeries.get(s) ? verText(headBySeries.get(s)!.version!) : "the base head"}).` });
        } else if (taken) {
            violations.push({ rule: "VERSION_CLASH", severity: "WARNING", file: f.file, style: f.style, detail: `number ${verText(f.version)} is already used by ${path.posix.basename(taken)}: two leaf migrations conflict and the framework will ask for a merge migration.`, fix: "Renumber, or add the merge migration the framework asks for." });
        } else {
            const head = headBySeries.get(s);
            if (head && cmp(f.version, head.version!) < 0) violations.push({ rule: "VERSION_BELOW_HEAD", severity: "WARNING", file: f.file, style: f.style, detail: `version ${verText(f.version)} is below the head ${verText(head.version!)} of its series on ${base.slice(0, 10)}. Environments that are already past ${verText(head.version!)} will skip it.`, fix: `Renumber above ${verText(head.version!)}.` });
        }
        seenNew.set(key, f.file);
    }

    if (!baseFiles.length) notes.push("no migration file exists on the base, so there is nothing applied to protect yet");
    notes.push(`"applied" is approximated by "exists on ${base.slice(0, 10)}". A migration that was merged but never run anywhere can legitimately be edited: that is a decision, record it as a known exception rather than ignoring the finding.`);
    notes.push("recognised: Flyway-style versioned SQL, Rails, Django, Alembic, EF Core, Prisma, and generic migrations/ folders; Liquibase changelogs are not checked (a changelog is edited by design)");
    violations.sort((a, b) => (a.severity === b.severity ? a.file.localeCompare(b.file) : a.severity === "BLOCKER" ? -1 : 1));
    return { base, migration_files_on_base: baseFiles.length, changed_migration_files: changedMig, violations, notes };
}

export function renderMigrationReport(r: MigrationReport): string {
    const out = [`# Applied migrations: ${r.violations.filter((v) => v.severity === "BLOCKER").length} blocker(s), ${r.violations.filter((v) => v.severity === "WARNING").length} warning(s)`, `base ${r.base ? r.base.slice(0, 10) : "(none)"} · ${r.migration_files_on_base} migration file(s) on the base · ${r.changed_migration_files} touched by this change`, ""];
    if (!r.violations.length) out.push("No applied migration was edited, renamed or deleted, and no new version clashes with the base.");
    for (const v of r.violations) out.push(`${v.severity}  ${v.rule}  ${v.file}  [${v.style}]`, `    ${v.detail}`, `    fix: ${v.fix}`);
    out.push("", ...r.notes.map((n) => `note: ${n}`));
    return out.join("\n");
}
