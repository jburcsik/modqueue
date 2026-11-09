# SQL contract

The migration, the Supabase store, the reference admin and the tests
follow this file and from `src/types.ts`, `src/config.ts` and
`src/store.ts`. Where a number appears in SQL, the source of that number is
named here. Column names are the snake_case form of the TypeScript fields.

## Schemas

| Schema | Holds | Exposed to PostgREST |
|---|---|---|
| `public` | every table, view and function below except the rate-limit table | yes |
| `internal` | `rate_limit_entries` | no; `usage` granted to `service_role` only |

## Tables

Every foreign key to a person points at `auth.users(id)`. The kit never
references a host profile table.

### `public.moderation_roles`

| Column | Type | Constraints |
|---|---|---|
| `user_id` | `uuid` | primary key, references `auth.users(id)` on delete cascade |
| `role` | `text` | not null, check in `ROLES` |
| `display_name` | `text` | null |
| `created_at` | `timestamptz` | not null default `now()` |

A user with no row is a `member`.

### `public.moderation_content` (contract; example table)

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | primary key default `gen_random_uuid()` |
| `owner_id` | `uuid` | not null, references `auth.users(id)` on delete cascade |
| `moderation_state` | `text` | not null default `'visible'`, check in `CONTENT_STATES` |
| `created_at` | `timestamptz` | not null default `now()` |
| `body` | `text` | null |

Rules:

- `moderation_content` is the only content name the kit's SQL uses.
- The baseline ships it as a table, used by the seed, the tests and the
  reference admin.
- A host replaces it with an updatable view over its own table, exposing
  exactly these five columns (`body` may be null). The host then recreates
  the trigger `trg_open_case_for_held` on its own table, since a trigger on a
  view does not fire on the base table.
- No kit table carries a foreign key to `moderation_content`, because a view
  cannot be a foreign-key target. Orphans are cleared by
  `purge_orphaned_moderation()`.
- Visibility below `config.reach.visibilityFloor` is the host's read path
  rule; the kit stores the state only.

### `public.moderation_reputation_inputs` (view; host-defined)

| Column | Type | Meaning |
|---|---|---|
| `user_id` | `uuid` | one row per user |
| `account_created_at` | `timestamptz` | from `auth.users.created_at` |
| `posts` | `integer` | content rows owned |
| `endorsed_posts` | `integer` | content rows the host counts as endorsed |
| `endorsements_given` | `integer` | endorsements the user gave |
| `reports_received` | `integer` | reports on the user's content in state `upheld`; open reports do not count until a moderator upholds them |
| `far_rate` | `numeric` | null when unknown; null is factor 1.0 |

The example view joins `auth.users`, `moderation_content` and
`moderation_reports`; `endorsed_posts` and `endorsements_given` are 0 and
`far_rate` is null because the example has no endorsement or origin concept.
A host whose client can omit its origin may count a missing origin as far
when building `far_rate`; that rule lives in the host's view, not in the kit.

### `public.moderation_settings`

One row. `id` is fixed to `'default'`.

| Column | Type | Constraints |
|---|---|---|
| `id` | `text` | primary key default `'default'`, check `id = 'default'` |
| `automation_level` | `text` | not null, check in `AUTOMATION_LEVELS` |
| `warn_threshold` | `numeric` | not null, check between 0 and 1 |
| `hold_threshold` | `numeric` | not null, check between 0 and 1 |
| `auto_action_confidence` | `numeric` | not null, check between 0 and 1 |
| `auto_warn_keywords` | `text[]` | not null default `'{}'` |
| `auto_block_keywords` | `text[]` | not null default `'{}'` |
| `full_auto_acknowledged_at` | `timestamptz` | null |
| `auto_hide_weight` | `numeric` | not null, check `> 0` |
| `report_min_account_age_hours` | `integer` | not null, check `>= 0` |
| `report_rate_max` | `integer` | not null, check `> 0` |
| `report_rate_window_seconds` | `integer` | not null, check `> 0` |
| `appeal_rate_max` | `integer` | not null, check `> 0` |
| `appeal_rate_window_seconds` | `integer` | not null, check `> 0` |
| `report_identity_retention_days` | `integer` | not null, check `>= 0` |
| `reach_enabled` | `boolean` | not null |
| `updated_at` | `timestamptz` | not null default `now()` |
| `updated_by` | `uuid` | null, references `auth.users(id)` on delete set null |

