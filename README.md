# Konnekt

A board where teams/projects and sponsors post signals and find each other.
Static frontend (no build step) + Supabase for auth, data, and realtime updates.

## Stack

- **Frontend:** plain HTML/CSS/JS (`index.html`, `style.css`, `app.js`) — no framework, no bundler.
- **Backend:** [Supabase](https://supabase.com) — Postgres database, email/password auth, row-level security, realtime.
- **Hosting:** [Vercel](https://vercel.com) — serves the static files, zero config.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → New project. Pick any name/region, save the database password somewhere.
2. Once it's provisioned, open **SQL Editor** → New query, paste the contents of `supabase/schema.sql`, and run it. This creates the `listings` table and the row-level security (RLS) policies that:
   - let anyone read the board,
   - only let signed-in users insert a listing as themselves,
   - only let the owner edit or delete their own listing.
3. Go to **Authentication → Providers** and make sure **Email** is enabled (it is by default).
   - Optional, for faster local testing: **Authentication → Settings** → turn off "Confirm email" so accounts are active immediately instead of requiring an email click-through. Turn it back on before you send this anywhere real.
4. Go to **Project Settings → API**. You'll need:
   - **Project URL**
   - **anon public** key (not the `service_role` key — never put that in frontend code)

## 2. Configure the app

Open `config.js` and paste in the two values from step 1.4:

```js
window.KONNEKT_CONFIG = {
  SUPABASE_URL: "https://your-project-ref.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-public-key"
};
```

The anon key is safe to commit and expose client-side — it's meant to be public. RLS policies in the database are what actually control access, not this key.

## 3. Run it locally

No build step needed. Any static file server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed local URL.

## 4. Push to GitHub

```bash
git init
git add .
git commit -m "Konnekt"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/konnekt.git
git push -u origin main
```

## 5. Deploy on Vercel

1. [vercel.com](https://vercel.com) → New Project → import the GitHub repo.
2. Framework preset: **Other** (it's a static site, no build command, no output directory needed).
3. Deploy. That's it — `config.js` ships with the repo so no environment variables are required on Vercel's side.

If you'd rather not commit real Supabase keys to a public repo, you can instead leave `config.js` with placeholders in git, add it to `.gitignore`, and use a Vercel build step to generate it from environment variables at build time — but since the anon key is meant to be public, committing it directly is the simpler and equally safe option for this project.

## How it's structured

- `index.html` — page markup: header/account area, hero, board, post form, auth modal.
- `style.css` — all styling.
- `app.js` — Supabase client setup, auth (sign up / sign in / sign out), loading and posting listings, realtime board updates, all UI wiring.
- `supabase/schema.sql` — the `listings` table and RLS policies. Re-run safely; uses `if not exists` / `create policy` guards.

## Notes on the data model

Each row in `listings` stores `user_id` (the poster's account), `poster_name` (their display name at signup, denormalized so the board doesn't need to query `auth.users`), and the listing fields (`type`, `name`, `category`, `tagline`, `description`, `budget_min`, `budget_max`, `contact`).

Deleting a listing is only possible for its owner — enforced both in the UI (the Remove button only renders for the owner) and, more importantly, in the database via the RLS delete policy. The UI check is a convenience; the RLS policy is the actual security boundary.
# Konnekt
