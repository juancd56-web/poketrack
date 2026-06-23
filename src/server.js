"use strict";
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── In-memory store ────────────────────────────────────────────────────────
let nextId = 1;
function uid() { return nextId++; }

// ─── Pre-seeded products ─────────────────────────────────────────────────────
// One row per product per store — gives a clear per-location view on the dashboard.
const TARGET_STORES = [
  { storeId: "303",  zip: "92054", name: "Oceanside" },       // ~2mi
  { storeId: "2871", zip: "92057", name: "Oceanside East" },  // ~4mi
  { storeId: "1040", zip: "92083", name: "Vista North" },     // ~5mi
  { storeId: "2165", zip: "92081", name: "Vista South" },     // ~6mi
  { storeId: "1029", zip: "92024", name: "Encinitas" },       // ~14mi
];
const BB_STORES = [
  { id: "437", name: "Oceanside" },
  { id: "871", name: "San Marcos" },
  { id: "352", name: "Mira Mesa" },
];

const SEED_PRODUCTS = [
  {
    name: "Mega Evolution—Chaos Rising Booster Bundle",
    target: { tcin: "95298172", sourceUrl: "https://www.target.com/p/pok-233-mon-trading-card-game-mega-evolution-chaos-rising-booster-bundle/-/A-95298172" },
    bestbuy: { bbId: "12664504", sourceUrl: "https://www.bestbuy.com/product/pokemon-trading-card-game-mega-evolution-chaos-rising-booster-bundle/JJG2TL34H9" },
  },
  {
    name: "Mega Evolution—Chaos Rising Elite Trainer Box",
    target: { tcin: "1011710073", sourceUrl: "https://www.target.com/p/pokemon-tcg-mega-evolution-chaos-rising-pokemon-center-elite-trainer-box/-/A-1011710073" },
    bestbuy: { bbId: "12692374", sourceUrl: "https://www.bestbuy.com/product/pokemon-trading-card-game-mega-evolution-chaos-rising-elite-trainer-box/JJG2TL34RT" },
  },
];

function buildSeededProducts() {
  const list = [];
  for (const seed of SEED_PRODUCTS) {
    // One Target row per Target store
    for (const store of TARGET_STORES) {
      list.push({
        id: uid(), name: seed.name, upc: null,
        retailer: "Target", storeName: `Target ${store.name}`, storeId: store.storeId, zip: store.zip,
        tcin: seed.target.tcin,
        status: "Checking…", qty: 0, lastChecked: null, watching: true,
        addedAt: new Date().toISOString(), sourceUrl: seed.target.sourceUrl,
      });
    }
    // One Best Buy row per BB store
    for (const store of BB_STORES) {
      list.push({
        id: uid(), name: seed.name, upc: null,
        retailer: "Best Buy", storeName: `Best Buy ${store.name}`, storeId: store.id,
        bbId: seed.bestbuy.bbId,
        status: "Checking…", qty: 0, lastChecked: null, watching: true,
        addedAt: new Date().toISOString(), sourceUrl: seed.bestbuy.sourceUrl,
      });
    }
  }
  return list;
}

let products = buildSeededProducts();
let alerts = [];   // { id, type, title, retailer, product, qty, timestamp }

// ─── Retailer pollers ────────────────────────────────────────────────────────

