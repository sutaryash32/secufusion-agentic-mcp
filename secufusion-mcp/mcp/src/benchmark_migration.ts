import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { checkAppliedMigrations, classify, renderMigrationReport } from "./migration_guard.js";

/** Applied migrations are immutable: real git repositories, one framework after another. */

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
}
const write = (root: string, rel: string, content: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
function repo(files: Record<string, string>) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q"); git("symbolic-ref", "HEAD", "refs/heads/main");
    for (const [k, v] of Object.entries(files)) write(ws, k, v);
    git("add", "."); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "work");
    return { ws, git, run: () => checkAppliedMigrations(ws, { base: "main" }) };
}
const rules = (r: ReturnType<typeof checkAppliedMigrations>) => r.violations.map((v) => `${v.severity}:${v.rule}`).sort();

// ---- recognising migrations in any framework
{
    const k = (f: string) => classify(f)?.style ?? null;
    check("classify: Flyway-style, Rails, Django, Alembic, EF Core, Prisma and generic migration files are recognised", k("svc/src/main/resources/db/migration/V42__add_col.sql") === "versioned-sql" && k("db/migrate/20240101120000_create_users.rb") === "rails" && k("app/migrations/0003_auto.py") === "django" && k("alembic/versions/ab12_init.py") === "alembic" && k("Data/Migrations/20240101_Init.cs") === "ef-core" && k("prisma/migrations/20240101_init/migration.sql") === "prisma" && k("db/migrations/20240101-add.js") === "generic");
    check("classify: the EF model snapshot, repeatable SQL's version and ordinary files are not migrations to version", k("Data/Migrations/AppDbContextModelSnapshot.cs") === null && classify("db/migration/R__views.sql")!.repeatable && k("src/main/java/User.java") === null && k("docs/V1__notes.sql") === null);
}

// ---- versioned SQL (Flyway style)
{
    const { ws, git, run } = repo({ "svc/src/main/resources/db/migration/V1__a.sql": "create table a(id int);\n", "svc/src/main/resources/db/migration/V2__b.sql": "create table b(id int);\n", "svc/src/main/resources/db/migration/R__views.sql": "create view v as select 1;\n" });
    const d = "svc/src/main/resources/db/migration/";
    write(ws, d + "V2__b.sql", "create table b(id int, extra text);\n");                // edited
    write(ws, d + "R__views.sql", "create or replace view v as select 2;\n");              // repeatable: allowed
    write(ws, d + "V3__c.sql", "create table c(id int);\n");                               // fine
    write(ws, d + "V2__another.sql", "alter table b add x int;\n");                         // reuses 2
    write(ws, d + "V0_5__early.sql", "select 1;\n");                                        // below head
    const r = run();
    check("sql: an edited applied migration is a BLOCKER, a repeatable one may change, a clean new version is fine", rules(r).includes("BLOCKER:APPLIED_MIGRATION_EDITED") && !r.violations.some((v) => /R__views/.test(v.file)) && !r.violations.some((v) => /V3__c/.test(v.file)), JSON.stringify(rules(r)));
    check("sql: a new migration reusing a taken version is a BLOCKER, one below the head is a WARNING", r.violations.some((v) => v.rule === "VERSION_CLASH" && v.severity === "BLOCKER" && /V2__another/.test(v.file)) && r.violations.some((v) => v.rule === "VERSION_BELOW_HEAD" && v.severity === "WARNING" && /V0_5/.test(v.file)), JSON.stringify(rules(r)));
    check("sql: the report says what happens and how to fix it", /never see this change/.test(r.violations.find((v) => v.rule === "APPLIED_MIGRATION_EDITED")!.detail) && /new migration with the next version/.test(r.violations.find((v) => v.rule === "APPLIED_MIGRATION_EDITED")!.fix) && /BLOCKER {2}APPLIED_MIGRATION_EDITED/.test(renderMigrationReport(r)));
    git("add", "."); git("commit", "-q", "-m", "work");
    check("sql: committed work is judged the same as uncommitted", rules(run()).join() === rules(r).join());
}
{
    const { ws, git, run } = repo({ "db/migration/V1__a.sql": "a\n", "db/migration/V2__b.sql": "b\n" });
    git("rm", "-q", "db/migration/V1__a.sql");
    git("mv", "db/migration/V2__b.sql", "db/migration/V2__b_renamed.sql");
    const r = run();
    check("sql: deleting or renaming an applied migration is a BLOCKER", rules(r).filter((x) => /DELETED|RENAMED/.test(x)).length === 2, JSON.stringify(rules(r)));
}
{
    const { ws, run } = repo({ "db/migration/V1__a.sql": "a\n" });
    write(ws, "src/Other.java", "class Other {}\n");
    write(ws, "db/migration/V2__ok.sql", "ok\n");
    const r = run();
    check("clean: only non-migration files and a correctly numbered new migration changed: nothing is reported", r.violations.length === 0 && r.migration_files_on_base === 1 && r.changed_migration_files === 1 && /No applied migration was edited/.test(renderMigrationReport(r)), JSON.stringify(r));
}
{
    const a = repo({ "billing/db/migration/V5__x.sql": "x\n", "iam/db/migration/V1__y.sql": "y\n" });
    write(a.ws, "iam/db/migration/V2__z.sql", "z\n");
    check("series: versions are compared inside one service, never across services (V2 in iam is fine while billing is at V5)", a.run().violations.length === 0);
}

