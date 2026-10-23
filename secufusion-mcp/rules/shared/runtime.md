# Rules — runtime, scheduling, error handling

Area rules for `/sfn-review`.
specialist replaces it in phase 3.

## Platform facts (verified)
- `@Scheduled` jobs have **no distributed lock** (no ShedLock/Quartz) in any API — every replica runs
  every job.
- Existing schedulers include `ProvisioningRetryScheduler` (tenants), `EscalationScheduler`,
  `DeviceInactivityScheduler`, `ExtensionApiKeyScheduler` (events).
- New code in tenants-api lets exceptions propagate to `GlobalExceptionHandler` (no ad hoc try/catch).
- Eureka is on the classpath but must not be used for calls: never `@LoadBalanced` / `lb://`.

## Rules

| ID | Severity | Rule |
|---|---|---|
| RUN-001 | major | A new `@Scheduled` job that writes data, sends messages or calls external systems with no protection against running on every replica (idempotent claim via `UPDATE ... WHERE status=...`, row lock, or a single-replica deployment note). |
| RUN-002 | major | Exceptions swallowed: empty catch, `catch (Exception e) { log... }` that continues after a failed write, or a failure mapped to a success response. |
| RUN-003 | minor | Ad hoc try/catch that converts exceptions into custom responses instead of letting `GlobalExceptionHandler` map them (tenants-api new code). |
| RUN-004 | major | `@Async` / new thread work that reads the security or tenant context (it isn't propagated), or that runs a DB write outside a transaction. |
| RUN-005 | major | Peer calls via `@LoadBalanced` or `lb://` (Eureka is disabled in practice). |
| RUN-006 | minor | A new failure path with no log line, or a log line with no tenant id / correlation id to trace it. |
| RUN-007 | minor | Growing `TenantService.java` (already >4,600 lines) instead of a focused service. |
