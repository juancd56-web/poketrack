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

## Notes

- **Data is in-memory** — restarting the server clears tracked products. To persist data, swap the in-memory arrays in `server.js` for a SQLite file or a free Postgres add-on on Render.
- **Render free tier** spins down after 15 min of inactivity. Use [UptimeRobot](https://uptimerobot.com) (free) to ping your URL every 5 minutes and keep it awake.
- The Target and Best Buy pollers extract product IDs from URLs. Some products require a resolved TCIN (Target) or BB ID (Best Buy) — if a product stays on "Checking…", verify the URL format matches the examples in `server.js`.

## Local development

```bash
npm install
npm run dev
# Open http://localhost:3000
```
