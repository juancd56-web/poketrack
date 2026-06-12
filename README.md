# PokéTrack — Restock Tracker

Monitors Target & Best Buy for Pokémon TCG restocks. Polls every 3 minutes and sends browser push notifications when stock changes.

## Deploy to Render (free, ~5 minutes)

### 1. Push to GitHub

```bash
cd poketrack
git init
git add .
git commit -m "Initial commit"
```

Create a new repo at https://github.com/new, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/poketrack.git
git branch -M main
git push -u origin main
```

### 2. Deploy on Render

1. Go to https://render.com and sign up (free, no credit card)
2. Click **New → Web Service**
3. Connect your GitHub account and select the `poketrack` repo
4. Render will auto-detect `render.yaml` — just click **Deploy**
5. Wait ~2 minutes for the build to finish
6. Your app is live at `https://poketrack-XXXX.onrender.com`

### 3. Open and use

- Open the Render URL in your browser
- Click **Enable** on the notification banner
- Go to **Search & add** and paste a Target or Best Buy product URL
- Stock is checked every 3 minutes automatically

---

## How it works

| Component | What it does |
|-----------|-------------|
| `src/server.js` | Express backend — serves the frontend, exposes `/api/*` routes, polls retailers on a cron |
| `public/index.html` | Frontend — dashboard, alerts history, add products |
| `render.yaml` | Render deployment config |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/products` | All tracked products |
| POST | `/api/products/url` | Add by retailer URL |
| POST | `/api/products/upc` | Add by UPC + retailer |
| PATCH | `/api/products/:id/watch` | Toggle watch alert |
| DELETE | `/api/products/:id` | Remove product |
| GET | `/api/alerts` | Alert history (`?type=restock\|low\|soldout`) |
| GET | `/api/stats` | Summary counts |
| POST | `/api/poll` | Trigger a manual poll |

## Configuration — Environment Variables

Set these before running (locally via `.env` or in Render's **Environment** tab):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `TARGET_STORE_ID` | `1234` | Your nearest Target store ID. Find it in the `pricing_store_id` param of any Target RedSky API request on their site, or from the Target store locator. |
| `BESTBUY_ZIP` | `10001` | ZIP code for Best Buy availability lookups. Use your own ZIP for accurate local results. |
| `BESTBUY_STORE_ID` | `498` | Your nearest Best Buy store ID. Find it on the Best Buy store locator page — it's in the URL when you select a store. |

**Example `.env` for local dev:**
```
TARGET_STORE_ID=2352
BESTBUY_ZIP=92056
BESTBUY_STORE_ID=1055
```

---



- **Data is persisted in SQLite** at `/data/poketrack.db` on Render's attached disk. Products and alert history survive restarts and redeploys automatically. Locally the DB is created as `poketrack.db` in the project root.
- **Render disk requires the Starter plan** ($7/mo). The free tier does not support persistent disks — on free, the server still works but data resets on each restart. The `render.yaml` is pre-configured to attach a 1 GB disk at `/data`.
- **Render free tier** spins down after 15 min of inactivity. Use [UptimeRobot](https://uptimerobot.com) (free) to ping your URL every 5 minutes and keep it awake.
- The Target and Best Buy pollers extract product IDs from URLs. If a product stays on "Checking…", verify the URL format matches the examples in `server.js`.

## Local development

```bash
npm install
npm run dev
# Open http://localhost:3000
```
