# Rules — sfn-web-ui

Area rules for `/sfn-review`. Applies to: sfn-web-ui (and any react-vite repo).
Security gating (SEC-013/014/015) and API calls (CON-006/007/008) are owned by the security and
contracts specialists — don't duplicate them; mention them in `notes` only if they missed one.

## Platform facts (verified)
- JavaScript (ESM, no TypeScript), React 19, MUI 7, Redux Toolkit, react-router 7, Formik + Yup.
- Feature = `routes/modules/<x>.routes.jsx` (lazy pages, paths from `ROUTES`) → `modules/<Feature>/*.jsx`
  → `services/<x>Service.js` → URLs in `src/utils/apiEndpoints.js`.
- Server data lives in **local component state**; Redux holds only `auth`/`tenant`/`feature`/`ui`/
  `notification`.
- Notifications via `useNotification()` (notistack) or a local MUI `<Snackbar>`; styling via MUI
  `styled()` + `sx` + `getThemeColors(theme)`.
- Tests only run from `src/__tests__/` (Vitest + Testing Library).

## Rules

| ID | Severity | Rule |
|---|---|---|
| WEB-001 | major | A `useEffect` that fetches or subscribes with a missing/incorrect dependency array (stale tenant id after "Open as me", infinite refetch loop, or never refetching when the selected tenant changes). |
| WEB-002 | major | State updated after unmount / race between overlapping requests: a fetch in an effect with no cancellation (`AbortController`) or "latest request wins" guard, where the dependency (tenant, filter, page) can change while in flight — shows another tenant's or stale data. |
| WEB-003 | major | An API error swallowed in a page/service (empty catch, `console.log` only, rendering an empty list as if there were no data) — especially for security data (events, incidents, devices), which must show the error. |
| WEB-004 | major | Missing loading / error / empty state on a new data view, so a failure or slow call looks like "no data". |
| WEB-005 | minor | Feature/server data put in Redux instead of local state, or a new Redux slice outside the allowed set. |
| WEB-006 | minor | A new route not registered via `routes/modules/*.routes.jsx` + `ROUTES`, or a page not lazy-loaded like its siblings. |
| WEB-007 | major | Form without Yup validation for fields the backend validates (user can submit values that only fail server-side with a generic error), or Formik `onSubmit` without handling the rejected promise. |
| WEB-008 | minor | Accessibility: interactive element without an accessible name (icon-only `IconButton` with no `aria-label`/tooltip), click handlers on non-interactive elements, form inputs without labels. |
| WEB-009 | minor | `dangerouslySetInnerHTML`, `href` built from data without validation, or `window.open` without `noopener` — escalate to the security specialist's severity if the data is user-controlled. |
| WEB-010 | minor | Large list rendered without pagination/virtualisation where the backend returns per-device or per-event rows. |
| WEB-011 | nit | Hard-coded colours instead of `getThemeColors(theme)` (breaks dark mode). |
