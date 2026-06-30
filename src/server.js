"use strict";
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const path    = require("path");
const fs      = require("fs");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── JSON file persistence ────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "../data/products.json");

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveProducts() {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify({ nextId, products }, null, 2));
  } catch (e) {
    console.error("Failed to save products:", e.message);
  }
}

function loadProducts() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      nextId   = data.nextId   || 1;
      products = data.products || [];
      // Reset transient status fields on load
      products.forEach(p => {
        p.status      = "Checking…";
        p.online      = false;
        p.lastChecked = null;
      });
      console.log(`Loaded ${products.length} products from disk`);
    }
  } catch (e) {
    console.error("Failed to load products:", e.message);
  }
}

// ─── In-memory store ──────────────────────────────────────────────────────────
let nextId   = 1;
const uid    = () => nextId++;
let products = []; // { id, name, retailer, url, productId, status, lastChecked, addedAt }
let alerts   = []; // { id, type, product, retailer, timestamp }

// Load saved products on startup
loadProducts();

// ─── Shared fetch with retry headers ─────────────────────────────────────────
const HEADERS = [
  {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
  },
  {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.5"
  },
  {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Accept": "text/html,application/xhtml+xml"
  }
];

async function fetchWithRetry(url, extraHeaders = {}) {
  for (const headers of HEADERS) {
    try {
      const res = await fetch(url, { headers: { ...headers, ...extraHeaders } });
      if (res.ok) return res;
    } catch {}
  }
  return null;
}

// ─── Retailer checkers (online availability only) ─────────────────────────────

// Target: online ship-to-home availability via RedSky
async function checkTarget(product) {
  try {
    const KEY = process.env.TARGET_KEY || "9f36aeafbe60771e321a7cc95a78140772ab3e96";
    const url = `https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1` +
      `?key=${KEY}&tcins=${product.productId}&zip=92056&state=CA&include_only_non_members=true`;

    const res = await fetchWithRetry(url, {
      "Origin":  "https://www.target.com",
      "Referer": "https://www.target.com/",
      "Accept":  "application/json"
    });

    // If blocked, fall back to scraping the product page
    if (!res) return await checkTargetPage(product);

    const data = await res.json();
    const item = data?.data?.product_summaries?.[0];
    if (!item) return await checkTargetPage(product);

    const shipping = item?.fulfillment?.shipping_options;
    const online   = shipping?.availability_status === "IN_STOCK" ||
                     (shipping?.available_to_promise_quantity ?? 0) > 0;
    const oos      = item?.fulfillment?.is_out_of_stock_in_all_online_locations;

    return {
      online: online && !oos,
      status: (online && !oos) ? "Available — add to cart" : "Out of stock"
    };
  } catch (e) {
    return await checkTargetPage(product);
  }
}

// Target page scrape fallback
async function checkTargetPage(product) {
  try {
    const res = await fetchWithRetry(`https://www.target.com/p/-/A-${product.productId}`, {
      "Referer": "https://www.target.com/"
    });
    if (!res) return { status: "Out of stock", online: false };
    const html = await res.text();
    if (html.includes('"availability":"InStock"') || html.includes("Add to cart") || html.includes("addToCartButton")) {
      return { online: true, status: "Available — add to cart" };
    }
    return { online: false, status: "Out of stock" };
  } catch {
    return { online: false, status: "Out of stock" };
  }
}

// Walmart: much less restrictive than Target
async function checkWalmart(product) {
  try {
    const url = `https://www.walmart.com/ip/${product.productId}`;
    const res = await fetchWithRetry(url);
    if (!res) return { online: false, status: "Out of stock" };

    const html = await res.text();

    // JSON-LD availability
    const jsonLdMatch = html.match(/"availability"\s*:\s*"([^"]+)"/);
    if (jsonLdMatch) {
      const online = jsonLdMatch[1].includes("InStock");
      return { online, status: online ? "Available — add to cart" : "Out of stock" };
    }

    // Fallback signals
    if (html.includes('"atc-btn"') || html.includes("Add to cart") || html.includes("add-to-cart")) {
      return { online: true, status: "Available — add to cart" };
    }
    return { online: false, status: "Out of stock" };
  } catch {
    return { online: false, status: "Out of stock" };
  }
}

