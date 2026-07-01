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
   `supabase-schema.sql`, and run it. This creates the one table the app needs.
3. Go to **Settings → API** and copy the **Project URL** and **anon public key**.

## 2. Configure environment variables
```
cp .env.example .env
```
Paste your Supabase URL and anon key into `.env`.

**Note on privacy:** the anon key is public by design (it ships in the browser
bundle) and the RLS policy in `supabase-schema.sql` gives it full read/write
access to the `kv_store` table only. That's fine for a personal fitness app —
nobody else will guess your project URL — but it isn't a private, access-controlled
system. If you want real per-user auth later, Supabase has built-in auth you can
layer on top; ask me and I can wire it in.

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
