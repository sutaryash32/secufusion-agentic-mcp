# Repo rules — sfn-iam-api

Read the repo's own `CLAUDE.md` and `docs/PATTERNS.md` too; they win on conflicts with this file.

- Layering: `controller → service → repository → entity`; concrete services.
- Mapping is manual `mapToDto` — no MapStruct (different from events-api's `fromEntity()`; don't
  "harmonise" in passing).
- **Cross-tenant guards run in the controller**: a new endpoint must call
  `ParentChainAuthorizer` / `TenantAccessGuard` itself (SEC-002).
- Success uses `ResponseDto<T>`; errors are a raw `Map` from `GlobalExceptionHandler`, status derived
  from an `errorCode` switch. `ResponseDto` field names don't match what callers pass — read PATTERNS
  before touching it.
- **Schema changes ship as `V<next>` migrations with a migration test** under
  `src/test/java/com/secufusion/iam/migration/` (DB-010). The README says otherwise and is wrong.
- Scope seeding/backfill migrations (`V*__seed_*_scopes*.sql`, `V*__backfill_*scope*`) must be
  idempotent — they get re-applied (DB-011).
- Feature flags have **three** separate mechanisms and a 30 s cache (`docs/architecture/entitlements.md`);
  a new flag must say which one and why.
- Kafka is producer-only for `device-registration` (consumed by events-api) and consumes `device-deleted`.
- Azure group sync is `@Async` and manually triggered — no cron.
- Test: `mvn -q test` (Testcontainers `postgres:16-alpine`).