Table check: `automation_level <> 'full_auto' or full_auto_acknowledged_at is not null`.

Every column default equals the matching field of `defaultConfig.settings`.
The migration inserts the row with defaults. The reference admin's settings
page edits this row through the store; nothing else writes it.

### `public.moderation_events`

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | primary key default `gen_random_uuid()` |
| `target_type` | `text` | not null, check in `TARGET_TYPES` |
| `target_id` | `uuid` | not null |
| `case_id` | `uuid` | null, references `moderation_cases(id)` on delete set null |
| `event_type` | `text` | not null, check in `EVENT_TYPES` |
| `source` | `text` | not null, check in `ACTOR_SOURCES` |
| `severity` | `text` | not null, check in `SEVERITIES` |
| `summary` | `text` | null |
| `details` | `jsonb` | not null default `'{}'` |
| `actor_id` | `uuid` | null, references `auth.users(id)` on delete set null |
| `prior_state` | `text` | null, check in `CONTENT_STATES` |
| `created_at` | `timestamptz` | not null default `now()` |

Indexes: `(target_type, target_id, created_at desc)`, `(event_type, created_at desc)`, `(actor_id, created_at desc)`, `(case_id)`.

Append-only: no update or delete grant to any role but `service_role`, and
the kit never updates a row.

### `public.user_strikes`

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | primary key default `gen_random_uuid()` |
| `user_id` | `uuid` | not null, references `auth.users(id)` on delete cascade |
| `severity` | `text` | not null, check in `SEVERITIES` |
| `points` | `integer` | not null, check between `config.strikes.pointsMin` and `pointsMax` |
| `reason` | `text` | not null |
| `moderation_event_id` | `uuid` | null, references `moderation_events(id)` on delete set null |
| `expires_at` | `timestamptz` | null; null means permanent |
| `revoked_at` | `timestamptz` | null |
| `revoked_by` | `uuid` | null, references `auth.users(id)` on delete set null |
| `created_at` | `timestamptz` | not null default `now()` |

Index: `(user_id, created_at desc) where revoked_at is null`.

Points and expiry are computed in TypeScript from `config.strikes.weights`;
SQL stores what it is given.

### `public.moderation_cases`

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | primary key default `gen_random_uuid()` |
| `target_id` | `uuid` | not null; a `moderation_content.id` |
| `state` | `text` | not null default `'open'`, check in `CASE_STATES` |
| `claimed_by` | `uuid` | null, references `auth.users(id)` on delete set null |
| `claimed_at` | `timestamptz` | null |
| `decided_at` | `timestamptz` | null |
| `decision` | `text` | null, check in `CASE_DECISIONS` |
| `created_at` | `timestamptz` | not null default `now()` |

Indexes: unique `(target_id) where state in ('open', 'claimed')` (one open
case per target); `(state, created_at desc)`; `(claimed_by) where claimed_by is not null`.

A report arriving after a decision opens a new case. Decided cases are never
reopened; `restore` moves a decided case to `reversed`.

