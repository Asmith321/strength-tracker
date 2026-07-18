# Iron Log — standalone deploy

This is your adaptive strength tracker as a normal, standalone web app — no
Claude chat required. Data is stored in a free Supabase database so it's the
same on your phone and any other device you open it from.

## What changed from the Claude artifact version
- `window.storage` → replaced with `src/storage.js`, backed by a Supabase table (`kv_store`)
- The direct browser call to Anthropic → replaced with `api/coach.js`, a serverless
  function that holds your Anthropic API key server-side (a real API key must never
  live in frontend code — anyone could read it out of the page source otherwise)

Everything else (the engine, the UI, the CSS) is untouched.

## 1. Create a free Supabase project
1. Go to https://supabase.com → New project (free tier is plenty for this).
2. Once it's created, open **SQL Editor** → New query, paste the contents of
   `supabase-schema.sql`, and run it. This creates the `kv_store` table and a
   Row Level Security policy that scopes every row to its owner
   (`auth.uid() = user_id`). *If you already ran the old open-access version of
   this file, use the migration block at the bottom of `supabase-schema.sql`
   instead — it adds `user_id`, claims your existing rows, and locks the policy
   down without dropping data.*
3. Create your account: **Authentication → Users → Add user**, enter your email
   and a password, and enable **Auto Confirm** so you can sign in immediately.
   (This is a single-user app — you make one account, your own.)
4. Go to **Settings → API** and copy the **Project URL** and **anon public key**.

## 2. Configure environment variables
```
cp .env.example .env
```
Paste your Supabase URL and anon key into `.env`.

**Note on privacy / access control:** the app now requires an email/password
login (Supabase Auth). The anon key still ships in the browser bundle — that's
by design — but it is **no longer sufficient to read or write any data**: the
RLS policy only allows access to rows where `auth.uid() = user_id`, so a signed-in
session is required and each account can only see its own rows. If you'd rather
not allow anyone to self-register on your public URL, turn off open sign-ups in
**Authentication → Providers → Email** (you already created your account in step
3, so the in-app "Create one" link is just a convenience).

**Back up your data:** Settings → **Export my data** downloads your full program +
history as a JSON file. The free tier has no automated backups, so do this
periodically (see *Known limitations* below).

## 3. Run it locally
```
npm install
npm run dev
```
Opens at http://localhost:5173.

## 4. Deploy (Vercel — free)
1. Push this folder to a new GitHub repo.
2. Go to https://vercel.com → New Project → import that repo.
3. Vercel auto-detects Vite. Before deploying, add environment variables in
   the Vercel project settings:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `ANTHROPIC_API_KEY` — your own key from https://console.anthropic.com
     (used only by `api/coach.js`, server-side, never exposed to the browser)
4. Deploy. Vercel gives you a URL like `iron-log.vercel.app`.

## 5. Install it on your phone
Open the Vercel URL in your phone's browser, then:
- **iOS Safari:** Share → "Add to Home Screen"
- **Android Chrome:** menu (⋮) → "Add to Home screen" / "Install app"

It'll open full-screen like a native app and persist data to Supabase, so
logging a session on your phone updates the same data everywhere.

## Notes
- The "coach" feature is optional — if `ANTHROPIC_API_KEY` isn't set, or the
  `/api/coach` call fails for any reason, the app already falls back
  gracefully to "Coach offline — deterministic engine applied." The
  deterministic sport-science engine (e1RM, volume periodization, block
  transitions) works completely independently of the coach call.
- If you skip Vercel and just want local-network use, `npm run build` +
  `npm run preview`, or host `dist/` on Netlify/any static host — you'd just
  lose the coach feature unless that host also supports serverless functions.

## Known limitations
- **No backup/recovery on Supabase's free tier.** Point-in-time recovery
  (PITR) and automated daily backups are paid add-ons/plan features on
  Supabase, not included on the free tier this app is set up to use. If the
  `kv_store` table is dropped, the project is deleted, or a bad write
  overwrites your data outside the app's own reset flow, there is no vendor
  backup to restore from. (Verify current terms on Supabase's pricing page —
  this can change.) The in-app "Reset everything" action in Settings is
  gated behind a typed `DELETE` confirmation specifically because of this —
  there's no safety net underneath it. If this matters to you, consider
  periodically exporting `kv_store` (Supabase Table Editor → export) or
  upgrading to a plan with backups.
