const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const admin = require("firebase-admin");
const webpush = require("web-push");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // set your own in the environment
const FILE = path.join(process.env.DATA_DIR || __dirname, "notices.json");

// ---- storage: Firestore (permanent) if configured, else local file (testing only) ----
let col = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  col = admin.firestore().collection("notices");
  console.log("Using Firebase Firestore");
} else {
  console.warn("FIREBASE_SERVICE_ACCOUNT not set: using local file storage (not permanent)");
}

let notices = [];
async function load() {
  if (col) { notices = (await col.get()).docs.map(d => d.data()); return; }
  try { notices = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { notices = []; }
}
async function saveOne(n) {
  if (col) return col.doc(n.id).set(n);
  fs.writeFileSync(FILE, JSON.stringify(notices));
}
async function removeOne(id) {
  if (col) return col.doc(id).delete();
  fs.writeFileSync(FILE, JSON.stringify(notices));
}


// ---- push notifications (Web Push; subscriptions stored permanently in Firestore) ----
const CFG_FILE = path.join(process.env.DATA_DIR || __dirname, "push-config.json");
const SUBS_FILE = path.join(process.env.DATA_DIR || __dirname, "subs.json");
let subs = [];
let vapid = null;
const subId = ep => crypto.createHash("sha1").update(ep).digest("hex");
async function initPush() {
  if (col) {
    const db = admin.firestore();
    const ref = db.collection("config").doc("vapid");
    const d = await ref.get();
    if (d.exists) vapid = d.data(); else { vapid = webpush.generateVAPIDKeys(); await ref.set(vapid); }
    subs = (await db.collection("subs").get()).docs.map(x => x.data());
  } else {
    try { vapid = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch (e) { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(CFG_FILE, JSON.stringify(vapid)); }
    try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8")); } catch (e) { subs = []; }
  }
  webpush.setVapidDetails(process.env.CONTACT_EMAIL ? "mailto:" + process.env.CONTACT_EMAIL : "https://onrender.com", vapid.publicKey, vapid.privateKey);
  console.log("Push notifications ready (" + subs.length + " subscribers)");
}
async function saveSub(s) {
  if (col) return admin.firestore().collection("subs").doc(s.id).set(s);
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs));
}
async function dropSub(id) {
  subs = subs.filter(x => x.id !== id);
  try { if (col) await admin.firestore().collection("subs").doc(id).delete(); else fs.writeFileSync(SUBS_FILE, JSON.stringify(subs)); } catch (e) {}
}
function notifyAll(n) {
  const payload = JSON.stringify({ id: n.id, title: n.title, body: n.body.slice(0, 120), category: n.category, urgent: n.priority === "urgent" });
  subs.filter(s => s.cats.includes("All") || s.cats.includes(n.category)).forEach(s => {
    webpush.sendNotification(s.sub, payload).catch(e => {
      if (e.statusCode === 404 || e.statusCode === 410) dropSub(s.id); else console.error("push failed", e.statusCode || e.message);
    });
  });
}


// ---- media (images and PDF pages stored as JPEG pages) ----
const MEDIA_DIR = path.join(process.env.DATA_DIR || __dirname, "media");
const mediaCache = new Map();
const mkey = (nid, v, i) => `${nid}-${v}-${i}`.replace(/[^A-Za-z0-9_-]/g, "_");
async function mediaSave(k, data) {
  mediaCache.set(k, data);
  if (mediaCache.size > 60) mediaCache.delete(mediaCache.keys().next().value);
  if (col) return admin.firestore().collection("media").doc(k).set({ data });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, k), data);
}
async function mediaGet(k) {
  if (mediaCache.has(k)) return mediaCache.get(k);
  let d = null;
  if (col) { const s = await admin.firestore().collection("media").doc(k).get(); d = s.exists ? s.data().data : null; }
  else { try { d = fs.readFileSync(path.join(MEDIA_DIR, k), "utf8"); } catch (e) {} }
  if (d) { mediaCache.set(k, d); if (mediaCache.size > 60) mediaCache.delete(mediaCache.keys().next().value); }
  return d;
}
async function mediaDrop(att, nid) {
  if (!att || att.kind !== "pages") return;
  for (let i = 0; i < att.count; i++) {
    const k = mkey(nid, att.v, i);
    mediaCache.delete(k);
    try { if (col) await admin.firestore().collection("media").doc(k).delete(); else fs.unlinkSync(path.join(MEDIA_DIR, k)); } catch (e) {}
  }
}

const tokens = new Set();
const clients = new Set();
const broadcast = () => clients.forEach(res => res.write("data: update\n\n"));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const auth = (req, res, next) => tokens.has(req.get("x-token")) ? next() : res.status(401).json({ error: "unauthorized" });
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const fails = {};
app.post("/api/login", (req, res) => {
  const ip = req.ip, f = fails[ip] || { n: 0, t: Date.now() };
  if (f.n >= 8 && Date.now() - f.t < 600000) return res.status(429).json({ error: "too many attempts" });
  if (safeEqual((req.body || {}).password || "", ADMIN_PASSWORD)) {
    delete fails[ip];
    const token = crypto.randomBytes(24).toString("hex");
    tokens.add(token);
    return res.json({ token });
  }
  fails[ip] = { n: f.n + 1, t: Date.now() };
  res.status(401).json({ error: "wrong password" });
});

