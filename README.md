# 🎴 Pokemon Auctions

Daily eBay auction tracker for Pokemon (and other graded) cards. You build searches on eBay's site with whatever filters you want, paste the URL into the local UI, and every morning at 8am it scrapes those searches and emails you a digest of everything ending in the next 24 hours.

## How it works

1. You craft a search on eBay with filters (auction-only, grade, condition, price range, etc.) and copy the URL.
2. Paste the URL into the local web UI (http://localhost:3737) with a friendly name.
3. A `launchd` agent runs `src/run-daily.js` every morning at 08:00. It scrapes each saved search, upserts the results into SQLite, and emails you a digest via Resend.
4. You can also hit "Run now" or "Email digest" from the UI any time.

Scraping uses `curl` (Node's `fetch` is blocked by eBay's TLS fingerprinting). It warms up cookies from the homepage first, then issues each search with `Referer: ebay.com` to look like an organic navigation.

## Setup

### 1. Install dependencies

```sh
cd /Users/danidin/Desktop/pokemon
npm install --cache /tmp/npm-cache-pokemon
```

(The `--cache` flag is only needed if your `~/.npm` cache has permission issues.)

### 2. Get a Resend API key

- Go to https://resend.com → sign up → API keys → "Create API Key"
- For testing, you can send `from: onboarding@resend.dev` to your own verified email
- For production, verify a domain you own under Resend's "Domains" tab

### 3. Configure `.env`

```sh
cp .env.example .env
```

Then edit `.env`:
```
RESEND_API_KEY=re_xxxxxxxxxxxx
DIGEST_TO_EMAIL=dani.smrn@gmail.com
DIGEST_FROM_EMAIL=onboarding@resend.dev
PORT=3737
```

### 4. Start the server

```sh
npm start
```

Visit http://localhost:3737. Add a saved search:

- **Name**: `Charizard Base Set Shadowless`
- **URL**: Open eBay → search → apply filters (Auction-only, Graded, etc.) → copy URL from address bar

### 5. Install the daily cron

```sh
mkdir -p logs
cp launchd/com.danidin.pokemon-auctions.daily.plist ~/Library/LaunchAgents/
cp launchd/com.danidin.pokemon-auctions.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.danidin.pokemon-auctions.daily.plist
launchctl load ~/Library/LaunchAgents/com.danidin.pokemon-auctions.server.plist
```

- `daily` runs `src/run-daily.js` every morning at 08:00
- `server` keeps the web UI alive at http://localhost:3737 (restarts if it crashes, runs on login)

To check status / logs:
```sh
launchctl list | grep pokemon
tail -f logs/daily.log
tail -f logs/server.log
```

To trigger the daily job manually:
```sh
launchctl start com.danidin.pokemon-auctions.daily
```

To uninstall:
```sh
launchctl unload ~/Library/LaunchAgents/com.danidin.pokemon-auctions.daily.plist
launchctl unload ~/Library/LaunchAgents/com.danidin.pokemon-auctions.server.plist
rm ~/Library/LaunchAgents/com.danidin.pokemon-auctions.*.plist
```

## Deploying to Railway

For sharing the tool with someone else, this can be deployed to Railway in about 10 minutes.

### One-time setup

1. **Push the project to a GitHub repo** (private is fine).

2. **Sign up at https://railway.app** with your GitHub account.

3. **Create a new project** → "Deploy from GitHub repo" → pick this repo.
   Railway will detect the [Dockerfile](Dockerfile) and start building.

4. **Add a persistent volume**:
   - Project → your service → "Settings" → "Volumes" → "+ New Volume"
   - Mount path: `/data`
   - This keeps the SQLite DB and eBay session cookies across deploys.

5. **Set environment variables** (Settings → "Variables"):
   ```
   AUTH_PASSWORD=<a long random password>
   AUTH_USERNAME=admin
   RESEND_API_KEY=re_xxxxxxxxxxxx
   DIGEST_TO_EMAIL=dani.smrn@gmail.com
   DIGEST_FROM_EMAIL=onboarding@resend.dev
   CRON_TIMEZONE=Asia/Jerusalem
   ```
   `DB_PATH=/data/pokemon.db` and `DATA_DIR=/data` are already set in the Dockerfile.

6. **Generate a public domain**: Settings → "Networking" → "Generate Domain".
   You'll get something like `pokemon-auctions-production.up.railway.app`.

7. **Share with your friend**: send the URL + username + password. The browser will prompt them on first visit.

### After it's deployed

- The daily cron runs **inside the same container** at 08:00 Asia/Jerusalem (configurable via `CRON_TIMEZONE` and `CRON_SCHEDULE`).
- Logs: Project → Deployments → latest → "View Logs".
- To trigger a scrape manually: hit the "Run now" button in the UI, or call the `/api/run-now` endpoint.
- If eBay starts blocking Railway's IP: the cookie-jar warmup happens automatically; in worst case you'll see `bot-blocked` errors in logs. Solution is usually to wait an hour or rotate to a different Railway region.

### Cost

Railway gives you ~$5 of free credit / month on the Hobby plan, which is enough for this tiny service running 24/7. The Dockerfile is small, the DB is local SQLite (free), and there's no Postgres add-on.

### Upgrading to email-based auth later

When you want to swap Basic Auth for "magic link" email auth (so you can revoke access per-person), the change is local to `src/server.js`. The Basic Auth middleware can be replaced with a `passport-magic-link` or `next-auth`-style flow — won't touch the rest of the app.

## CLI usage

```sh
npm start                # run web UI
npm run scrape           # run scrape + email once (what cron does)
node src/run-daily.js --no-email   # scrape without emailing
```

## Tips for the eBay URLs

- Wrap the keyword in `"quotes"` for exact-match: `_nkw="charizard"+base+set`. Otherwise eBay broadens and you'll get related cards too.
- `LH_Auction=1` — auctions only
- `_dcat=183454` — Graded Cards category
- `_sop=1` — sort by ending soonest
- `Grade=10` — PSA 10 only
- Build the search visually on eBay, apply all filters, then copy the URL.

## Files

```
src/
  db.js          - SQLite schema, queries
  scraper.js     - curl-based eBay fetch + cheerio parser
  runner.js      - run all active searches
  emailer.js     - Resend digest email
  server.js      - Express REST API + static UI
  run-daily.js   - cron entry point (scrape + email)
public/
  index.html, app.js, style.css  - the UI
launchd/
  *.plist        - macOS launchd agents
data.db          - SQLite database (gitignored)
.ebay-cookies.txt - cookie jar for eBay sessions (gitignored)
```