// Target: RedSky fulfillment API with current key + Vista, CA store (T-2233)
// Falls back to checking online availability if store check fails.
async function checkTarget(product) {
  try {
    const tcin = product.tcin;
    if (!tcin) return null;

    // Vista, CA store ID: 2233. Zip: 92084.
    const STORE_ID = process.env.TARGET_STORE_ID || "2233";
    const ZIP      = process.env.TARGET_ZIP      || "92084";
    const KEY      = "9f36aeafbe60771e321a7cc95a78140772ab3e96"; // current RedSky key

    const url =
      `https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1` +
      `?key=${KEY}&tcins=${tcin}&store_id=${STORE_ID}&zip=${ZIP}&state=CA&include_only_non_members=true`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.target.com",
        "Referer": "https://www.target.com/"
      }
    });
    if (!res.ok) {
      console.warn(`Target API ${res.status} for tcin ${tcin}`);
      return null;
    }
    const data = await res.json();
    const item = data?.data?.product_summaries?.[0];
    if (!item) return null;

    // Check in-store availability first, fall back to online
    const storeAvail = item?.fulfillment?.store_options?.[0]?.location_available_to_promise_quantity;
    const onlineAvail = item?.fulfillment?.shipping_options?.available_to_promise_quantity ?? 0;
    const isOutOfStockEverywhere = item?.fulfillment?.is_out_of_stock_in_all_store_locations;

    let qty = storeAvail ?? onlineAvail ?? 0;
    if (isOutOfStockEverywhere) qty = 0;

    return {
      qty,
      status: qty === 0 ? "Out of stock" : qty <= 2 ? "Low stock" : "In stock"
    };
  } catch (e) {
    console.error("checkTarget error:", e.message);
    return null;
  }
}

// Best Buy: checks a single store per product (storeId stored on product)
async function checkBestBuy(product) {
  try {
    const bbId    = product.bbId;
    const storeId = product.storeId;
    if (!bbId || !storeId) return null;

    const ZIP = process.env.BESTBUY_ZIP || "92084";
    const url =
      `https://www.bestbuy.com/api/tcfb/model.json?paths=` +
      encodeURIComponent(JSON.stringify([
        ["shop", "buttonstate", "v5", "item", "skus", bbId,
         "conditions", "NONE",
         "destinationZipCode", ZIP,
         "storeId", storeId,
         "context", "cyp", "addAll", "false"]
      ])) + `&method=get`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": `https://www.bestbuy.com/site/product/${bbId}.p`
      }
    });

    if (!res.ok) return await checkBestBuyFallback(bbId);

    const data = await res.json();
    const skuData = data?.jsonGraph?.shop?.buttonstate?.v5?.item?.skus?.[bbId]
      ?.conditions?.NONE?.destinationZipCode?.[ZIP]
      ?.storeId?.[storeId]?.context?.cyp?.addAll?.false?.value;

    if (!skuData) return await checkBestBuyFallback(bbId);

    const inStock = skuData?.buttonStateResponseInfos?.some(
      b => b.buttonState === "ADD_TO_CART" || b.buttonState === "PRE_ORDER"
    ) ?? false;

    return { qty: inStock ? 1 : 0, status: inStock ? "In stock" : "Out of stock" };
  } catch (e) {
    console.error("checkBestBuy error:", e.message);
    return null;
  }
}

