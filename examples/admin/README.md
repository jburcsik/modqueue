# Reference admin

A minimal Next.js app that runs the kit end to end on invented fixtures: a
moderation queue, pending appeals and the settings row. Every write goes
through a server route that holds the service-role key and checks the
caller's role; the browser only ever calls the four client-callable
functions.

## Run it

#1 - Start the local database from the repository root.

    supabase start
    supabase db reset

Expected: the migration and the SQL seed apply; `supabase status` prints the
URL and keys.

#2 - Build the kit so `dist/` exists, then install this app.

    npm run build
    cd examples/admin && npm install

Expected: no errors; `node_modules/modqueue` links to the repository root.

#3 - Copy `.env.example` to `.env.local` and paste the anon and service-role
keys from `supabase status`.

#4 - Seed the fixture accounts and queue rows.

    npm run seed

Expected: `seeded: 8 users, N open cases` and the two sign-in addresses.
Every fixture account uses `SEED_PASSWORD` (default `modqueue-seed`, the same password the SQL seed sets).

#5 - Start the app and sign in.

    npm run dev

Open http://127.0.0.1:3100/login as `moderator@example.com` (moderator) or
`admin@example.com` (admin). Expected: the queue lists the seeded cases.
The `dev` and `start` scripts read the port with `${PORT:-3100}`, a POSIX
shell expansion; on Windows run them from a POSIX shell such as Git Bash.

#6 - Run the three end-to-end checks in `tests/` (Chromium; install it once
with `npx playwright install chromium`).

    npm run test:e2e

Expected: all three pass.

- `tests/queue-action`: a moderator claims a case and removes the content
  with a strike; then a stale tab's action is refused with `case_not_open`
  and the code is shown inline.
- `tests/appeal-overturn`: a member files an appeal through `file_appeal`
  and the admin overturns it, which revokes the strike and restores the
  content.

The tests act only on rows they create, prefixed `e2e-`, plus one throwaway
member the appeal test creates and deletes.

## Pages

| Route | What it does |
|---|---|
| `/login` | Email and password sign-in |
| `/admin/moderation` | Queue with open, claimed, mine and decided views; claim, release and admin take-over; the action form; reach breakdown and event log per case; `?case=<id>` opens one case; `?owner=<id>` is an admin-only filter |
| `/admin/moderation/appeals` | Pending appeals, uphold or overturn with a note |
| `/admin/moderation/settings` | Automation level with the full_auto acknowledgement, thresholds, keyword lists |
| `/report` | A member files a report through `file_report` |

## Routes

Every POST and PUT handler parses its body, calls the kit, and on failure
returns `{ error: { code, message } }` with the status from
`ERROR_HTTP_STATUS`. The GET handlers do the same without a body.

| Method and path | Kit call |
|---|---|
| `GET /api/admin/moderation?filter=&owner=` | `loadQueue` |
| `POST /api/admin/moderation/claim` | `claimCase`, `releaseCase`, `takeOverCase` |
| `POST /api/admin/moderation/action` | `applyModerationAction` |
| `GET /api/admin/moderation/appeals` | `listPendingAppeals` |
| `POST /api/admin/moderation/appeals/:id/resolve` | `resolveAppeal` |
| `GET` and `PUT /api/admin/moderation/settings` | `loadSettings`, `saveSettings` |
