/**
 * Voix du Québec — Sondage provincial
 * Express + PoW + anti-spam + persistance JSON (tallies.json)
 * Auth: OAuth (Google + Microsoft) pour 1 personne = 1 parti
 * Politique: REPLACE (on peut changer d'avis)
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { Issuer, generators } = require('openid-client');

/* ---------- Config ---------- */
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`; // ex: https://voix-du-quebec.onrender.com
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-session-secret';
const SESSION_COOKIE = process.env.SESSION_COOKIE || 'v_sid';
const POW_BITS = Number(process.env.POW_BITS || 18);
const TZ = process.env.TZ || 'America/Toronto';
const DEMO = process.env.DEMO_MODE === '1';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || ''; // optionnel
const OAUTH_REQUIRED = process.env.OAUTH_REQUIRED === '1';       // exiger connexion pour voter
const VOTE_POLICY = 'REPLACE'; // demandé

// Google
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// Microsoft (Azure AD v2 "common")
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '';
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || '';

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser(SESSION_SECRET));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ---------- Persistance JSON ---------- */
const DATA_FILE = path.join(__dirname, 'tallies.json');
function loadData(){ try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf-8')); } catch { return { votes:{} }; } }
function saveData(data){ fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); }
let DATA = loadData();

/* ---------- Candidats ---------- */
const candidates = [
  { id:1, name:'Coalition Avenir Québec (François Legault)',          color:'#0aa2c0' },
  { id:2, name:'Parti Québécois (Paul St‑Pierre Plamondon)',          color:'#1b4db3' },
  { id:3, name:'Parti libéral du Québec (Pablo Rodriguez)',           color:'#d32f2f' },
  { id:4, name:'Québec solidaire (Gabriel Nadeau‑Dubois)',            color:'#f36f21' },
  { id:5, name:'Parti conservateur du Québec (Éric Duhaime)',         color:'#1d2e6e' },
  { id:6, name:'Parti Vert du Québec (Alex Tyrrell)',                 color:'#2e7d32' },
];
for (const c of candidates) if (!DATA.votes[c.id]) DATA.votes[c.id] = 0;

// 1 personne => 1 parti
// voterChoices: { [voterId]: candidateId }
if (!DATA.voterChoices) DATA.voterChoices = {};
// lien session -> accountId OAuth (persisté pour éviter de revoter après restart)
if (!DATA.voterAccountBySid) DATA.voterAccountBySid = {};
saveData(DATA);

/* ---------- Helpers ---------- */
function todayStr(){ return DateTime.now().setZone(TZ).toISODate(); }
function getClientIp(req){
  let ip = req.headers['x-forwarded-for'] || req.ip || '';
  if (typeof ip === 'string' && ip.includes(',')) ip = ip.split(',')[0].trim();
  if (typeof ip === 'string' && ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (Array.isArray(ip)) ip = ip[0];
  return (ip || '0.0.0.0').toString();
}
function ensureSession(req,res){
  let sid = req.signedCookies[SESSION_COOKIE];
  if (!sid){
    sid = crypto.randomBytes(16).toString('hex');
    res.cookie(SESSION_COOKIE, sid, {
      httpOnly:true, sameSite:'lax', secure:!!process.env.COOKIE_SECURE,
      signed:true, maxAge: 1000*60*60*24*365
    });
  }
  return sid;
}
function getAccountIdForSid(sid){
  return DATA.voterAccountBySid[sid] || null; // format: `${iss}|${sub}`
}
function getVoterId(req, sid){
  const acct = getAccountIdForSid(sid);
  if (acct) return `acct:${acct}`;
  // fallback: session+UA (moins robuste si pas connecté)
  const ua = (req.get('user-agent') || '').slice(0,256);
  return crypto.createHmac('sha256', SESSION_SECRET).update(`${sid}::${ua}`).digest('hex');
}

/* ---------- PoW ---------- */
function leadingZeroBitsHex(hex){
  let bits = 0;
  for (let i=0;i<hex.length;i++){
    const n = parseInt(hex[i],16);
    if (n===0){ bits+=4; continue; }
    for (let j=3;j>=0;j--){
      if (((n>>j)&1)===0) bits++; else return bits;
    }
  }
  return bits;
}
function verifyPowPayload(pow, requiredBits = POW_BITS){
  if (!pow || typeof pow.challenge!=='string' || !Number.isInteger(pow.nonce)) return false;
  const h = crypto.createHash('sha256').update(`${pow.challenge}:${pow.nonce}`).digest('hex');
  return leadingZeroBitsHex(h) >= requiredBits;
}
function makeChallenge(req){
  const sid = ensureSession(req, req.res);
  return crypto.randomBytes(16).toString('hex') + ':' + sid;
}

/* ---------- Anti‑replay (nonce + ts) ---------- */
const REPLAY_WINDOW_MS = 2 * 60 * 1000;
const nonces = new Map(); // key: `${day}:${nonce}` -> expiryMs
function verifyReplay(req,res,next){
  const { nonce, ts } = req.body || {};
  if (!nonce || !ts) return res.status(400).json({ error:'Requête invalide (nonce/ts manquant)' });
  const now = Date.now();
  const skew = Math.abs(now - Number(ts));
  if (!Number.isFinite(skew) || skew > REPLAY_WINDOW_MS){
    return res.status(400).json({ error:'Horodatage expiré' });
  }
  for (const [k, exp] of nonces){ if (exp <= now) nonces.delete(k); }
  const key = `${todayStr()}:${nonce}`;
  if (nonces.has(key)) return res.status(409).json({ error:'Rejeu détecté' });
  nonces.set(key, now + REPLAY_WINDOW_MS);
  next();
}

/* ---------- Turnstile (optionnel) ---------- */
async function verifyTurnstile(req,res,next){
  try{
    if (!TURNSTILE_SECRET) return next();
    const token = req.body?.cf_turnstile_response;
    if (!token) return res.status(400).json({ error:'Captcha requis' });
    const form = new URLSearchParams();
    form.append('secret', TURNSTILE_SECRET);
    form.append('response', token);
    form.append('remoteip', getClientIp(req));
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method:'POST', body: form });
    const data = await r.json();
    if (!data.success) return res.status(403).json({ error:'Captcha invalide', details:data['error-codes']||null });
    next();
  }catch(e){
    console.error('[Turnstile ERR]', e);
    return res.status(500).json({ error:'Erreur vérification captcha' });
  }
}

/* ---------- Limites anti‑spam (IP & session) ---------- */
const ipBuckets = new Map();      // ip -> {windowStart,count10m,day,countDay}
const sessionBuckets = new Map(); // sid -> {lastVoteTs,day,countDay}
const MIN_INTERVAL_MS     = DEMO ? 3000  : 60000; // 1 min / session
const SESSION_MAX_PER_DAY = DEMO ? 1000  : 10;
const
