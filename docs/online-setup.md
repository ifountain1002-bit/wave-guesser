# Turning on the worldwide leaderboard and shared photo reports

Beach Guesser is a static site with no server of its own, so the two online
features need somewhere to keep data. This sets that up on Supabase's free
tier. It takes about five minutes, and the game works perfectly well without
it — skip this entirely and scores stay on each player's own device, while a
reported photo is hidden just for the person who reported it.

## 1. Create the project

1. Sign up at [supabase.com](https://supabase.com) and create a project.
2. Open **Project Settings → API** and copy the **Project URL** and the
   **anon / public** key.

## 2. Create the tables

Open the **SQL Editor** and run this once.

```sql
-- Finished games.
create table public.scores (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 1 and 20),
  score       integer not null check (score >= 0 and score <= 50000),
  rounds      smallint not null check (rounds in (3, 5, 10)),
  created_at  timestamptz not null default now()
);

-- Photos players have flagged as wrong, irrelevant, or too much of a clue.
create table public.photo_reports (
  id          bigint generated always as identity primary key,
  file_title  text not null check (char_length(file_title) between 1 and 300),
  beach       text check (char_length(beach) <= 120),
  reason      text not null check (reason in
                ('not_this_beach', 'gives_it_away', 'not_a_beach', 'bad_image')),
  created_at  timestamptz not null default now()
);

create index on public.scores (rounds, score desc);
create index on public.photo_reports (file_title);
```

The `check` constraints are the part doing real work: they are enforced by the
database, so a score outside 0–50,000, an over-long name, or a made-up report
reason is rejected no matter what the browser sends.

## 3. Let anonymous visitors read and write

```sql
alter table public.scores        enable row level security;
alter table public.photo_reports enable row level security;

create policy "anyone can read scores"    on public.scores
  for select to anon using (true);
create policy "anyone can post a score"   on public.scores
  for insert to anon with check (true);

create policy "anyone can file a report"  on public.photo_reports
  for insert to anon with check (true);
-- Deliberately no select policy on photo_reports: individual reports stay
-- private, and only the aggregate below is readable.
```

## 4. Expose the block list

A photo is hidden for everybody once enough separate people report it. Change
the `>= 3` to match `reportThreshold` in `assets/js/config.js` if you adjust it.

```sql
create view public.blocked_photos
with (security_invoker = off) as
  select file_title, count(*) as reports
  from public.photo_reports
  group by file_title
  having count(*) >= 3;

grant select on public.blocked_photos to anon;
```

`security_invoker = off` lets the view read the reports table that `anon`
itself cannot read, so the counts work while individual reports stay private.

## 5. Point the game at it

Edit `assets/js/config.js`:

```js
const BEACH_GUESSER_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "eyJhbGciOi...",
  reportThreshold: 3,
  leaderboardSize: 20
};
```

Then rebuild the single-file version and deploy:

```bash
python3 tools/build-single-file.py
git commit -am "Point at the Supabase project" && git push
```

## What this cannot do

Be clear-eyed about this before you treat the leaderboard as authoritative.

**Scores are submitted by the browser, so they can be forged.** The anon key
is embedded in a public page — it has to be — and anyone who opens developer
tools can POST any score the constraints allow. The database caps a score at
50,000 and a name at 20 characters, which stops the board being destroyed, but
it cannot tell a real 24,000 from an invented one. That is inherent to a static
site with no server, not something a different free backend would fix.

If the leaderboard ever needs to be trustworthy, the change is to stop trusting
the client: run the rounds server-side, hand the browser a signed token per
game, and verify it on submit. That means a real backend and is a much larger
piece of work than this.

**There is no moderation queue.** Names go on the board as typed. They are
rendered as text, never as markup, so a name cannot inject anything into the
page — but nothing stops someone entering something offensive. If that becomes
a problem, delete the row in the Supabase table editor, and consider adding a
word filter to `cleanName()` in `assets/js/backend.js`.

**Three reports hide a photo from everyone.** That is deliberately a low bar,
since a bad photo hurts the game more than a missing one. It also means three
people could hide a perfectly good photo. Reports are kept with their reasons,
so you can review `photo_reports` and delete rows to bring a photo back.

**Rate limiting is not configured.** Supabase's free tier will absorb ordinary
use, but there is nothing here stopping someone scripting thousands of
submissions. If the project is going to be public and popular, put Cloudflare
Turnstile or a Supabase Edge Function in front of the inserts.
