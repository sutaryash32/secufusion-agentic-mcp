# Rules — database, migrations, shared data

Area rules for `/sfn-review`. Applies to: sfn-tenants-api, sfn-iam-api, sfn-events-api.

## Platform facts (verified)
- The three APIs share **one Postgres database**. The `tenant` table is shared; entities map it with
  `ddl-auto: none`, so Hibernate never creates or alters anything.
- Each repo owns its own `src/main/resources/db/migration/V<n>__<snake_case>.sql` series.
  **No Flyway runs at startup** — ops apply migrations by hand, in order, per repo.
- Delete styles differ: tenants-api **hard**-deletes, events-api **soft**-deletes by status flag
  (never `DELETE`), iam-api mixed.
- Join tables `user_group_map`, `group_role_map`, `role_scope_mapping` have **no DDL in any repo**;
  their FK / `ON DELETE` behaviour is only known from the live DB.
- `incident_events.fk_event_id → events` has **no ON DELETE** (RESTRICT).
- sfn-iam-api requires a matching migration test under `src/test/java/com/secufusion/iam/migration/`.

## Rules

| ID | Severity | Rule |
|---|---|---|
| DB-001 | blocker | An entity field/column/table/index change (`@Column`, `@Table`, `@JoinColumn`, new `@Entity`, type or nullability change) with **no new `V<n>__*.sql`** in the same change. `ddl-auto` is none, so the code fails at runtime against the real DB. |
| DB-002 | blocker | An **edit to an already-existing migration file** (any `V<n>` that exists on the base branch). Applied migrations are immutable; add a new version instead. *Enforced deterministically by `check_applied_migrations`; the quick check runs it.* |
| DB-003 | major | Migration version **clashes or gaps**: the new `V<n>` is ≤ the current head on the base branch, duplicates a number, or the filename doesn't match `V<n>__<snake_case>.sql`. tenants-api already has a known duplicate V42 — don't add another. |
| DB-004 | blocker | A change to the **shared `tenant` table** (column, constraint, entity mapping) made in one repo without checking the `Tenant` entity in the other two APIs. Report every other repo whose mapping breaks or silently ignores the column. |
| DB-005 | major | A bulk delete / cascade touching `user_group_map`, `group_role_map` or `role_scope_mapping` that relies on an FK cascade or ordering no DDL in the repo proves. Ask for the live-DB FK check in the PR. |
| DB-006 | blocker | Deleting `events` rows without first deleting/unlinking `incident_events` rows (FK RESTRICT → the delete fails, often mid-batch). |
| DB-007 | blocker | A hard `DELETE` (repository delete, `@Query` DELETE, native SQL) in **sfn-events-api**, which soft-deletes by status. |
| DB-008 | major | A migration that is unsafe on a large live table: `ALTER ... ADD COLUMN ... NOT NULL` without a default on an existing table, a full-table `UPDATE` with no batching on `events`/`event_inbox`/`devices`, a non-concurrent index on a hot table, or a destructive `DROP` with no backup/rollback note. |
| DB-009 | major | A new FK column without an index, or a new query filtering on a column with no index on a table that grows per event/device. |
| DB-010 | major | sfn-iam-api schema change without a migration test under `src/test/java/com/secufusion/iam/migration/`. |
| DB-011 | major | Data backfill in the same migration as a schema change, or a backfill that is not idempotent (re-running it would duplicate or corrupt rows). Ops applies by hand; reruns happen. |
| DB-012 | blocker | Tenant status misuse: setting `Tenant.status` to `FAILED` for anything other than provisioning failure. `ProvisioningRetryScheduler` re-provisions every `FAILED` tenant (tenant delete uses `DELETE_FAILED`). |
| DB-013 | major | Provisioning state updated in one mechanism but not the other: the free-text `Tenant.status` and the `ProvisionStep` bitmask must change together (sfn-tenants-api). |
| DB-014 | major | Bulk work loaded with unbounded `findAll()` / no pagination on a per-tenant or per-event table, or N+1 lazy loading inside a loop over a large collection. |
| DB-015 | major | A multi-step write (delete + insert, status + child rows) with no `@Transactional` boundary, so a failure halfway leaves partial state. |

## How to check
- `git diff --name-status <base>...<head> -- '*/db/migration/*'` to see added vs modified migrations.
- Current head on base: `git ls-tree --name-only <base> <migrations dir>/` then sort by version.
- For DB-004, grep the other repos: `grep -rn '@Table(name *= *"tenant"' <estateRoot>/sfn-*-api/src/main`.
