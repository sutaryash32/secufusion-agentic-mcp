# Repo rules — sfn-tenants-api

Read the repo's own `CLAUDE.md` and `docs/PATTERNS.md` too; they win on conflicts with this file.

- Layering: `controller → service → repository → entity`; services are concrete classes.
- **New code:** `@RequiredArgsConstructor` (no field `@Autowired`), exceptions propagate to
  `GlobalExceptionHandler`, real HTTP status codes (not the `ResponseDto` envelope).
- Entity↔DTO mapping is inlined in services. No MapStruct — don't introduce it.
- **Deletes are hard.** Owns `auth_provider_config` (JWT issuers read by the other two APIs).
- `TenantService.java` is >4,600 lines — new logic goes in a focused service (RUN-007).
- Provisioning: `Tenant.status` (free text) and the `ProvisionStep` bitmask move together (DB-013);
  `FAILED` is reserved for provisioning (DB-012); tenant delete uses `DELETE_FAILED`.
- `GET /api/tenants/{id}/provisioning-status` returns 403 (not 404) for a deleted tenant because
  `TenantAccessGuard` can't resolve its parent — callers detect deletion via the tenant list.
- Migration numbering is contested (duplicate V42 across branches, one malformed filename): check DB-003
  carefully here.
- Eureka `defaultZone` is live while the disable flags are commented out — don't rely on Eureka being off.
- WebSocket/STOMP is dead code and `policy-events` is only consumed by this service itself: there is no
  live server→client push. Don't review new code as if it pushed to clients.
- CI test stage has `continueOnError: true` — a green pipeline proves nothing about tests.
- Test: `mvn -q test` (integration tests need Docker / Testcontainers).
