# Stuff to Investigate

An internal map of scientific questions, sub-questions, and findings, including
projects we have considered but are not actively pursuing.

Everyone on the team sees and edits the same map. Access requires an account,
and accounts must be approved by an admin.

## How it is built

| Piece | Choice | Why |
|---|---|---|
| Frontend | Plain HTML/CSS/JavaScript modules, no build step | Easy to read, deploys as static files anywhere |
| Backend | [Supabase](https://supabase.com) free tier: Postgres + Auth + Realtime | Login, sessions, and security rules without writing a server |
| Security | Row Level Security policies in Postgres | Even direct API calls see nothing unless the caller is an approved user |
| Hosting | GitHub Pages from this (public) repo | Free; the code is public, the data is not |
| Backups | Per-node history table, trash instead of delete, nightly snapshot into a **private** repo | The free tier has no automatic backups |

### Files

    index.html                 app shell (sign-in, pending, map/trash/admin screens)
    css/app.css
    js/config.js               Supabase URL + anon key (public, safe to commit)
    js/db.js                   shared Supabase client
    js/auth.js                 sign in / up / out / password reset
    js/store.js                in-memory data, optimistic writes, realtime sync
    js/tree.js                 the editable list view
    js/panels.js               trash, history dialog, admin user management
    js/detail.js               side panel: title, type, Markdown notes with preview
    supabase/migrations/       SQL to create tables, triggers, and policies
    backup/snapshot.yml        GitHub Actions workflow for the private backup repo

## One-time setup

### 1. Database

In the Supabase dashboard open **SQL Editor → New query**, paste the contents of
each file in `supabase/migrations/` **in numeric order**, and run it:

- `0001_init.sql` — tables, triggers, and security policies. The email listed
  under `bootstrap_admins` becomes an approved admin automatically on signup.
- `0002_node_body.sql` — adds the long-form Markdown `body` column.

Each migration is safe to run once. Keep a note of which have been applied.

### 2. Auth settings

**Authentication → Sign In / Providers → Email**: turn **Confirm email** off.
Admin approval is the gate, and the free tier's built-in mailer is limited to a
few messages per hour, which would otherwise block signups.

**Authentication → URL Configuration**: set *Site URL* to
`https://julistanley.github.io/stuff-to-investigate/` and add that URL plus
`http://localhost:8765` to *Redirect URLs*. Password-reset links come back to
these addresses.

### 3. Frontend configuration

Copy the **Project URL** and **anon / publishable key** from
**Project Settings → API** into `js/config.js`. Both are public by design.

### 4. Hosting

Code: https://github.com/julistanley/stuff-to-investigate (public).
Live app: https://julistanley.github.io/stuff-to-investigate/ — GitHub Pages
deploys the `main` branch root on every push.

### 5. Backups (private repo)

The private repository https://github.com/julistanley/stuff-to-investigate-backups
holds `.github/workflows/snapshot.yml` (a copy of `backup/snapshot.yml` here).
In that repo's **Settings → Secrets and variables → Actions** add:

- `SUPABASE_URL` — the project URL
- `SUPABASE_SERVICE_ROLE_KEY` — **Project Settings → API → service_role**.
  This key bypasses all security rules. It belongs only in GitHub's encrypted
  secrets, never in this repo or the frontend.

The workflow runs nightly, commits `snapshots/*.json` plus a readable
`outline.md` when anything changed, and doubles as the keep-alive ping that
stops the free Supabase project from pausing after a week of inactivity.

## Running locally

    python3 -m http.server 8765

then visit http://localhost:8765. The page uses ES modules, so it must be
served over HTTP rather than opened as a file.

## Data model

- **nodes**: `text` is the one-line title; `body` is long-form Markdown.
  `parent_id` (null = top level) and a fractional `position` give the
  hierarchy and ordering. `kind` is question / finding / note. `deleted_at`
  marks the top of a trashed subtree.
- **node_history**: written by a trigger on every change, holds the previous
  version of the row. The History button on a node reads from here.
- **profiles**: one per login; `role` admin/editor and `status`
  pending/approved/rejected. Created by a trigger on signup.
- **app_settings**: JSON key/value; currently just `bootstrap_admins`.

Cross-links between distant questions (a true network rather than a tree) are
planned as a separate `edges` table.
