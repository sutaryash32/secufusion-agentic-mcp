# Repo rules — sfn-web-ui

Read the repo's own `CLAUDE.md`, `docs/PATTERNS.md` and, for any auth/tenant/permission change,
`docs/architecture/_core.md`. They win on conflicts with this file.

- Stack: JavaScript (ESM, **no TypeScript**), React 19, Vite 7, MUI 7, Redux Toolkit, react-router 7,
  Formik + Yup, axios, Keycloak. Tests: Vitest + Testing Library, only under `src/__tests__/`.
- Feature = `routes/modules/<x>.routes.jsx` → `modules/<Feature>/*.jsx` → `services/<x>Service.js`
  → URLs in `src/utils/apiEndpoints.js`.
- **HTTP only via `src/utils/axiosConfig.js`**; URLs only via `apiEndpoints.js` (CON-007).
- `axiosConfig.js` times out every request at **30 s**; long endpoints need a per-request `timeout`
  (CON-006).
- Server data is local component state; Redux holds only `auth`/`tenant`/`feature`/`ui`/`notification`.
  Feature data in Redux is a finding (minor).
- Gate privileged UI with `usePermissions`, `<PermissionGate>`, `<ProtectedRoute>` (SEC-013); menu items
  use `requiredScopes`.
- Tenant-scoped calls use `useEffectiveTenantId` / `selectActingTenantId`, never `currentUser.tenantId`
  (SEC-014) — MSSP "Open as me" impersonation depends on it.
- Don't reimplement token refresh; don't swallow errors on security data (show them).
- Services re-throw API errors; pages show them via `useNotification()` or a local `<Snackbar>`.
- Never hard-code secrets; config comes from `import.meta.env.VITE_*`.
- Gates: `npm run lint`, `npm run test:run`. No typecheck.
