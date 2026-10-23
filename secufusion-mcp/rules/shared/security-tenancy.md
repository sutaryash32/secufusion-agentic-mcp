# Rules — security and tenant isolation

Area rules for `/sfn-review`. Applies to all four repos.

## Platform facts (verified)
- **Mutating endpoints are deny-by-default.** `EndpointScopeCoverageInterceptor` (each API,
  `security/`) returns 403 `UNCLASSIFIED_ENDPOINT` for any POST/PUT/PATCH/DELETE handler in the
  controller package that has neither `@PreAuthorize` nor an entry in `MutatingEndpointAllowlist`.
  `EndpointAuthorizationCoverageTest` fails the build on the same condition. GETs are
  authenticated-only — **reads are NOT scope-gated by the interceptor.**
- **Cross-tenant access** goes through `TenantAccessGuard` → `ParentChainAuthorizer`.
  `TenantAccessInterceptor` only guards a `tenantId` **path variable or query param**. A tenant id that
  arrives in a request body or under another name must be checked explicitly with
  `tenantAccessGuard.requireCallerCanAccess(id)`. In sfn-iam-api the guard is called **in the controller**.
- `isCallerAncestorOrSelf` allows **self or direct parent only** (one hop) plus platform admin — despite
  its name it does not walk the whole chain.
- **Tenant isolation is by convention, not RLS or Hibernate filters.** Every repository query must take
  and filter by `tenantId`. Nothing else catches an omission.
- One JWT issuer per tenant: `DbJwtAuthenticationManagerResolver` reads `iss` unverified, then picks a
  per-issuer decoder. sfn-tenants-api owns `auth_provider_config`; iam-api and events-api read it.
- sfn-web-ui: privileged UI is gated by `usePermissions`, `<PermissionGate>`, `<ProtectedRoute>`;
  tenant-scoped calls must use `useEffectiveTenantId` / `selectActingTenantId`, never
  `currentUser.tenantId` (breaks MSSP "Open as me" impersonation).

## Rules

| ID | Severity | Rule |
|---|---|---|
| SEC-001 | blocker | A new or changed **mutating** endpoint with no `@PreAuthorize` scope check, added to `MutatingEndpointAllowlist` instead without a stated reason (public / self-service / platform-admin checked in body). Allowlisting to make the 403 go away is a blocker. |
| SEC-002 | blocker | A tenant id taken from the **request body, a header, or a non-`tenantId` path/query name** and used to read or write data without `requireCallerCanAccess(...)`. |
| SEC-003 | blocker | A repository method / `@Query` / native SQL / Criteria query on tenant-owned data with **no tenant predicate**, reachable from an endpoint or Kafka consumer. |
| SEC-004 | major | A new **GET** that returns tenant-owned or sensitive data and relies only on authentication (reads aren't scope-gated by the interceptor) — needs `@PreAuthorize` or a guard call. |
| SEC-005 | blocker | A platform-infra operation (realm/IdP config, global settings, cross-tenant listing) not protected by `requirePlatformAdmin()` or an equivalent admin scope. |
| SEC-006 | blocker | A change to `SecurityConfig`, JWT resolution, `TenantAccessGuard`/`ParentChainAuthorizer`/interceptors, or `MutatingEndpointAllowlist` in one API **without the same change in the other two**, or one that weakens fail-closed behaviour (null acting tenant → allowed, catch-and-continue, `permitAll` widening). |
| SEC-007 | major | `authz.scope-coverage.enforce` set to `false` in any committed properties file (shadow mode in production = no gate). |
| SEC-008 | blocker | Secrets, tokens, keys or passwords committed in code, properties, `.env`, pipeline YAML or test fixtures that look real. |
| SEC-009 | major | Logging of tokens, `Authorization` headers, passwords, API keys, full request bodies with credentials, or PII (emails, usernames) at INFO or above. |
| SEC-010 | blocker | SQL built by string concatenation with request input (native queries, `JdbcTemplate`, `createNativeQuery`); JPQL with concatenated input. |
| SEC-011 | major | A DTO returned to the client that now exposes internal fields (secrets, other tenants' ids, hashes, internal flags) — check entity→DTO mapping (`mapToDto` in iam, `fromEntity()` in events, inline in tenants). |
| SEC-012 | major | A Kafka consumer that trusts a `tenantId` from the message to act on data without validating it exists / belongs to the expected parent, when the producer is not a trusted internal service. |
| SEC-013 | major | sfn-web-ui: privileged page, route or action rendered without `PermissionGate` / `ProtectedRoute` / `usePermissions`, or a new `requiredScopes` entry missing for a scope-gated feature. |
| SEC-014 | major | sfn-web-ui: tenant-scoped call using `currentUser.tenantId` instead of `useEffectiveTenantId` / `selectActingTenantId`. |
| SEC-015 | major | sfn-web-ui: token handling outside `axiosConfig.js` (storing tokens in `localStorage`, a second refresh flow, raw `import axios`). |
| SEC-016 | major | A feature behind a flag that defaults to **on** (`${FLAG:true}`) when it adds endpoints or data writes; new features ship off by default. |
| SEC-017 | major | **Identity provider config written through a typed client as a full document** (Keycloak realm, user-profile, IdP or authentication-flow representations; any external admin API whose update is a full PUT). Fields the client library doesn't model are silently dropped on write-back — a read-modify-write that deletes config a newer server added. Pass the document through as raw JSON and change only the intended keys. **Concretely in this codebase:** `realm.users().userProfile().getConfiguration()` → modify the `UPConfig` → `update(upConfig)`, `realmResource.toRepresentation()` → set → `realmResource.update(rep)`, and the same for IdP / authentication-flow representations — every one of these is a full-document write through the Keycloak admin-client model. Flag it whenever the diff adds or changes such a write, even if the intended change is small (e.g. clearing `required` on two attributes). *(Learned from WI 1288 / PR !1072.)* |
| SEC-018 | major | **A sign-in can be blocked before the app's own access check.** Changes to Keycloak/IdP sign-in behaviour — first-broker-login flow, Review Profile / VERIFY_PROFILE, required user-profile attributes (firstName/lastName/email), required actions, IdP mappers — can stop users (e.g. Entra admins with no first/last name) on a Keycloak form, so the portal's "no access" / tenant-membership logic never runs. Ask: which accounts lack the newly required attribute, and what do they see? Also check the change is applied to both the master and the tenant realm, and to existing realms (backfill) where needed. *(Learned from WI 1288.)* |

## How to check
- For every changed controller method: HTTP verb → annotation present? → which tenant id reaches the
  service, and from where? → follow it to the repository query.
- `grep -rn "<MethodName>" <repo>/src/main/java/**/MutatingEndpointAllowlist.java` for allowlist entries.
- For SEC-006, diff the same file in the other API repos under `<estateRoot>`.