// Best Buy fallback: check the product page HTML for availability signals
async function checkBestBuyFallback(bbId) {
  try {
    const res = await fetch(`https://www.bestbuy.com/site/product/${bbId}.p`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Look for JSON-LD or availability signals in the page
    const soldOutSignals = [
      "sold-out", "Sold Out", "unavailable", "OUT_OF_STOCK",
      '"availability":"OutOfStock"'
    ];
    const inStockSignals = [
      '"availability":"InStock"', "Add to Cart", "ADD_TO_CART"
    ];

    if (inStockSignals.some(s => html.includes(s))) {
      return { qty: 1, status: "In stock" };
    }
    if (soldOutSignals.some(s => html.includes(s))) {
      return { qty: 0, status: "Out of stock" };
    }
    return null; // ambiguous
  } catch {
    return null;
  }
}

// ─── Poll all tracked products ───────────────────────────────────────────────
async function pollAll() {
  console.log(`[${new Date().toISOString()}] Polling ${products.length} products…`);
  for (const product of products) {
    const result = product.retailer === "Target"
      ? await checkTarget(product)
      : await checkBestBuy(product);

    if (!result) continue; // API unreachable, skip

    const prevStatus = product.status;
    const prevQty    = product.qty;
    product.qty         = result.qty;
    product.status      = result.status;
    product.lastChecked = new Date().toISOString();

    // Fire an alert if status changed
    if (prevStatus !== result.status) {
      const type =
        result.status === "In stock"    ? "restock"  :
        result.status === "Low stock"   ? "low"      : "soldout";

      const alert = {
        id:        uid(),
        type,
        title:     buildAlertTitle(product, result.status, prevQty, result.qty),
        retailer:  product.retailer,
        product:   product.name,
        qty:       result.qty > 0 ? `${result.qty} unit${result.qty !== 1 ? "s" : ""}` : "0",
        timestamp: new Date().toISOString()
      };
      alerts.unshift(alert);
      if (alerts.length > 200) alerts.pop(); // keep last 200
      console.log(`  ALERT: ${alert.title}`);
    }
  }
}

function buildAlertTitle(product, status, prevQty, qty) {
  const at = `at ${product.retailer}`;
  if (status === "In stock")    return `${product.name} back in stock ${at}`;
  if (status === "Low stock")   return `${product.name} — only ${qty} left ${at}`;
  return `${product.name} sold out ${at}`;
}

// ─── URL parser: extract retailer IDs from product URLs ─────────────────────
async function parseRetailerURL(url) {
  try {
    const u = new URL(url);

    // Target: https://www.target.com/p/name/-/A-12345678
    if (u.hostname.includes("target.com")) {
      const match = u.pathname.match(/\/A-(\d+)/i);
      const tcin  = match ? match[1] : null;
      // DPCI from tcin: pad to 9 digits → XXX-XX-XXXX
      const dpci  = tcin ? tcin.replace(/^(\d{3})(\d{2})(\d{4})$/, "$1-$2-$3") : null;
      return { retailer: "Target", tcin, dpci };
    }

    // Best Buy: two URL formats
    // Old: /site/product-name/6609962.p  → numeric bbId
    // New: /product/product-name/JJG2TL34H9 → alphanumeric bsin, need to resolve to numeric skuId
    if (u.hostname.includes("bestbuy.com")) {
      const numericMatch = u.pathname.match(/\/(\d+)\.p/);
      if (numericMatch) {
        return { retailer: "Best Buy", bbId: numericMatch[1] };
      }
      // New format — fetch page to extract numeric skuId
      const alphaMatch = u.pathname.match(/\/([A-Z0-9]{8,})$/i);
      if (alphaMatch) {
        try {
          const res = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              "Accept": "text/html"
            }
          });
          if (res.ok) {
            const html = await res.text();
            // Extract from meta-analytics-metadata JSON
            const metaMatch = html.match(/"skuId":"(\d+)"/);
            if (metaMatch) return { retailer: "Best Buy", bbId: metaMatch[1] };
            // Fallback: SKU label in page
            const skuMatch = html.match(/SKU:\s*(\d+)/);
            if (skuMatch) return { retailer: "Best Buy", bbId: skuMatch[1] };
          }
        } catch(e) {
          console.warn("Best Buy URL resolve error:", e.message);
        }
      }
      return { retailer: "Best Buy", bbId: null };
    }
  } catch {}
  return null;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET all products
app.get("/api/products", (req, res) => {
  res.json(products);
});

// POST add product by URL
app.post("/api/products/url", async (req, res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const parsed = await parseRetailerURL(url);
  if (!parsed) return res.status(400).json({ error: "Only Target and Best Buy URLs are supported." });

  const product = {
    id:          uid(),
    name:        name || "New product",
    upc:         null,
    retailer:    parsed.retailer,
    status:      "Checking…",
    qty:         0,
    lastChecked: null,
    watching:    true,
    addedAt:     new Date().toISOString(),
    sourceUrl:   url,
    ...parsed
  };
  products.push(product);

  // Poll immediately in background
  setTimeout(async () => {
    const result = product.retailer === "Target"
      ? await checkTarget(product)
      : await checkBestBuy(product);
    if (result) {
      product.status      = result.status;
      product.qty         = result.qty;
      product.lastChecked = new Date().toISOString();
    } else {
      product.status = "Unknown";
    }
  }, 500);

  res.status(201).json(product);
});

// POST add product by UPC
app.post("/api/products/upc", (req, res) => {
  const { name, upc, retailer } = req.body;
  if (!name || !upc || !retailer) return res.status(400).json({ error: "name, upc, and retailer are required" });

  const product = {
    id:          uid(),
    name,
    upc,
    retailer,
    status:      "Checking…",
    qty:         0,
    lastChecked: null,
    watching:    true,
    addedAt:     new Date().toISOString()
  };
  products.push(product);
  res.status(201).json(product);
});