### `public.moderation_reports`

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | primary key default `gen_random_uuid()` |
| `case_id` | `uuid` | null, references `moderation_cases(id)` on delete set null |
| `target_id` | `uuid` | not null; a `moderation_content.id` |
| `reporter_id` | `uuid` | null, references `auth.users(id)` on delete set null |
| `reason` | `text` | null, check `char_length(reason) <= config.reports.reasonMaxChars` |
| `evidence_paths` | `text[]` | not null default `'{}'`, check `cardinality <= config.reports.maxEvidencePaths` |
| `trust_weight` | `numeric` | not null, check between `config.reach.clamp.min` and `max` |
| `state` | `text` | not null default `'open'`, check in `REPORT_STATES` |
| `created_at` | `timestamptz` | not null default `now()` |
| `resolved_at` | `timestamptz` | null |

Indexes: `(target_id)`; `(case_id)`; unique `(reporter_id, target_id) where state = 'open' and reporter_id is not null`
(one open report per reporter per target); `(resolved_at) where reporter_id is not null and resolved_at is not null` (drives the identity purge).

Reports resolve; they are never deleted by a decision.

### `public.moderation_appeals`

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | primary key default `gen_random_uuid()` |
| `user_id` | `uuid` | not null, references `auth.users(id)` on delete cascade |
| `strike_id` | `uuid` | not null, references `user_strikes(id)` on delete cascade |
| `moderation_event_id` | `uuid` | null, references `moderation_events(id)` on delete set null |
| `statement` | `text` | not null, check `char_length` between `config.appeals.statementMinChars` and `statementMaxChars` |
| `state` | `text` | not null default `'pending'`, check in `APPEAL_STATES` |
| `resolved_by` | `uuid` | null, references `auth.users(id)` on delete set null; not in the member select grant |
| `resolved_at` | `timestamptz` | null |
| `reviewer_note` | `text` | null; internal, not in the member select grant |
| `created_at` | `timestamptz` | not null default `now()` |

Index: unique `(strike_id) where state = 'pending'` (one pending appeal per strike).

`moderation_event_id` is copied from the strike at filing time by `file_appeal_for`.

### `internal.rate_limit_entries`

| Column | Type | Constraints |
|---|---|---|
| `key` | `text` | not null |
| `created_at` | `timestamptz` | not null default `now()` |

Index: `(key, created_at)`. Keys are `<preset>:<identifier>`; the daily
submission cap uses `daily:<user_id>` with a one-day window and the trust
tier's `submissionsPerDay` as `max`.

## Views

### `public.moderation_queue`

`security_invoker = true`. One row per case.

| Column | Source |
|---|---|
| `case_id` | `moderation_cases.id` |
| `case_state` | `moderation_cases.state` |
| `claimed_by` | `moderation_cases.claimed_by` |
| `claimed_at` | `moderation_cases.claimed_at` |
| `case_created_at` | `moderation_cases.created_at` |
| `content_id` | `moderation_content.id` |
| `owner_id` | `moderation_content.owner_id` |
| `moderation_state` | `moderation_content.moderation_state` |
| `content_created_at` | `moderation_content.created_at` |
| `preview` | `left(moderation_content.body, 240)`; null when body is null |
| `open_report_count` | count of reports on the case in state `open` |
| `total_report_count` | count of reports on the case |

The store's `readQueue` joins reports, events, owner strike points and reach
in application code and applies the identity rule: when `includeIdentity` is
false, `owner_id`, `ownerDisplayName` and every `reporter_id` are null and
the `ownerId` filter is refused with `forbidden`. Admins read with identity;
moderators never do.

## Functions

Every function below is created with `set search_path = ''` and every object
in its body is schema-qualified. After each `create function` the migration
runs `revoke execute ... from public, anon, authenticated` and then grants
exactly the roles in the table. The probe `client_callable_definer_functions()`
returns exactly the four rows of the first table and nothing else.

### Client-callable (SECURITY DEFINER; `authenticated` only)

