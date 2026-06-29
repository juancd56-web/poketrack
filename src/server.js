"use strict";
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── In-memory store ──────────────────────────────────────────────────────────
let nextId   = 1;
const uid    = () => nextId++;
let products = []; // { id, name, retailer, url, productId, status, lastChecked, addedAt }
let alerts   = []; // { id, type, product, retailer, timestamp }

// ─── Retailer checkers (online availability only) ─────────────────────────────

// Target: online ship-to-home availability via RedSky
async function checkTarget(product) {
  try {
    const KEY = process.env.TARGET_KEY || "9f36aeafbe60771e321a7cc95a78140772ab3e96";
    const url = `https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1` +
      `?key=${KEY}&tcins=${product.productId}&zip=92056&state=CA&include_only_non_members=true`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://www.target.com",
        "Referer": "https://www.target.com/"
      }
    });
    if (!res.ok) return { status: "API blocked", online: false };

    const data = await res.json();
    const item = data?.data?.product_summaries?.[0];
    if (!item) return { status: "Not found", online: false };

    const shipping = item?.fulfillment?.shipping_options;
    const online   = shipping?.availability_status === "IN_STOCK" ||
                     (shipping?.available_to_promise_quantity ?? 0) > 0;
    const oos      = item?.fulfillment?.is_out_of_stock_in_all_online_locations;

    return {
      online:  online && !oos,
      status:  (online && !oos) ? "In stock online" : "Out of stock",
      detail:  shipping?.availability_status || null
    };
  } catch (e) {
    return { status: "Error", online: false, error: e.message };
  }
}

// Walmart: uses their internal product API — much less restrictive than Target
async function checkWalmart(product) {
  try {
    const url = `https://www.walmart.com/ip/${product.productId}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!res.ok) return { status: "API blocked", online: false };

    const html = await res.text();

    // Extract JSON-LD availability
    const jsonLdMatch = html.match(/"availability"\s*:\s*"([^"]+)"/);
    if (jsonLdMatch) {
      const avail  = jsonLdMatch[1];
      const online = avail.includes("InStock");
      return { online, status: online ? "In stock online" : "Out of stock", detail: avail };
    }

    // Fallback signals
    if (html.includes('"atc-btn"') || html.includes("Add to cart")) {
      return { online: true, status: "In stock online" };
    }
    if (html.includes("Out of stock") || html.includes("Currently unavailable")) {
      return { online: false, status: "Out of stock" };
    }

    return { online: false, status: "Unknown" };
  } catch (e) {
    return { status: "Error", online: false, error: e.message };
  }
}

// Pokémon Center: detect queue-it waiting room being active OR standard in-stock
async function checkPokemonCenter(product) {
  try {
    const res = await fetch(product.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!res.ok) return { status: "API blocked", online: false };

    const html = await res.text();

    // Queue-it signals — queue is live, act now
    const queueSignals = [
      "queue-it.net",
      "waitingroom.pokemoncenter.com",
      "queueit",
      "Join Queue",
      "Get in Line",
      "join-queue",
      "queue-it-connector"
    ];
    if (queueSignals.some(s => html.includes(s))) {
      return { online: true, status: "Queue is live!", queueActive: true };
    }

    // Standard in-stock signals
    if (html.includes('"availability":"http://schema.org/InStock"') ||
        html.includes("Add to Cart") || html.includes("add-to-cart")) {
      return { online: true, status: "In stock online", queueActive: false };
    }

    // Out of stock signals
    if (html.includes("Out of Stock") || html.includes("Sold Out") ||
        html.includes("out-of-stock") || html.includes("notify-me")) {
      return { online: false, status: "Out of stock", queueActive: false };
    }

    return { online: false, status: "Unknown", queueActive: false };
  } catch (e) {
    return { status: "Error", online: false, error: e.message };
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

function startPolling() {
  if (pollingActive) return;
  pollingActive  = true;
  pollAll();
  pollIntervalId = setInterval(pollAll, 60 * 1000);
  console.log("Polling STARTED");
}

function stopPolling() {
  if (!pollingActive) return;
  pollingActive = false;
  if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
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
    polling:  pollingActive
  });
});

app.get("/api/polling",        (req, res) => res.json({ active: pollingActive }));
app.post("/api/polling/start", (req, res) => { startPolling(); res.json({ active: true }); });
app.post("/api/polling/pause", (req, res) => { stopPolling();  res.json({ active: false }); });
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
