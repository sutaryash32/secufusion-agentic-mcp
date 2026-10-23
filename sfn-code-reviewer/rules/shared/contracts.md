# Rules — API, DTO and Kafka contracts across repos

Owner: `contracts` specialist. Applies to all four repos.

## Platform facts (verified)
- sfn-web-ui calls all three APIs: `/api/tenants/*`, `/api/iam/*`, `/api/events/*`. URLs live only in
  `src/utils/apiEndpoints.js`; calls go through `src/utils/axiosConfig.js`, whose default timeout is
  **30 s** for every request.
- Routing is by URL prefix stamped into each controller's `@RequestMapping` (events-api public
  endpoints under `/api/events/public/...` and `/api/public/...`).
- Response shapes differ per service: `ResponseDto<T>` envelope (iam, events), real status codes and
  plain bodies (new tenants-api code); errors come from `GlobalExceptionHandler` in yet another shape.
- Kafka topics (producer → consumer), verified 2026-10-21:

| Topic | Produced by | Consumed by |
|---|---|---|
| `quickstart-events` | sfn-events-api (`EventKafkaProducer`) + browser extension | sfn-events-api (`EventKafkaConsumer`) |
| `device-registration` | sfn-iam-api (`DeviceRegistrationProducer`) | sfn-events-api (`DeviceRegistrationConsumer`) |
| `device-deleted` | sfn-events-api (`DeviceDeletedProducer`) | sfn-iam-api (`DeviceDeletedConsumer`) |
| `extension-approval-decided` | sfn-events-api (`ExtensionApprovalDecidedProducer`) | sfn-tenants-api (`ExtensionApprovalDecidedConsumer`) |
| `extension-policy-changed` | sfn-tenants-api (`ExtensionPolicyChangedProducer`) | sfn-events-api (`ExtensionPolicyChangedConsumer`) |
| `policy-events` | sfn-tenants-api (`PolicyKafkaProducer`) | sfn-tenants-api (`PolicyKafkaConsumer`) |

- Ingestion is asynchronous: Kafka → `event_inbox` → scheduled flush (default every 20 min) → `events`.

## Rules

| ID | Severity | Rule |
|---|---|---|
| CON-001 | blocker | **REST only.** A removed or renamed HTTP request/response field, path, path variable, query param or HTTP verb that a caller still uses (sfn-web-ui `apiEndpoints.js`/services, another API's client, the extension). Name every broken caller with file:line. **Kafka payloads are never CON-001 — use CON-004.** |
| CON-002 | major | A field whose **type, nullability, enum values or format** changed (e.g. string → number, date format, new enum constant the UI `switch` doesn't handle). |
| CON-003 | major | A changed **status code or error body** for an existing endpoint (e.g. 200 → 202, 404 → 403) without updating callers that branch on it. |
| CON-004 | blocker | **Kafka only.** A Kafka payload change (removed/renamed/retyped field, changed key, changed topic name) whose consumer in **any** repo still expects the old shape. Additive fields are fine only if the consumer's deserializer ignores unknown properties — check it. |
| CON-005 | major | A new Kafka producer or topic with no consumer, or a consumer for a topic nobody produces (dead path), unless the PR says why. |
| CON-006 | major | A long-running synchronous endpoint (bulk delete, provisioning, export, sync) called from sfn-web-ui without a per-request `timeout` override — the 30 s default aborts it while the server keeps going. |
| CON-007 | major | sfn-web-ui URL or service change that inlines a URL instead of `apiEndpoints.js`, or calls `import axios` directly instead of `axiosConfig.js`. |
| CON-008 | major | Endpoint moved to a different `ResponseDto` / plain shape than the callers unwrap (`response.data.data` vs `response.data`). |
| CON-009 | minor | A new endpoint or DTO field missing from the repo's hand-written API docs (`docs/` in each API) where the repo documents its API there. |
| CON-011 | major | **Deploy-order dependency across repos:** the change is one half of work split across repos (same work item / feature id) and the other half is not merged into develop. Detected deterministically by quick-check; confirm the halves really depend on each other and record the deploy order. *(Learned from PR !1381.)* |
| CON-010 | major | Consumers of async data assuming it is readable right after the POST (ingestion is delayed by the inbox flush). |

## How to check
- List changed public surface: controllers (`@*Mapping`), DTOs, Kafka producer payload classes.
- For each changed name, search all four repos under `<estateRoot>`:
  `grep -rn "<fieldOrPath>" <estateRoot>/sfn-web-ui/src <estateRoot>/sfn-*-api/src/main`.
- A repo missing from `<estateRoot>` → say so in `verdictReason`; never assume it has no callers.
