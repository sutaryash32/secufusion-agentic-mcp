# Scoping — what gets reviewed

`bin/collect-scope.mjs` turns a request into a scope file. The orchestrator never guesses the diff.

| User says | Flags | Diff reviewed |
|---|---|---|
| (nothing), "my changes" | `--working-tree` | merge-base(base, HEAD) → working tree, incl. untracked files |
| "this branch" | (none) | merge-base(base, HEAD) → HEAD |
| a branch `feature/x` | `--head feature/x` | merge-base(base, feature/x) → feature/x |
| a range `a..b` | `--base a --head b` | merge-base(a, b) → b |
| "against main" | `--base main` | base overridden |

**Base default:** `origin/develop` → `develop` → `origin/main` → `main` (first that exists).
In CI the pipeline passes `--base origin/<PR target branch> --head HEAD`.

**Estate root:** the directory holding the sibling repos. Default: the parent of the reviewed repo
(e.g. `~/IdeaProjects/secufusion`). CI passes the folder it cloned them into. Repos listed in
`config/repos.json` but not found there are reported as `missingRepos`.

**Unknown repos** (not in `config/repos.json`) are still reviewed: stack is detected from
`pom.xml` / `package.json` and only the shared rules apply.

**Risk score and level** — see `risk-scoring.md`.
