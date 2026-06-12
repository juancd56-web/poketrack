"use strict";
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const cron    = require("node-cron");
const path    = require("path");
const Database = require("better-sqlite3");
const fs      = require("fs");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Retailer configuration (override via environment variables) ─────────────
const TARGET_STORE_ID  = process.env.TARGET_STORE_ID  || "1234";
const BESTBUY_ZIP      = process.env.BESTBUY_ZIP      || "92056";
const BESTBUY_STORE_ID = process.env.BESTBUY_STORE_ID || "498";

// ─── SQLite setup ────────────────────────────────────────────────────────────
// DB_PATH defaults to /data/poketrack.db on Render (persistent disk mount),
// or ./poketrack.db locally.
const DB_PATH = process.env.DB_PATH || (
  fs.existsSync("/data") ? "/data/poketrack.db" : path.join(__dirname, "../poketrack.db")
);

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    upc         TEXT,
    dpci        TEXT,
    tcin        TEXT,
    bbId        TEXT,
    retailer    TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'Checking…',
    qty         INTEGER NOT NULL DEFAULT 0,
    lastChecked TEXT,
    watching    INTEGER NOT NULL DEFAULT 1,
    addedAt     TEXT    NOT NULL,
    sourceUrl   TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    title     TEXT NOT NULL,
    retailer  TEXT NOT NULL,
    product   TEXT NOT NULL,
    qty       TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
`);

// ─── DB helpers ──────────────────────────────────────────────────────────────
const stmts = {
  allProducts:    db.prepare("SELECT * FROM products ORDER BY addedAt DESC"),
  insertProduct:  db.prepare(`
    INSERT INTO products (name, upc, dpci, tcin, bbId, retailer, status, qty, lastChecked, watching, addedAt, sourceUrl)
    VALUES (@name, @upc, @dpci, @tcin, @bbId, @retailer, @status, @qty, @lastChecked, @watching, @addedAt, @sourceUrl)
  `),
  updateProduct:  db.prepare(`
    UPDATE products SET status=@status, qty=@qty, lastChecked=@lastChecked WHERE id=@id
  `),
  toggleWatch:    db.prepare("UPDATE products SET watching = NOT watching WHERE id=@id"),
  getProduct:     db.prepare("SELECT * FROM products WHERE id=@id"),
  deleteProduct:  db.prepare("DELETE FROM products WHERE id=@id"),

  allAlerts:      db.prepare("SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 200"),
  alertsByType:   db.prepare("SELECT * FROM alerts WHERE type=@type ORDER BY timestamp DESC LIMIT 200"),
  insertAlert:    db.prepare(`
    INSERT INTO alerts (type, title, retailer, product, qty, timestamp)
    VALUES (@type, @title, @retailer, @product, @qty, @timestamp)
  `),
  // Keep only the 200 most recent alerts
  pruneAlerts:    db.prepare(`
    DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY timestamp DESC LIMIT 200)
  `),

  stats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='In stock'  THEN 1 ELSE 0 END) as inStock,
      SUM(CASE WHEN status='Low stock' THEN 1 ELSE 0 END) as lowStock
    FROM products
  `),
  todayRestocks: db.prepare(`
    SELECT COUNT(*) as cnt FROM alerts
    WHERE type='restock' AND date(timestamp) = date('now')
  `)
};

