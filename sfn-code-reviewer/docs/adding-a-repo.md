# Adding a repo / service

A new service is reviewed even with **no** changes here: its stack is detected (`pom.xml` →
java-spring, `package.json` with react/vite → react-vite) and the shared rules apply. To give it full
coverage:

1. **`config/repos.yml`** — add a block under `repos:`:
   ```yaml
   sfn-reports-api:
     stack: java-spring
     package: com.secufusion.reports
     migrations: src/main/resources/db/migration
     test: mvn -q test
     deletes: soft
     apiPrefix: /api/reports
     kafka:
       produces: [report-ready]
       consumes: [quickstart-events]
   ```
   This alone makes CI clone it for cross-repo contract checks in **every other** repo's reviews.
2. **`rules/repos/sfn-reports-api.md`** (optional) — its conventions and pitfalls.
3. **`rules/shared/contracts.md`** — add its Kafka topics to the producer/consumer table; if it shares
   tables (e.g. `tenant`), mention it in `rules/shared/db-migrations.md`.
4. If it introduces a new stack (Python, Go…), add a `defaults.<stack>` entry and a stack detector in
   `scripts/collect-scope.mjs`.
5. `npm run build && npm test`, tag a release.
6. In the new repo: copy `ci/azure/example-consumer.yml`, set `repoKey: sfn-reports-api`, add the
   branch policy. Grant the build service *Read* on it (see [ci-setup.md](ci-setup.md)).
