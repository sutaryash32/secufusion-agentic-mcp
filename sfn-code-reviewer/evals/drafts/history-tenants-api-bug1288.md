# Learned from: Merged PR 1423: WI 1288: stop Keycloak profile form for Entra sign-ins on new SSO tenants

- Case: `evals/cases/history-tenants-api-bug1288` — run `evals/run-evals.sh --case history-tenants-api-bug1288`
- Introduced by: PR !1072 — Merged PR 1072: Stop new tenant realms requiring firstName/lastName (`1bf6b42719`)
- Fixed by: `52c907dd1d` Merged PR 1423: WI 1288: stop Keycloak profile form for Entra sign-ins on new SSO tenants
- Expected finding near: `src/main/java/com/secufusion/tenant/util/KeycloakAdminUtil.java:15-16`, `src/main/java/com/secufusion/tenant/util/KeycloakAdminUtil.java:495-535`
- Specialists that own these files: security

## If the reviewer misses this case

1. Read the fix below and name the **failure** it prevented, in one sentence.
2. If a rule already covers it, sharpen that rule's text in `rules/shared/<area>.md` (or raise its
   severity / add a floor in `config/review.config.yml`). Otherwise add a row:

   `| XXX-NNN | major | <what is wrong> — <how it fails in production> |`

3. If the file path didn't trigger the right specialist, add a `riskRules` entry in `config/repos.yml`.
4. `npm run build`, re-run the case, and keep the case in `evals/cases` forever.

## The fix

```diff

```
