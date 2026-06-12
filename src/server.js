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

// Target: uses their RedSky API (same one their site uses).
// DPCI is derived from the URL path segment: /A-XXXXXXXX → 0XX-XX-XXXX
async function checkTarget(product) {
  try {
    const dpci = product.dpci || upcToDpci(product.upc);
    // RedSky inventory endpoint — store 1234 is a placeholder; real implementation
    // would resolve a nearby store TCINs from the user's zip via Target's store locator API.
    const tcin = product.tcin;
    if (!tcin) return null; // needs tcin resolved first

    const url =
      `https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?key=9f36ced1be59daa57c305c18aa8e6855db1f7e2c` +
      `&tcin=${tcin}&pricing_store_id=1234&has_store_id=true`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const avail = data?.data?.product?.fulfillment?.store_options?.[0]?.location_available_to_promise_quantity ?? null;
    if (avail === null) return null;
    return { qty: avail, status: avail === 0 ? "Out of stock" : avail <= 2 ? "Low stock" : "In stock" };
  } catch {
    return null;
  }
}

// Best Buy: uses their availability API — productId is the numeric ID in their URL.
async function checkBestBuy(product) {
  try {
    const bbId = product.bbId;
    if (!bbId) return null;

    // Best Buy's public product availability endpoint
    const url = `https://www.bestbuy.com/api/tcfb/model.json?paths=%5B%5B%22shop%22%2C%22buttonstate%22%2C%22v5%22%2C%22item%22%2C%22skus%22%2C${bbId}%2C%22conditions%22%2C%22NONE%22%2C%22destinationZipCode%22%2C%2292084%22%2C%22storeId%22%2C%221055%22%2C%22context%22%2C%22cyp%22%2C%22addAll%22%2C%22false%22%5D%5D&method=get`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const buttonState = data?.jsonGraph?.shop?.buttonstate?.v5?.item?.skus?.[bbId]?.conditions?.NONE?.destinationZipCode?.["92084"]?.storeId?.["1055"]?.context?.cyp?.addAll?.false?.value;
    if (!buttonState) return null;
    const inStock = buttonState.buttonStateResponseInfos?.some(b => b.buttonState === "ADD_TO_CART");
    return {
      qty: inStock ? 1 : 0,  // Best Buy doesn't expose exact qty
      status: inStock ? "In stock" : "Out of stock"
    };
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
cron.schedule("*/3 * * * *", pollAll);

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PokéTrack backend running on port ${PORT}`);
  console.log(`Poll interval: every 3 minutes`);
});