| Signature | Returns | Behaviour |
|---|---|---|
| `get_my_role()` | `text` | `moderation_roles.role` for `auth.uid()`, or `'member'` |
| `get_my_strike_count()` | `integer` | count of the caller's strikes that are neither revoked nor expired; never points, never rows |
| `file_report(p_target_id uuid, p_reason text, p_evidence_paths text[])` | `uuid` | resolves `auth.uid()`, raises `unauthenticated` when null, calls `file_report_for` |
| `file_appeal(p_strike_id uuid, p_statement text)` | `uuid` | resolves `auth.uid()`, raises `unauthenticated` when null, calls `file_appeal_for` |

Hardening rules, each tested:

- Identity comes from `auth.uid()` only. No function takes a user id for the caller.
- `raise exception` when `auth.uid()` is null.
- `security definer set search_path = ''`.
- `revoke execute from public, anon`; `grant execute to authenticated`.
- Rate limits run inside the function against `internal.rate_limit_entries`.
- Length and shape checks are duplicated as table CHECKs.

### Service-side (`service_role` only)

| Signature | Security | Returns | Behaviour |
|---|---|---|---|
| `check_rate_limit(p_key text, p_window_seconds integer, p_max integer)` | definer | `boolean` | takes `pg_advisory_xact_lock(hashtext(p_key))`, counts rows for the key newer than the window; false at or above `p_max`; else inserts a row, deletes expired rows for the key, returns true |
| `get_active_strike_points(p_user_id uuid)` | invoker | `integer` | sum of points where `revoked_at is null` and (`expires_at is null` or in the future); 0 when none |
| `get_user_reputation(p_user_id uuid)` | invoker | `integer` | reputation score from the view row and the SQL copy of `config.reputation`; null when the view has no row |
| `calculate_reach_coefficient(p_user_id uuid)` | invoker | factor row (below) | the SQL copy of `computeReach` |
| `decide_moderation_case(p_case_id uuid, p_decision text, p_flag_justified boolean, p_actor_id uuid, p_source text, p_reason text)` | invoker | decision row (below) | one transaction: content state, open reports, case, audit row |
| `file_report_for(p_reporter_id uuid, p_target_id uuid, p_reason text, p_evidence_paths text[])` | invoker | `uuid` | the report guards; called by `file_report` and by the store |
| `file_appeal_for(p_user_id uuid, p_strike_id uuid, p_statement text)` | invoker | `uuid` | the appeal guards; called by `file_appeal` and by the store |
| `sweep_expired_strikes()` | invoker | `integer` | releases tier-held content; returns the count released |
| `purge_report_identities()` | invoker | `integer` | nulls `reporter_id` on reports resolved longer ago than `report_identity_retention_days`; returns the count |
| `purge_orphaned_moderation()` | invoker | `table (reports_purged integer, cases_purged integer)` | deletes reports then cases whose `target_id` has no `moderation_content` row |
| `security_definer_functions_without_search_path()` | invoker | `table (schema_name text, function_name text, arguments text)` | SECURITY DEFINER functions in `public` and `internal` with no pinned `search_path`; must return zero rows |
| `client_callable_definer_functions()` | invoker | `table (function_name text, arguments text, anon boolean, authenticated boolean)` | SECURITY DEFINER functions in `public`, excluding extension-owned, that `anon` or `authenticated` can execute |

`calculate_reach_coefficient` returns:

| Column | Type |
|---|---|
| `coefficient` | `numeric` |
| `enabled` | `boolean` |
| `age_factor` | `numeric` |
| `reputation_factor` | `numeric` |
| `strike_factor` | `numeric` |
| `engagement_factor` | `numeric` |
| `far_report_factor` | `numeric` |
| `account_age_hours` | `numeric` |
| `reputation_score` | `integer` |
| `active_strike_points` | `integer` |
| `posts` | `integer` |
| `endorsed_posts` | `integer` |
| `endorsements_given` | `integer` |
| `reports_received` | `integer` |
| `far_rate` | `numeric` |

When `moderation_settings.reach_enabled` is false: `coefficient` 1.0,
`enabled` false, every factor 1.0, inputs still populated. When the view has
no row: `coefficient` is `config.reach.unknownUserCoefficient`, factors null.

