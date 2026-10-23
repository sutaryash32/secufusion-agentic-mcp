# Repo rules — sfn-events-api

Read the repo's own `CLAUDE.md` and `docs/PATTERNS.md` too; they win on conflicts with this file.

- Layering: `controller → service → repository → entity`; concrete `@Service` classes.
- Entity→DTO via a static `fromEntity()` on the response DTO; DTOs are Lombok `@Data @Builder` POJOs.
- `ResponseDto<T>` for success; errors use a different `GlobalExceptionHandler` shape.
- String UUID primary keys; auditing via custom `Auditable` + `AuditListener`.
- **Soft delete by status flag — never `DELETE`** (DB-007).
- Every repository query takes `tenantId` explicitly (SEC-003).
- `incident_events.fk_event_id → events` has no ON DELETE: unlink before deleting (DB-006).
- `@Scheduled` jobs (`EscalationScheduler`, `DeviceInactivityScheduler`, `ExtensionApiKeyScheduler`, the
  inbox flush) run on **every replica** — no lock (RUN-001).
- Ingestion: Kafka → `event_inbox` → flush every `kafka.schedule.time` minutes (default 20) → `events`.
- Routing by URL prefix in each controller: `/api/events/...`; public endpoints under
  `/api/events/public/...` and `/api/public/...` — a new public endpoint is a security review item.
- Eureka is disabled: never `@LoadBalanced` / `lb://` (RUN-005).
- Domain terms: a **device** = one browser install for one user (`devices` row); a **machine** = the
  physical PC grouping devices (`devices.fk_machine_id`). Machine rollups sum every user's browsers.
- Test: `mvn -q test`.