// PATCH toggle watching
app.patch("/api/products/:id/watch", (req, res) => {
  const product = products.find(p => p.id === Number(req.params.id));
  if (!product) return res.status(404).json({ error: "Product not found" });
  product.watching = !product.watching;
  res.json(product);
});

// DELETE remove product
app.delete("/api/products/:id", (req, res) => {
  const idx = products.findIndex(p => p.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Product not found" });
  products.splice(idx, 1);
  res.json({ ok: true });
});

// GET raw Target API response for a single product — diagnostic tool
app.get("/api/debug/target/:tcin", async (req, res) => {
  const { tcin } = req.params;
  const storeId  = req.query.store_id || "303";
  const zip      = req.query.zip      || "92054";
  const KEY      = "9f36aeafbe60771e321a7cc95a78140772ab3e96";

  const url =
    `https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1` +
    `?key=${KEY}&tcins=${tcin}&store_id=${storeId}&zip=${zip}&state=CA&include_only_non_members=true`;

  try {
    const start = Date.now();
    const apiRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.target.com",
        "Referer": "https://www.target.com/"
      }
    });
    const elapsed = Date.now() - start;
    const responseHeaders = {};
    apiRes.headers.forEach((v, k) => responseHeaders[k] = v);

    let body = null;
    let parseError = null;
    try { body = await apiRes.json(); } catch (e) { parseError = e.message; }

    // Extract the key inventory fields if available
    const summary = body?.data?.product_summaries?.[0];
    const parsed = summary ? {
      title:        summary?.item?.product_description?.title,
      storeQty:     summary?.fulfillment?.store_options?.[0]?.location_available_to_promise_quantity,
      storeStatus:  summary?.fulfillment?.store_options?.[0]?.in_store_only?.availability_status,
      pickupStatus: summary?.fulfillment?.store_options?.[0]?.order_pickup?.availability_status,
      onlineStatus: summary?.fulfillment?.shipping_options?.availability_status,
      oosAllStores: summary?.fulfillment?.is_out_of_stock_in_all_store_locations,
      storeLocation:summary?.fulfillment?.store_options?.[0]?.location_name,
    } : null;

    res.json({
      request:  { tcin, storeId, zip, url },
      response: { status: apiRes.status, statusText: apiRes.statusText, elapsed: `${elapsed}ms`, headers: responseHeaders },
      parsed,
      raw: body,
      parseError
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET alerts
app.get("/api/alerts", (req, res) => {
  const { type } = req.query;
  res.json(type && type !== "all" ? alerts.filter(a => a.type === type) : alerts);
});

// GET stats
app.get("/api/stats", (req, res) => {
  const today = new Date().toDateString();
  res.json({
    total:    products.length,
    inStock:  products.filter(p => p.status === "In stock").length,
    lowStock: products.filter(p => p.status === "Low stock").length,
    today:    alerts.filter(a => a.type === "restock" && new Date(a.timestamp).toDateString() === today).length
  });
});

// ─── Polling state ───────────────────────────────────────────────────────────
let pollingActive = false;
let pollInterval  = null;

function startPolling() {
  if (pollingActive) return;
  pollingActive = true;
  pollAll(); // poll immediately on start
  pollInterval = setInterval(pollAll, 60 * 1000);
  console.log("Polling STARTED");
}

function stopPolling() {
  if (!pollingActive) return;
  pollingActive = false;
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  console.log("Polling PAUSED");
}

// GET polling status
app.get("/api/polling", (req, res) => {
  res.json({ active: pollingActive });
});

// POST start polling
app.post("/api/polling/start", (req, res) => {
  startPolling();
  res.json({ active: true });
});

// POST pause polling
app.post("/api/polling/pause", (req, res) => {
  stopPolling();
  res.json({ active: false });
});

// Manual single poll trigger
app.post("/api/poll", async (req, res) => {
  await pollAll();
  res.json({ ok: true, polled: products.length });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PokéTrack backend running on port ${PORT}`);
  console.log(`Polling paused — press Start on the dashboard to begin`);
});