`decide_moderation_case` returns:

| Column | Type |
|---|---|
| `case_id` | `uuid` |
| `decision` | `text` |
| `moderation_state` | `text` |
| `prior_state` | `text` |
| `reports_resolved` | `integer` |
| `event_id` | `uuid` |

Behaviour of `decide_moderation_case`, in order, in one transaction:

1. Raise `not_found` when the case does not exist; raise `case_not_open` when
   its state is `decided` and `p_decision` is not `restore`, or when its state
   is `reversed`. Raise `invalid_input` for an unknown decision or source.
2. Read `moderation_content.moderation_state` as `prior_state`. Raise
   `case_not_open` for `restore` unless the case's `decision` is `remove`, no
   later case exists for the target and `prior_state` is `removed`.
3. Set `moderation_state` to `removed` for `remove`, else `visible`.
4. Resolve every open report on the case: `upheld` only when
   `p_flag_justified` is true; null and false both resolve to `rejected`.
5. Set the case to `reversed` for `restore`, else `decided`; set `decision`
   and `decided_at`.
6. Insert one event: `target_type = 'content'`, `event_type` =
   `content_approve` for `keep`, `content_remove` for `remove`,
   `content_restore` for `restore`; `source = p_source`; `severity` =
   `violation` for `remove`, else `info`; `summary = p_reason`;
   `details = {decision, flag_justified}`; `actor_id = p_actor_id`;
   `case_id`; `prior_state`.
7. Return the row.

One event per action. The spine calls `decide_moderation_case` for
`approve`, `dismiss` and `remove` and does not write a second content event;
it writes `content_hold`, `content_warn` and `mod_note` itself for the ops
that do not settle a case. `approve` passes `flag_justified` null,
`dismiss` false, `remove` true.

Behaviour of `file_report_for`, in order:

1. `not_found` when the reporter has no `moderation_reputation_inputs` row;
   `account_too_new` when `account_created_at` from that view is newer than
   `report_min_account_age_hours`.
2. `rate_limited` when `check_rate_limit('report:' || reporter, report_rate_window_seconds, report_rate_max)` is false.
3. `not_found` when the target has no `moderation_content` row or its state
   is not `visible`; members cannot select held or removed rows, so the
   function does not reveal them either.
4. `self_report` when the target's `owner_id` is the reporter.
5. `invalid_input` when `reason` exceeds `reasonMaxChars`, when more than
   `maxEvidencePaths` paths are given, or when any path fails
   `config.reports.evidencePathPattern` (segments of letters, digits, dot,
   underscore and hyphen joined by single slashes; the first character is a
   letter or digit; no segment equal to `.` or `..`; no leading, trailing or
   doubled slash) or exceeds `evidencePathMaxChars`.
6. `duplicate_report` when the reporter already has an open report on the target.
7. `trust_weight` = `calculate_reach_coefficient(reporter).coefficient`.
8. Open a case for the target if none is open; insert the report with that `case_id`.
9. When the sum of `trust_weight` over open reports on the target is at or
   above `auto_hide_weight` and the content is `visible`, set it to `held`
   (the trigger finds the case already open) and insert one `content_hold`
   event on that case: `source = 'system'`, `severity = 'warning'`,
   `prior_state = 'visible'`, `details = {reason: 'auto_hide', weight_sum,
   threshold}`.
10. Return the report id.

Behaviour of `file_appeal_for`, in order:

1. `not_found` when the strike does not exist.
2. `not_strike_owner` when `user_strikes.user_id` is not the appellant.
3. `strike_inactive` when the strike is revoked or expired.
4. `rate_limited` when `check_rate_limit('appeal:' || user, appeal_rate_window_seconds, appeal_rate_max)` is false.
5. `invalid_input` when the statement is outside the length bounds.
6. `duplicate_appeal` when a pending appeal exists for the strike.
7. Insert with `moderation_event_id` copied from the strike; insert an
   `appeal_filed` event (`target_type = 'user'`, `source = 'member'`,
   `actor_id` = appellant, `details = {appeal_id, strike_id}`).