// Pokémon Center: detect queue-it waiting room OR standard in-stock
async function checkPokemonCenter(product) {
  try {
    const res = await fetchWithRetry(product.url);
    if (!res) return { online: false, status: "Out of stock" };

    const html = await res.text();

    // Queue-it signals — queue is live, act now
    const queueSignals = [
      "queue-it.net", "waitingroom.pokemoncenter.com", "queueit",
      "Join Queue", "Get in Line", "join-queue", "queue-it-connector"
    ];
    if (queueSignals.some(s => html.includes(s))) {
      return { online: true, status: "Queue is live!", queueActive: true };
    }

    // Standard in-stock signals
    if (html.includes('"availability":"http://schema.org/InStock"') ||
        html.includes("Add to Cart") || html.includes("add-to-cart")) {
      return { online: true, status: "Available — add to cart", queueActive: false };
    }

    return { online: false, status: "Out of stock", queueActive: false };
  } catch {
    return { online: false, status: "Out of stock", queueActive: false };
  }
}

async function checkProduct(product) {
  switch (product.retailer) {
    case "Target":         return checkTarget(product);
    case "Walmart":        return checkWalmart(product);
    case "Pokemon Center": return checkPokemonCenter(product);
    default:               return { status: "Unknown retailer", online: false };
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────
let pollingActive  = false;
let pollIntervalId = null;

async function pollAll() {
  if (!products.length) return;
  console.log(`[${new Date().toISOString()}] Polling ${products.length} products…`);
  for (const product of products) {
    const result = await checkProduct(product);
    const prev   = product.status;
    product.status      = result.status;
    product.online      = result.online;
    product.lastChecked = new Date().toISOString();

    // Fire alert on restock or queue going live
    const wasInStock = prev === "In stock online" || prev === "Queue is live!";
    const nowInStock = result.status === "In stock online" || result.status === "Queue is live!";

    if (!wasInStock && nowInStock) {
      const type  = result.queueActive ? "queue" : "restock";
      const alert = {
        id:        uid(),
        type,
        product:   product.name,
        retailer:  product.retailer,
        url:       product.url,
        timestamp: new Date().toISOString()
      };
      alerts.unshift(alert);
      if (alerts.length > 200) alerts.pop();
      console.log(`  🎉 ${type.toUpperCase()}: ${product.name} at ${product.retailer}`);
    }

    // Fire sold-out alert
    if ((prev === "In stock online" || prev === "Queue is live!") && !nowInStock) {
      alerts.unshift({
        id:        uid(),
        type:      "soldout",
        product:   product.name,
        retailer:  product.retailer,
        url:       product.url,
        timestamp: new Date().toISOString()
      });
    }
  }
}

let huntMode = false; // false = monitor (25-45s), true = hunt (15-20s)

function randomInterval() {
  return huntMode
    ? Math.floor(Math.random() * (20000 - 15000 + 1)) + 15000  // Hunt: 15–20s
    : Math.floor(Math.random() * (45000 - 25000 + 1)) + 25000; // Monitor: 25–45s
}

function scheduleNextPoll() {
  if (!pollingActive) return;
  const interval = randomInterval();
  const mode = huntMode ? "HUNT" : "MONITOR";
  console.log(`[${mode}] Next poll in ${(interval/1000).toFixed(1)}s`);
  pollIntervalId = setTimeout(async () => {
    await pollAll();
    scheduleNextPoll();
  }, interval);
}

function startPolling() {
  if (pollingActive) return;
  pollingActive = true;
  pollAll();
  scheduleNextPoll();
  console.log(`Polling STARTED — ${huntMode ? "HUNT mode (15–20s)" : "MONITOR mode (25–45s)"}`);
}

function stopPolling() {
  if (!pollingActive) return;
  pollingActive = false;
  if (pollIntervalId) { clearTimeout(pollIntervalId); pollIntervalId = null; }
  console.log("Polling PAUSED");
}

// ─── URL parser ───────────────────────────────────────────────────────────────
async function parseURL(url) {
  try {
    const u = new URL(url);

    // Target: extract TCIN from /A-XXXXXXXX
    if (u.hostname.includes("target.com")) {
      const match = u.pathname.match(/\/A-(\d+)/i);
      return match
        ? { retailer: "Target", productId: match[1] }
        : { retailer: "Target", productId: null, error: "Could not find TCIN in URL. Make sure it's a Target product page URL." };
    }

    // Walmart: extract item ID from /ip/name/XXXXXXX or /ip/XXXXXXX
    if (u.hostname.includes("walmart.com")) {
      const match = u.pathname.match(/\/ip\/(?:[^/]+\/)?(\d+)/);
      return match
        ? { retailer: "Walmart", productId: match[1] }
        : { retailer: "Walmart", productId: null, error: "Could not find product ID in URL." };
    }

    // Pokémon Center
    if (u.hostname.includes("pokemoncenter.com")) {
      return { retailer: "Pokemon Center", productId: null }; // uses full URL
    }

    return { retailer: null, productId: null, error: "Only Target, Walmart, and Pokémon Center URLs are supported." };
  } catch {
    return { retailer: null, productId: null, error: "Invalid URL." };
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/api/products", (req, res) => res.json(products));

app.post("/api/products", async (req, res) => {
  const { url, name } = req.body;
  if (!url || !name) return res.status(400).json({ error: "url and name are required" });

  const parsed = await parseURL(url);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!parsed.retailer) return res.status(400).json({ error: "Unsupported retailer" });

  const product = {
    id:          uid(),
    name:        name.trim(),
    retailer:    parsed.retailer,
    productId:   parsed.productId,
    url:         url.trim(),
    status:      "Checking…",
    online:      false,
    lastChecked: null,
    addedAt:     new Date().toISOString()
  };
  products.push(product);
  saveProducts();

  // Check immediately in background
  setTimeout(async () => {
    const result = await checkProduct(product);
    product.status      = result.status;
    product.online      = result.online;
    product.lastChecked = new Date().toISOString();
  }, 500);

  res.status(201).json(product);
});

app.delete("/api/products/:id", (req, res) => {
  const idx = products.findIndex(p => p.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  products.splice(idx, 1);
  saveProducts();
  res.json({ ok: true });
});

app.get("/api/alerts", (req, res) => {
  const { type } = req.query;
  res.json(type && type !== "all" ? alerts.filter(a => a.type === type) : alerts);
});

app.get("/api/stats", (req, res) => {
  const today = new Date().toDateString();
  res.json({
    total:    products.length,
    inStock:  products.filter(p => p.status === "In stock online").length,
    restocks: alerts.filter(a => a.type === "restock" && new Date(a.timestamp).toDateString() === today).length,
    polling:  pollingActive,
    huntMode
  });
});

app.get("/api/polling",        (req, res) => res.json({ active: pollingActive, huntMode }));
app.post("/api/polling/start", (req, res) => { startPolling(); res.json({ active: true, huntMode }); });
app.post("/api/polling/pause", (req, res) => { stopPolling();  res.json({ active: false, huntMode }); });
app.post("/api/polling/hunt",  (req, res) => {
  huntMode = true;
  // Restart polling with new interval if already active
  if (pollingActive) { clearTimeout(pollIntervalId); scheduleNextPoll(); }
  console.log("Switched to HUNT mode (15–20s)");
  res.json({ active: pollingActive, huntMode });
});
app.post("/api/polling/monitor", (req, res) => {
  huntMode = false;
  if (pollingActive) { clearTimeout(pollIntervalId); scheduleNextPoll(); }
  console.log("Switched to MONITOR mode (25–45s)");
  res.json({ active: pollingActive, huntMode });
});
app.post("/api/poll",          async (req, res) => { await pollAll(); res.json({ ok: true }); });

// Debug: raw check for a single product
app.get("/api/debug/:id", async (req, res) => {
  const product = products.find(p => p.id === Number(req.params.id));
  if (!product) return res.status(404).json({ error: "Not found" });
  const result = await checkProduct(product);
  res.json({ product, result });
});

app.listen(PORT, () => {
  console.log(`PokéTrack v3 running on port ${PORT}`);
  console.log(`Retailers: Target, Walmart, Pokémon Center (online stock)`);
});
