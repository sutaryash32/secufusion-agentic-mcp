# Rules — dependencies, build and deploy

Owner: `deps` specialist. Applies to all repos.

The scope file's `dependencyChanges` lists every dependency added, removed or re-versioned (parsed
deterministically from `pom.xml` / `package.json` at base and head). Start from it.

## Rules

| ID | Severity | Rule |
|---|---|---|
| DEP-001 | major | A new dependency with no evident need (functionality already provided by an existing dependency or the JDK/platform), or a second library for the same job (another HTTP client, JSON lib, date lib, mapper — the repos deliberately have no MapStruct). |
| DEP-002 | major | A dependency version you **know** has a published vulnerability affecting how it's used here. Name the advisory. If you are not certain of the advisory, use `confidence: possible` and say so — never invent CVE ids. |
| DEP-003 | major | A major-version upgrade (Spring Boot, Spring Security, Hibernate, React, MUI, react-router, Vite) without the migration changes it needs, visible in the diff (deprecated APIs still used, config keys renamed). |
| DEP-004 | minor | An unpinned or floating version (`LATEST`, `RELEASE`, `*`, `x`, a range in `pom.xml`, a git URL dependency) or a `-SNAPSHOT` dependency on a release branch. |
| DEP-005 | minor | `package.json` changed without the matching `package-lock.json` change (or vice versa), so CI installs something different from what was tested. |
| DEP-006 | major | Dockerfile: base image not pinned to a version (`:latest` or no tag), running as root where the base image supports a non-root user, secrets passed as `ARG`/`ENV`, or `curl | sh` installs. |
| DEP-007 | major | Pipeline YAML: a step that disables tests or security checks (`-DskipTests` on the release path, `continueOnError: true` added to a gate, a removed scan), or secrets echoed / passed on the command line. |
| DEP-008 | minor | A dependency with a licence incompatible with commercial distribution (GPL/AGPL family) added to a shipped artifact. Only report when you know the licence. |
| DEP-009 | minor | A test-only library added in `compile`/`implementation` scope, or a runtime library in test scope. |