8. Return the appeal id.

Behaviour of `sweep_expired_strikes()`:

1. Candidate cases: state `open`, content `held`, no open reports, and every
   event with this `case_id` is a `tier_hold`.
2. Of those, keep the ones whose owner's `get_active_strike_points` is
   strictly below the `release_below_points` integer stored in the
   `tier_hold` event's `details`. A `tier_hold` whose value is missing or not
   an integer is skipped, never released, and does not abort the sweep.
3. One `update ... returning` sets the content `visible`; the returned ids
   close their cases as `decided` with decision `keep` and insert one
   `content_approve` event each (`source = 'system'`, `summary` states the
   release, `prior_state = 'held'`).
4. Return the count.

Content held by a moderator, by `automated`, by the report auto-hide or by
the trust gate for a new account carries a `content_hold` event and is never
released by the sweep; a moderator or admin settles it through a case
decision. Only a hold written as `tier_hold` (the `review_gated` ladder tier)
is released by the sweep.

Report states `duplicate` and `withdrawn` are set through the store's
`resolveReport` by server code acting for a moderator or admin; members have
no path to change a report after filing. Settings are read and written only
through server code: the reference admin lets an admin edit them and lets a
moderator read them; the database grants neither role direct access.

## Raising errors from SQL

A guard raises `raise exception using message = '<code>', errcode = '<sqlstate>'`
where `<code>` is a `ModerationErrorCode` and the SQLSTATE is from this table.
The Supabase store maps the message back to `ModerationError(code)`; any
other database error becomes `store_error`.

| Code | SQLSTATE | HTTP |
|---|---|---|
| `unauthenticated` | `MQ001` | 401 |
| `forbidden` | `MQ002` | 403 |
| `not_found` | `MQ003` | 404 |
| `invalid_input` | `MQ004` | 400 |
| `rate_limited` | `MQ005` | 429 |
| `account_too_new` | `MQ006` | 403 |
| `self_report` | `MQ007` | 400 |
| `duplicate_report` | `MQ008` | 409 |
| `duplicate_appeal` | `MQ009` | 409 |
| `not_strike_owner` | `MQ010` | 403 |
| `strike_inactive` | `MQ011` | 409 |
| `appeal_not_pending` | `MQ012` | 409 |
| `case_not_open` | `MQ013` | 409 |
| `case_claimed_by_other` | `MQ014` | 409 |
| `posting_paused` | `MQ015` | 403 |
| `content_blocked` | `MQ016` | 422 |
| `store_error` | `MQ017` | 500 |

The HTTP column is `ERROR_HTTP_STATUS` in `src/types.ts`; the reference
admin's handlers return `{ error: { code, message } }` with that status,
where `message` is a fixed string per code from a map in the admin and never
the thrown message.

A check constraint violation (SQLSTATE `23514`), such as `full_auto` without an
acknowledgement, maps to `invalid_input`. A unique violation (SQLSTATE `23505`)
maps to `invalid_input` with a fixed message that does not name the
constraint. Any other database error maps to `store_error` with the message
kept.

## Grants

| Object | `anon` | `authenticated` | `service_role` |
|---|---|---|---|
| `moderation_roles` | none | none | all |
| `moderation_content` (example) | none | select where `moderation_state = 'visible'` or `owner_id = auth.uid()` | all |
| `moderation_reputation_inputs` | none | none | select |
| `moderation_settings` | none | none | all |
| `moderation_events` | none | none | all |
| `user_strikes` | none | none | all |
| `moderation_cases` | none | none | all |
| `moderation_reports` | none | none | all |
| `moderation_appeals` | none | select of `id, user_id, strike_id, moderation_event_id, statement, state, created_at, resolved_at` where `user_id = auth.uid()`; `resolved_by` and `reviewer_note` are not granted | all |
| `moderation_queue` | none | none | select |
| `internal.rate_limit_entries` | none | none | all |
| the four client-callable functions | none | execute | execute |
| every other function | none | none | execute |