app.get("/api/notices", (req, res) => res.json(notices));

app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

app.get("/api/push/key", (req, res) => res.json({ key: vapid.publicKey }));

app.post("/api/push/subscribe", async (req, res) => {
  const { subscription, cats } = req.body || {};
  if (!subscription || typeof subscription.endpoint !== "string" || !subscription.endpoint.startsWith("https://") ||
      !subscription.keys || !Array.isArray(cats) || !cats.length) return res.status(400).json({ error: "bad request" });
  if (subs.length > 5000) return res.status(503).json({ error: "subscriber limit reached" });
  const s = {
    id: subId(subscription.endpoint),
    sub: { endpoint: subscription.endpoint, keys: { p256dh: String(subscription.keys.p256dh), auth: String(subscription.keys.auth) } },
    cats: cats.map(c => String(c).slice(0, 30)).slice(0, 12),
  };
  const i = subs.findIndex(x => x.id === s.id);
  if (i >= 0) subs[i] = s; else subs.push(s);
  try { await saveSub(s); res.json({ ok: true }); } catch (e) { console.error(e.message); res.status(500).json({ error: "save failed" }); }
});

app.post("/api/push/unsubscribe", async (req, res) => {
  await dropSub(subId(String((req.body || {}).endpoint || "")));
  res.json({ ok: true });
});

app.post("/api/notices/:id/media/:v/:i", auth, async (req, res) => {
  const i = Number(req.params.i), v = Number(req.params.v), d = (req.body || {}).data;
  if (!Number.isInteger(i) || i < 0 || i >= 20 || !Number.isFinite(v) || typeof d !== "string" ||
      !d.startsWith("data:image/jpeg;base64,") || d.length > 900000) return res.status(400).json({ error: "bad media" });
  try { await mediaSave(mkey(req.params.id, v, i), d.slice(23)); res.json({ ok: true }); }
  catch (e) { console.error(e.message); res.status(500).json({ error: "save failed" }); }
});

app.get("/api/media/:id/:v/:i", async (req, res) => {
  try {
    const d = await mediaGet(mkey(req.params.id, Number(req.params.v), Number(req.params.i)));
    if (!d) return res.status(404).end();
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" });
    res.send(Buffer.from(d, "base64"));
  } catch (e) { res.status(500).end(); }
});

app.put("/api/notices/:id", auth, async (req, res) => {
  const b = req.body || {};
  const n = {
    id: String(req.params.id).slice(0, 40),
    title: String(b.title || "").slice(0, 120),
    body: String(b.body || "").slice(0, 1500),
    category: String(b.category || "General").slice(0, 30),
    priority: b.priority === "urgent" ? "urgent" : "normal",
    expires: String(b.expires || "").slice(0, 10),
    created: Number(b.created) || Date.now(),
    author: "Admin",
    duration: Math.max(3, Math.min(120, Number(b.duration) || 8)),
  };
  if (!n.title) return res.status(400).json({ error: "title required" });
  if (b.att && b.att.kind === "pages" && Number.isFinite(Number(b.att.v))) {
    n.att = { name: String(b.att.name).slice(0, 100), kind: "pages", v: Number(b.att.v), count: Math.min(20, Math.max(1, Math.floor(Number(b.att.count)) || 1)) };
  } else if (b.att && typeof b.att.data === "string" && b.att.data.length < 400000) {
    n.att = { name: String(b.att.name).slice(0, 100), type: String(b.att.type).slice(0, 50), data: b.att.data };
  }
  const i = notices.findIndex(x => x.id === n.id);
  const prev = i >= 0 ? notices[i] : null;
  if (i >= 0) notices[i] = n; else notices.push(n);
  try { await saveOne(n); } catch (e) {
    console.error(e.message);
    if (prev) notices[i] = prev; else notices = notices.filter(x => x.id !== n.id);
    return res.status(500).json({ error: "save failed" });
  }
  broadcast();
  if (prev && prev.att && prev.att.kind === "pages" && (!n.att || n.att.v !== prev.att.v)) mediaDrop(prev.att, n.id);
  if (!prev && (!n.expires || n.expires >= new Date().toISOString().slice(0, 10))) notifyAll(n);
  res.json(n);
});

app.delete("/api/notices/:id", auth, async (req, res) => {
  const old = notices.find(x => x.id === req.params.id);
  notices = notices.filter(x => x.id !== req.params.id);
  if (old) mediaDrop(old.att, old.id);
  try { await removeOne(req.params.id); } catch (e) { console.error(e.message); return res.status(500).json({ error: "delete failed" }); }
  broadcast();
  res.json({ ok: true });
});

load().then(initPush).then(() => app.listen(PORT, () => console.log("Notice board running on port " + PORT)))
  .catch(e => { console.error("Startup failed:", e.message); process.exit(1); });
