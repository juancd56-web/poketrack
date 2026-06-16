"use strict";
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const cron = require("node-cron");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── In-memory store ────────────────────────────────────────────────────────
// In production you'd swap this for a SQLite or Postgres DB.
let products = [];   // { id, name, upc, dpci, retailer, status, qty, lastChecked, watching, addedAt }
let alerts   = [];   // { id, type, title, retailer, product, qty, timestamp }

let nextId = 1;
function uid() { return nextId++; }

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

// Best Buy: product availability API using their add-to-cart endpoint.
// Checks online availability + local store (Best Buy #358, Vista CA area).
async function checkBestBuy(product) {
  try {
    const bbId = product.bbId;
    if (!bbId) return null;

    const ZIP      = process.env.BESTBUY_ZIP      || "92084";
    const STORE_ID = process.env.BESTBUY_STORE_ID || "437"; // Best Buy, store 437

    // Best Buy's product availability API — more stable than the buttonstate endpoint
    const url =
      `https://www.bestbuy.com/api/tcfb/model.json?paths=` +
      encodeURIComponent(JSON.stringify([
        ["shop", "buttonstate", "v5", "item", "skus", bbId,
         "conditions", "NONE",
         "destinationZipCode", ZIP,
         "storeId", STORE_ID,
         "context", "cyp", "addAll", "false"]
      ])) + `&method=get`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `https://www.bestbuy.com/site/product/${bbId}.p`
      }
    });

    if (!res.ok) {
      // Fallback: scrape the product page for availability text
      return await checkBestBuyFallback(bbId);
    }

    const data = await res.json();
    const skuData = data?.jsonGraph?.shop?.buttonstate?.v5?.item?.skus?.[bbId]
      ?.conditions?.NONE?.destinationZipCode?.[ZIP]
      ?.storeId?.[STORE_ID]?.context?.cyp?.addAll?.false?.value;

    if (!skuData) return await checkBestBuyFallback(bbId);

    const inStock = skuData?.buttonStateResponseInfos?.some(
      b => b.buttonState === "ADD_TO_CART" || b.buttonState === "PRE_ORDER"
    );
    return {
      qty: inStock ? 1 : 0,
      status: inStock ? "In stock" : "Out of stock"
    };
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
function parseRetailerURL(url) {
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

    // Best Buy: https://www.bestbuy.com/site/product-name/1234567.p
    if (u.hostname.includes("bestbuy.com")) {
      const match = u.pathname.match(/\/(\d+)\.p/);
      const bbId  = match ? match[1] : null;
      return { retailer: "Best Buy", bbId };
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

  const parsed = parseRetailerURL(url);
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

// Manual poll trigger (useful for testing)
app.post("/api/poll", async (req, res) => {
  await pollAll();
  res.json({ ok: true, polled: products.length });
});

// ─── Scheduler: poll every 3 minutes ────────────────────────────────────────
cron.schedule("* * * * *", pollAll);

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PokéTrack backend running on port ${PORT}`);
  console.log(`Poll interval: every 1 minute`);
});