Rules:

- RLS is enabled on every table. The only policies are the two `authenticated`
  selects above. Everything else is reached by `service_role`, which bypasses
  RLS, from the kit's server functions behind an `Authorizer`.
- Members reach the database only through the four functions plus their own
  appeals. Moderators and admins have no direct grants; their role is a
  `moderation_roles` row read by the server.
- The migration revokes the Supabase default grants on each new table and
  function before granting, so inherited privileges cannot widen the surface.
- pgTAP carries one allow and one deny test per row of the grant table and
  per role (`anon`, `authenticated` as member, `authenticated` as moderator,
  `authenticated` as admin, `service_role`). Moderator deny rows on cases,
  reports, strikes, events and settings are expected results.

## Triggers

| Trigger | On | Rule |
|---|---|---|
| `trg_open_case_for_held` | `moderation_content`, after insert or update of `moderation_state` | when the new state is `held` and no open or claimed case exists for the row, insert one with state `open` |

The one-open-case index, the one-pending-appeal index and the
one-open-report index are the other invariants; they are indexes, not
triggers, so a race ends in a unique violation rather than a duplicate.

## Scheduled jobs

The migration schedules nothing unless `pg_cron` is installed. The block is
guarded by `if exists (select 1 from pg_extension where extname = 'pg_cron')`.
Job names and schedules:

| Job | Schedule | Calls |
|---|---|---|
| `modqueue_sweep_strikes` | `15 4 * * *` | `select public.sweep_expired_strikes()` |
| `modqueue_purge_report_identities` | `30 4 * * *` | `select public.purge_report_identities()` |
| `modqueue_purge_orphans` | `45 4 * * *` | `select public.purge_orphaned_moderation()` |

A host without `pg_cron` calls the three functions from its own scheduler.

## Parity rules (TypeScript and SQL)

| Rule | Checked by |
|---|---|
| `calculate_reach_coefficient` equals `computeReach(inputs, defaultConfig)` on every fixture row | integration parity test |
| `get_user_reputation` equals `calculateReputationScore(inputs, defaultConfig.reputation)` on every fixture row | integration parity test |
| Every CHECK list in the migration equals the matching `as const` array in `src/types.ts`, in value and order | `test/sql-parity.test.ts`, a unit test reading the migration file |
| `moderation_settings` column defaults equal `defaultConfig.settings` | pgTAP comparing the seeded row to the literals in `supabase/tests/10_settings.sql` |
| `config.rateLimits.report` and `config.rateLimits.appeal` equal the matching settings columns | unit test |
| `config.reach.enabled` and `settings.reachEnabled` are seeded equal | seed |
| `tier_hold` events carry `details.release_below_points = config.strikes.ladder.reviewGated` | unit test on the pipeline |

A host that tunes `config.reach` or `config.reputation` edits the same
literals in the migration; the parity test is the drift alarm.

## What the host supplies

| Item | Form |
|---|---|
| Content | the example `moderation_content` table, or an updatable view with the five contract columns and the trigger recreated on the base table; the member select policy shows `owner_id` and `body` of every visible row to every member, so a host view keeps an equivalent policy |
| Reputation inputs | the example view, or a view with the seven columns |
| Roles | rows in `moderation_roles` for moderators and admins; members need none |
| Scheduling | `pg_cron` on the database, or an external caller for the three functions |
| Provider key | an option passed to the provider adapter; `allowAllProvider` and the fixture provider need none |
| Notifier | an implementation of `Notifier`, or the no-op one |
| Authorizer | an implementation of `Authorizer` for its server framework |