// ---- other frameworks
{
    const rails = repo({ "db/migrate/20240101000000_create_a.rb": "class A; end\n" });
    write(rails.ws, "db/migrate/20240101000000_create_a.rb", "class A; def change; end; end\n");
    write(rails.ws, "db/migrate/20230101000000_old.rb", "class Old; end\n");
    check("rails: an edited migration is a BLOCKER and an older timestamp is a WARNING", rules(rails.run()).join() === "BLOCKER:APPLIED_MIGRATION_EDITED,WARNING:VERSION_BELOW_HEAD", rules(rails.run()).join());

    const dj = repo({ "app/migrations/0001_initial.py": "x\n", "app/migrations/0002_b.py": "y\n" });
    write(dj.ws, "app/migrations/0001_initial.py", "x2\n");
    write(dj.ws, "app/migrations/0002_c.py", "z\n");
    const rd = dj.run();
    check("django: an edited migration is a BLOCKER; two migrations numbered alike are a WARNING (a merge migration is needed), not a BLOCKER", rules(rd).includes("BLOCKER:APPLIED_MIGRATION_EDITED") && rules(rd).includes("WARNING:VERSION_CLASH"), JSON.stringify(rules(rd)));

    const ef = repo({ "Data/Migrations/20240101000000_Init.cs": "a\n", "Data/Migrations/AppDbContextModelSnapshot.cs": "s1\n" });
    write(ef.ws, "Data/Migrations/AppDbContextModelSnapshot.cs", "s2\n");
    check("ef core: the model snapshot is rewritten by design and is not a violation", ef.run().violations.length === 0);
    write(ef.ws, "Data/Migrations/20240101000000_Init.cs", "edited\n");
    check("ef core: but editing the migration itself is", rules(ef.run()).join() === "BLOCKER:APPLIED_MIGRATION_EDITED");

    const pr = repo({ "prisma/migrations/20240101000000_init/migration.sql": "create table a();\n" });
    write(pr.ws, "prisma/migrations/20240101000000_init/migration.sql", "create table a(id int);\n");
    write(pr.ws, "prisma/migrations/20240202000000_add/migration.sql", "alter table a add x int;\n");
    check("prisma: an edited migration is a BLOCKER, a newer one is fine", rules(pr.run()).join() === "BLOCKER:APPLIED_MIGRATION_EDITED");
}

// ---- honesty about what it cannot know
{
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
    const r = checkAppliedMigrations(ws);
    check("no git: it says there is no base to call 'applied' and reports nothing", r.violations.length === 0 && /not a git repository/.test(r.notes[0]));
    const { run } = repo({ "src/A.java": "class A {}\n" });
    check("no migrations on the base: it says there is nothing applied to protect yet, and that 'applied' is an approximation", /nothing applied to protect/.test(run().notes.join(" ")) && /approximated by/.test(run().notes.join(" ")));
    let bad = false; try { checkAppliedMigrations(ws, { base: "main; rm -rf /" }); } catch { bad = true; }
    check("a base ref that looks like a shell command is refused", bad);
}

console.log(failures === 0 ? "\nAll applied-migration checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