function rowToProduct(row) {
  if (!row) return null;
  return { ...row, watching: row.watching === 1 };
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── Retailer pollers ────────────────────────────────────────────────────────

async function checkTarget(product) {
  try {
    const tcin = product.tcin;
    if (!tcin) return null;

    const url =
      `https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?key=9f36ced1be59daa57c305c18aa8e6855db1f7e2c` +
      `&tcin=${tcin}&pricing_store_id=${TARGET_STORE_ID}&has_store_id=true`;

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

async function checkBestBuy(product) {
  try {
    const bbId = product.bbId;
    if (!bbId) return null;

    const encodedPaths = encodeURIComponent(JSON.stringify([[
      "shop", "buttonstate", "v5", "item", "skus", bbId,
      "conditions", "NONE",
      "destinationZipCode", BESTBUY_ZIP,
      "storeId", BESTBUY_STORE_ID,
      "context", "cyp",
      "addAll", "false"
    ]]));
    const url = `https://www.bestbuy.com/api/tcfb/model.json?paths=${encodedPaths}&method=get`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!res.ok) return null;

    const data = await res.json();
    const buttonStateNode =
      data?.jsonGraph?.shop?.buttonstate?.v5?.item?.skus?.[bbId]
          ?.conditions?.NONE
          ?.destinationZipCode?.[BESTBUY_ZIP]
          ?.storeId?.[BESTBUY_STORE_ID]
          ?.context?.cyp?.addAll?.false?.value;

    if (!buttonStateNode) return await checkBestBuyOnline(bbId);

    const infos      = buttonStateNode.buttonStateResponseInfos ?? [];
    const onlineInfo = infos.find(b => b.context === "online" || b.context === "shipToHome");
    const storeInfo  = infos.find(b => b.context === "inStore" || b.context === "pickup");
    const inStock    = onlineInfo?.buttonState === "ADD_TO_CART" || storeInfo?.buttonState === "ADD_TO_CART";

    return {
      qty:    inStock ? 1 : 0,
      status: inStock ? "In stock" : "Out of stock"
    };
  } catch {
    return null;
  }
}

async function checkBestBuyOnline(bbId) {
  try {
    const url = `https://www.bestbuy.com/site/searchpage.jsp?format=json&st=skuId:${bbId}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const sku  = data?.products?.[0];
    if (!sku) return null;
    const inStock = sku.inStoreAvailability || sku.onlineAvailability;
    return { qty: inStock ? 1 : 0, status: inStock ? "In stock" : "Out of stock" };
  } catch {
    return null;
  }
}

// ─── Poll all tracked products ───────────────────────────────────────────────
async function pollAll() {
  const products = stmts.allProducts.all().map(rowToProduct);
  console.log(`[${new Date().toISOString()}] Polling ${products.length} products…`);

  for (const product of products) {
    const result = product.retailer === "Target"
      ? await checkTarget(product)
      : await checkBestBuy(product);

    if (!result) continue;

    const prevStatus = product.status;
    const now        = new Date().toISOString();

    stmts.updateProduct.run({ id: product.id, status: result.status, qty: result.qty, lastChecked: now });

    if (prevStatus !== result.status) {
      const type =
        result.status === "In stock"  ? "restock" :
        result.status === "Low stock" ? "low"     : "soldout";

      const alert = {
        type,
        title:    buildAlertTitle(product, result.status, product.qty, result.qty),
        retailer: product.retailer,
        product:  product.name,
        qty:      result.qty > 0 ? `${result.qty} unit${result.qty !== 1 ? "s" : ""}` : "0",
        timestamp: now
      };
      stmts.insertAlert.run(alert);
      stmts.pruneAlerts.run();
      console.log(`  ALERT: ${alert.title}`);
    }
  }
}

function buildAlertTitle(product, status, prevQty, qty) {
  const at = `at ${product.retailer}`;
  if (status === "In stock")  return `${product.name} back in stock ${at}`;
  if (status === "Low stock") return `${product.name} — only ${qty} left ${at}`;
  return `${product.name} sold out ${at}`;
}

// ─── URL parser ──────────────────────────────────────────────────────────────
function parseRetailerURL(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("target.com")) {
      const match = u.pathname.match(/\/A-(\d+)/i);
      const tcin  = match ? match[1] : null;
      const dpci  = tcin ? tcin.replace(/^(\d{3})(\d{2})(\d{4})$/, "$1-$2-$3") : null;
      return { retailer: "Target", tcin, dpci };
    }
    if (u.hostname.includes("bestbuy.com")) {
      const match = u.pathname.match(/\/(\d+)\.p/);
      const bbId  = match ? match[1] : null;
      return { retailer: "Best Buy", bbId };
    }
  } catch {}
  return null;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/api/products", (req, res) => {
  res.json(stmts.allProducts.all().map(rowToProduct));
});

app.post("/api/products/url", async (req, res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const parsed = parseRetailerURL(url);
  if (!parsed) return res.status(400).json({ error: "Only Target and Best Buy URLs are supported." });

  const now = new Date().toISOString();
  const info = stmts.insertProduct.run({
    name:        name || "New product",
    upc:         null,
    dpci:        parsed.dpci  || null,
    tcin:        parsed.tcin  || null,
    bbId:        parsed.bbId  || null,
    retailer:    parsed.retailer,
    status:      "Checking…",
    qty:         0,
    lastChecked: null,
    watching:    1,
    addedAt:     now,
    sourceUrl:   url
  });

  const product = rowToProduct(stmts.getProduct.get({ id: info.lastInsertRowid }));

  setTimeout(async () => {
    const result = product.retailer === "Target"
      ? await checkTarget(product)
      : await checkBestBuy(product);
    stmts.updateProduct.run({
      id:          product.id,
      status:      result ? result.status : "Unknown",
      qty:         result ? result.qty    : 0,
      lastChecked: new Date().toISOString()
    });
  }, 500);

  res.status(201).json(product);
});

app.post("/api/products/upc", (req, res) => {
  const { name, upc, retailer } = req.body;
  if (!name || !upc || !retailer) return res.status(400).json({ error: "name, upc, and retailer are required" });

  const info = stmts.insertProduct.run({
    name, upc, dpci: null, tcin: null, bbId: null,
    retailer, status: "Checking…", qty: 0,
    lastChecked: null, watching: 1,
    addedAt: new Date().toISOString(), sourceUrl: null
  });
  res.status(201).json(rowToProduct(stmts.getProduct.get({ id: info.lastInsertRowid })));
});

app.patch("/api/products/:id/watch", (req, res) => {
  const product = stmts.getProduct.get({ id: Number(req.params.id) });
  if (!product) return res.status(404).json({ error: "Product not found" });
  stmts.toggleWatch.run({ id: product.id });
  res.json(rowToProduct(stmts.getProduct.get({ id: product.id })));
});

app.delete("/api/products/:id", (req, res) => {
  const product = stmts.getProduct.get({ id: Number(req.params.id) });
  if (!product) return res.status(404).json({ error: "Product not found" });
  stmts.deleteProduct.run({ id: product.id });
  res.json({ ok: true });
});

app.get("/api/alerts", (req, res) => {
  const { type } = req.query;
  res.json(
    type && type !== "all"
      ? stmts.alertsByType.all({ type })
      : stmts.allAlerts.all()
  );
});

app.get("/api/stats", (req, res) => {
  const counts = stmts.stats.get();
  const { cnt } = stmts.todayRestocks.get();
  res.json({
    total:    counts.total    ?? 0,
    inStock:  counts.inStock  ?? 0,
    lowStock: counts.lowStock ?? 0,
    today:    cnt             ?? 0
  });
});

app.post("/api/poll", async (req, res) => {
  await pollAll();
  res.json({ ok: true, polled: stmts.allProducts.all().length });
});

// ─── Scheduler ───────────────────────────────────────────────────────────────
cron.schedule("*/3 * * * *", pollAll);

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PokéTrack backend running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Poll interval: every 3 minutes`);
});
