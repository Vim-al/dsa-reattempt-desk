# The Reattempt Desk · DSA Tracker

A spaced-repetition tracker for the NeetCode 150, built around one rule from your prep plan:

> **Any problem you can't solve in 25 minutes (unassisted) resurfaces in 3 days.**

The point isn't counting solved problems — it's making sure the ones that beat you come back until they don't.

---

## Run it right now (zero setup)

Just open `index.html` in a browser. It works immediately on local browser storage — pre-loaded with all 150 problems by pattern. Log attempts, watch the due-queue fill. Your data saves in that browser.

The only limit of local mode: it's per-browser. To sync phone + laptop, do the 5-minute Supabase step below.

---

## Sync across devices (Supabase — ~5 min)

You said you wanted it saved properly and live. Here's the whole setup.

### 1. Create a Supabase project
- Go to [supabase.com](https://supabase.com) → sign in → **New project**.
- Pick any name, set a DB password (you won't need it for this), choose the region closest to you.
- Wait ~2 min for it to provision.

### 2. Create the table
In the project, open **SQL Editor** → **New query** → paste this → **Run**:

```sql
create table attempts (
  problem   text primary key,
  done      boolean default false,
  gate      text,
  conf      int,
  time      int,
  note      text,
  last_at   date,
  due_at    date,
  attempts  int default 1
);

-- Row Level Security on, with open policy (single-user personal tracker).
alter table attempts enable row level security;
create policy "anon full access" on attempts
  for all using (true) with check (true);
```

> This open policy is fine for a personal single-user tracker. If you ever make the repo public AND want the data private, swap to Supabase Auth later — but for now this is the simplest thing that works.

### 3. Grab your two keys
- **Project Settings** (gear icon) → **API**.
- Copy the **Project URL** and the **anon / public** key.

### 4. Paste them into `config.js`
```js
window.TRACKER_CONFIG = {
  SUPABASE_URL:  "https://YOURPROJECT.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi....your-anon-key"
};
```

Reopen `index.html`. The badge top-right flips from **Local** to **Synced**, and the yellow banner disappears. Done — your data now lives in cloud Postgres and syncs anywhere you open this page.

> The anon key is safe to commit publicly when RLS is on — that's exactly what it's designed for.

---

## Deploy it live (GitHub Pages — ~3 min)

So you can open it from your phone at 7:30am without your laptop.

1. Create a repo, e.g. `dsa-reattempt-desk`.
2. Push these files (see structure below).
3. Repo **Settings** → **Pages** → Source: `main` branch, `/root` → **Save**.
4. Wait ~1 min. Your tracker is live at `https://YOURNAME.github.io/dsa-reattempt-desk/`.

Bookmark it on your phone's home screen. That's your morning open.

---

## Repo structure

```
dsa-reattempt-desk/
├── index.html        # the app (UI)
├── app.js            # logic: scheduling engine, sync, rendering
├── neetcode150.js    # the 150 problems, by pattern
├── config.js         # your Supabase keys (or blank for local)
├── README.md
└── solutions/        # ← your actual solution code goes here
    ├── arrays-hashing/
    │   ├── two-sum.py
    │   └── ...
    ├── two-pointers/
    └── ...
```

**Keep your solution code in `solutions/`** and commit every problem you solve. That gives you the green contribution graph recruiters glance at, and a public "build in public" trail — both flagged in your plan. The tracker measures *recall*; the `solutions/` folder is the *proof of work*.

---

## How the re-attempt engine works

When you log an attempt, you record two things: **did you pass the 25-min gate** (unassisted), and **did the pattern click** (confidence 1–5).

- **Missed the gate** → `due_at = today + 3 days`. It shows up in the red **Re-attempt queue** at the top, sorted by how overdue it is. This is the queue you clear first, every session.
- **Passed** → cleared, with a light spaced check scheduled +14 days.
- **25-min gate pass rate** (the second metric) is your real Gate-1 readiness signal — the plan's checkpoint is "solve mediums in ~30 min unassisted." Watch this climb. If it sits below 70% after a dozen logged problems, the metric turns amber — that's your cue to slow down, not push to new topics.

Difficulty dots: 🟢 Easy · 🟡 Medium · 🔴 Hard.

---

## Backup

**Export JSON** anytime (bottom controls) for a local backup. **Import JSON** to restore or move between setups. Even in Supabase mode, a local mirror is always kept, so you never lose data if the network drops mid-session.
