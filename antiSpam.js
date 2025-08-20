// antiSpam.js
// Anti‑spam pour /api/vote : rate‑limit, Turnstile (Cloudflare) et anti‑replay.
// Fonctionne en mémoire par défaut. (Optionnel: Redis commenté plus bas.)

// ====== CONFIG ======
const WINDOW_MS = 60 * 1000;     // fenêtre de rate‑limit (60s)
const MAX_HITS  = 20;            // max requêtes par IP par minute
const REPLAY_WINDOW_MS = 2 * 60 * 1000; // nonce valide 2 min

// ====== RATE LIMIT (mémoire) ======
const hits = new Map(); // key: ip, value: array de timestamps (ms)

function rateLimit(req, res, next) {
  try {
    const now = Date.now();
    // Récup IP fiable derrière proxy si tu as mis app.set('trust proxy', 1)
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
      .toString().split(",")[0].trim();

    if (!hits.has(ip)) hits.set(ip, []);
    const arr = hits.get(ip);

    // purge
    while (arr.length && arr[0] <= now - WINDOW_MS) arr.shift();

    arr.push(now);
    if (arr.length > MAX_HITS) {
      return res.status(429).json({ ok: false, reason: "rate_limited" });
    }
    next();
  } catch (e) {
    // En cas de pépin, on laisse passer pour ne pas tout casser
    next();
  }
}

// ====== TURNSTILE (Cloudflare) ======
async function verifyTurnstile(req, res, next) {
  try {
    const token = req.body?.cf_turnstile_response;
    if (!token) return res.status(400).json({ ok: false, reason: "missing_captcha" });

    // Node 18+ : fetch global dispo
    const form = new URLSearchParams();
    form.append("secret", process.env.TURNSTILE_SECRET_KEY || "");
    form.append("response", token);
    // IP utile pour Cloudflare (optionnel)
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
      .toString().split(",")[0].trim();
    form.append("remoteip", ip);

    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form
    });
    const data = await r.json();
    if (!data.success) {
      return res.status(403).json({ ok: false, reason: "bad_captcha", data });
    }
    next();
  } catch (e) {
    return res.status(500).json({ ok: false, reason: "captcha_error" });
  }
}

// ====== ANTI‑REPLAY (nonce+timestamp) ======
const nonces = new Map(); // key: `${election_id}:${nonce}`, value: expiryMs

function verifyReplay(req, res, next) {
  const { election_id, nonce, ts } = req.body || {};
  if (!election_id || !nonce || !ts) {
    return res.status(400).json({ ok: false, reason: "missing_nonce_or_ts" });
  }
  const now = Date.now();
  const delta = Math.abs(now - Number(ts));
  if (!Number.isFinite(delta) || delta > REPLAY_WINDOW_MS) {
    return res.status(400).json({ ok: false, reason: "stale_ts" });
  }

  // purge légère
  for (const [k, exp] of nonces) {
    if (exp <= now) nonces.delete(k);
  }

  const key = `${election_id}:${nonce}`;
  if (nonces.has(key)) {
    return res.status(409).json({ ok: false, reason: "replay_detected" });
  }
  nonces.set(key, now + REPLAY_WINDOW_MS);
  next();
}

module.exports = { rateLimit, verifyTurnstile, verifyReplay };

/* ===== (Optionnel) Version Redis pour prod multi‑instances =====
   1) npm i ioredis
   2) dé-commente et remplace rateLimit/verifyReplay par versions Redis

// const Redis = require("ioredis");
// const redis = new Redis(process.env.REDIS_URL);

// async function rateLimit(req, res, next) {
//   const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
//   const now = Date.now();
//   const key = `rl:vote:${ip}`;
//   try {
//     await redis.zadd(key, now, String(now));
//     await redis.zremrangebyscore(key, 0, now - WINDOW_MS);
//     const count = await redis.zcard(key);
//     await redis.pexpire(key, WINDOW_MS);
//     if (count > MAX_HITS) return res.status(429).json({ ok: false, reason: "rate_limited" });
//     next();
//   } catch (e) { next(); }
// }

// async function verifyReplay(req, res, next) {
//   const { election_id, nonce, ts } = req.body || {};
//   if (!election_id || !nonce || !ts) return res.status(400).json({ ok: false, reason: "missing_nonce_or_ts" });
//   const now = Date.now();
//   const delta = Math.abs(now - Number(ts));
//   if (!Number.isFinite(delta) || delta > REPLAY_WINDOW_MS) {
//     return res.status(400).json({ ok: false, reason: "stale_ts" });
//   }
//   const key = `nonce:${election_id}:${nonce}`;
//   const set = await redis.set(key, "1", "PX", REPLAY_WINDOW_MS, "NX");
//   if (set !== "OK") return res.status(409).json({ ok: false, reason: "replay_detected" });
//   next();
// }
*/
