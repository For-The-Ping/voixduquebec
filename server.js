/**
 * Voix du Québec — Sondage provincial
 * Express + PoW + limites anti-spam + persistance JSON (tallies.json)
 * Politique de vote: REPLACE (on peut changer d'avis)
 * + Anti‑replay (nonce/ts) + Turnstile (optionnel)
 * + Email OTP (1 personne = 1 parti, basé sur l’email vérifié)
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { DateTime } = require('luxon');

/* ---------- Config ---------- */
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-session-secret';
const SESSION_COOKIE = process.env.SESSION_COOKIE || 'v_sid';
const POW_BITS = Number(process.env.POW_BITS || 18);
const TZ = process.env.TZ || 'America/Toronto';
const DEMO = process.env.DEMO_MODE === '1';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || ''; // laisser vide si pas utilisé
const VOTE_POLICY = 'REPLACE'; // <= demandé: on peut changer d'avis

// Email OTP (si SMTP non configuré, on log le code dans la console)
const EMAIL_REQUIRED = process.env.EMAIL_REQUIRED === '1'; // si '1', vote possible seulement après email vérifié
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';

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

/* ---------- Candidats (provincial) ---------- */
const candidates = [
  { id:1, name:'Coalition Avenir Québec (François Legault)',          color:'#0aa2c0' },
  { id:2, name:'Parti Québécois (Paul St‑Pierre Plamondon)',          color:'#1b4db3' },
  { id:3, name:'Parti libéral du Québec (Pablo Rodriguez)',           color:'#d32f2f' },
  { id:4, name:'Québec solidaire (Gabriel Nadeau‑Dubois)',            color:'#f36f21' },
  { id:5, name:'Parti conservateur du Québec (Éric Duhaime)',         color:'#1d2e6e' },
  { id:6, name:'Parti Vert du Québec (Alex Tyrrell)',                 color:'#2e7d32' },
];
for (const c of candidates) if (!DATA.votes[c.id]) DATA.votes[c.id] = 0;

// 1 personne => 1 parti: on stocke le choix par identifiant de votant
// voterChoices: { [voterId]: candidateId }
if (!DATA.voterChoices) DATA.voterChoices = {};

// lien session -> emailHash vérifié (pour ne pas garder l'email en clair)
if (!DATA.voterEmailBySid) DATA.voterEmailBySid = {};

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
function normalizeEmail(e){ return (e||'').trim().toLowerCase(); }
function hashEmail(email){
  return crypto.createHmac('sha256', SESSION_SECRET).update(`email::${normalizeEmail(email)}`).digest('hex');
}
function getVoterId(req, sid){
  // Si l'email est vérifié pour cette session, identifiant = emailHash (stable inter-navigateurs si même email)
  const emailHash = DATA.voterEmailBySid[sid];
  if (emailHash) return `email:${emailHash}`;
  // Sinon: fallback session+UA (moins robuste)
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
  return crypto.randomBytes(16).toString('hex') + ':' + sid; // challenge lié à la session
}

/* ---------- Anti‑replay (nonce + ts) ---------- */
const REPLAY_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const nonces = new Map(); // key: `${day}:${nonce}` -> expiryMs

function verifyReplay(req,res,next){
  const { nonce, ts } = req.body || {};
  if (!nonce || !ts) return res.status(400).json({ error:'Requête invalide (nonce/ts manquant)' });
  const now = Date.now();
  const skew = Math.abs(now - Number(ts));
  if (!Number.isFinite(skew) || skew > REPLAY_WINDOW_MS){
    return res.status(400).json({ error:'Horodatage expiré' });
  }
  // purge légère
  for (const [k, exp] of nonces){ if (exp <= now) nonces.delete(k); }
  const key = `${todayStr()}:${nonce}`;
  if (nonces.has(key)) return res.status(409).json({ error:'Rejeu détecté' });
  nonces.set(key, now + REPLAY_WINDOW_MS);
  next();
}

/* ---------- Turnstile (optionnel) ---------- */
async function verifyTurnstile(req,res,next){
  try{
    if (!TURNSTILE_SECRET) return next(); // non configuré
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
const MIN_INTERVAL_MS     = DEMO ? 3000  : 60000; // 1 min par session (3s en DEMO)
const SESSION_MAX_PER_DAY = DEMO ? 1000  : 10;
const IP_MAX_10MIN        = DEMO ? 1000  : 5;
const IP_MAX_PER_DAY      = DEMO ? 5000  : 100;

function checkLimits(req,res,next){
  const now = Date.now();
  const ip  = getClientIp(req);
  const sid = ensureSession(req,res);

  // IP
  const ipEntry = ipBuckets.get(ip) || { windowStart: now, count10m:0, day: todayStr(), countDay:0 };
  if (now - ipEntry.windowStart > 10*60*1000){ ipEntry.windowStart = now; ipEntry.count10m = 0; }
  if (ipEntry.day !== todayStr()){ ipEntry.day = todayStr(); ipEntry.countDay = 0; }
  ipEntry.count10m++; ipEntry.countDay++; ipBuckets.set(ip, ipEntry);
  if (ipEntry.count10m > IP_MAX_10MIN) return res.status(429).json({ error:'Trop de votes IP (10 min)' });
  if (ipEntry.countDay  > IP_MAX_PER_DAY) return res.status(429).json({ error:'Quota quotidien IP atteint' });

  // Session
  const s = sessionBuckets.get(sid) || { lastVoteTs:0, day:todayStr(), countDay:0 };
  if (s.day !== todayStr()){ s.day = todayStr(); s.countDay = 0; }
  if (now - s.lastVoteTs < MIN_INTERVAL_MS){
    const wait = Math.ceil((MIN_INTERVAL_MS - (now - s.lastVoteTs))/1000);
    return res.status(429).json({ error:`Patientez ${wait}s` });
  }
  if (s.countDay >= SESSION_MAX_PER_DAY) return res.status(429).json({ error:`Limite ${SESSION_MAX_PER_DAY} votes/jour` });
  s.lastVoteTs = now; s.countDay++; sessionBuckets.set(sid, s);

  next();
}

/* ---------- Email OTP ---------- */
// transporter (si SMTP configuré)
let transporter = null;
if (SMTP_HOST && EMAIL_FROM) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
}

// OTP en mémoire: key = sid -> { code, emailHash, exp }
const OTP_TTL_MS = 10 * 60 * 1000;
const otps = new Map();

function createOtp(){ return String(Math.floor(100000 + Math.random()*900000)); }

app.post('/api/otp/request', async (req,res) => {
  try{
    const { email } = req.body || {};
    const sid = ensureSession(req,res);
    const em = normalizeEmail(email);
    if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      return res.status(400).json({ error:'Email invalide' });
    }
    const code = createOtp();
    const emailHash = hashEmail(em);
    const exp = Date.now() + OTP_TTL_MS;
    otps.set(sid, { code, emailHash, exp });

    if (transporter) {
      await transporter.sendMail({
        from: EMAIL_FROM,
        to: em,
        subject: 'Votre code de vérification — Voix du Québec',
        text: `Votre code est: ${code} (valide 10 minutes)`,
        html: `<p>Votre code est: <b>${code}</b> (valide 10 minutes)</p>`
      });
    } else {
      console.log(`[OTP DEMO] ${em} → code: ${code}`);
    }
    res.json({ ok:true, demo: !transporter });
  }catch(e){
    console.error('[OTP request ERR]', e);
    res.status(500).json({ error:'Erreur envoi OTP' });
  }
});

app.post('/api/otp/verify', (req,res) => {
  try{
    const { email, code } = req.body || {};
    const sid = ensureSession(req,res);
    const em = normalizeEmail(email);
    const rec = otps.get(sid);
    if (!rec) return res.status(400).json({ error:'Aucun code en attente' });
    if (Date.now() > rec.exp) { otps.delete(sid); return res.status(400).json({ error:'Code expiré' }); }
    if (rec.code !== String(code)) return res.status(400).json({ error:'Code invalide' });
    if (rec.emailHash !== hashEmail(em)) return res.status(400).json({ error:'Email ne correspond pas' });

    // Marquer la session comme vérifiée pour cet email
    DATA.voterEmailBySid[sid] = rec.emailHash;
    saveData(DATA);
    otps.delete(sid);
    res.json({ ok:true });
  }catch(e){
    console.error('[OTP verify ERR]', e);
    res.status(500).json({ error:'Erreur vérification OTP' });
  }
});

app.get('/api/me', (req,res)=>{
  const sid = ensureSession(req,res);
  res.json({ emailVerified: !!DATA.voterEmailBySid[sid], emailRequired: !!EMAIL_REQUIRED });
});

/* ---------- Routes API existantes ---------- */
app.get('/api/health', (req,res)=>{
  res.json({ ok:true, pow_bits: POW_BITS, today: todayStr(), demo: DEMO, turnstile: !!TURNSTILE_SECRET, vote_policy: VOTE_POLICY, email_required: !!EMAIL_REQUIRED });
});
app.get('/api/candidates', (req,res)=> res.json(candidates));
app.get('/api/results', (req,res)=>{
  const total = Object.values(DATA.votes).reduce((a,b)=>a+b,0);
  const results = candidates.map(c=>{
    const v = DATA.votes[c.id] || 0;
    const percent = total ? Math.round(v*1000/total)/10 : 0;
    return { id:c.id, name:c.name, votes:v, percent, color:c.color };
  });
  const maxVotes = results.reduce((m, r) => Math.max(m, r.votes), 0);
  const leaders  = maxVotes > 0 ? results.filter(r => r.votes === maxVotes) : [];
  const leader   = leaders.length === 1 ? leaders[0] : null;
  res.json({ total, leader, isTie: leaders.length > 1, leaders, results });
});
app.get('/api/pow', (req,res)=> res.json({ challenge: makeChallenge(req), bits: POW_BITS }));

// IMPORTANT: ordre des protections = limites IP/session -> Turnstile -> anti‑replay -> PoW -> Email requirement -> Politique REPLACE
app.post('/api/vote', checkLimits, verifyTurnstile, verifyReplay, (req,res)=>{
  try{
    const { candidateId, pow } = req.body || {};
    if (!Number.isInteger(candidateId)) return res.status(400).json({ error:'candidateId invalide' });
    if (!candidates.find(c => c.id === candidateId)) return res.status(404).json({ error:'Candidat inconnu' });
    if (!verifyPowPayload(pow)) return res.status(400).json({ error:'Preuve de travail invalide' });

    const sid = ensureSession(req, res);

    // Exiger email vérifié si demandé
    if (EMAIL_REQUIRED && !DATA.voterEmailBySid[sid]) {
      return res.status(403).json({ error:'Vérifiez votre email avant de voter.' });
    }

    const voterId = getVoterId(req, sid);      // emailHash si dispo; sinon session+UA
    const prev = DATA.voterChoices[voterId];   // parti précédent

    if (prev && prev !== candidateId) {
      // Politique REPLACE: on décrémente l'ancien et on incrémente le nouveau
      if (DATA.votes[prev] && DATA.votes[prev] > 0) DATA.votes[prev] -= 1;
      DATA.votes[candidateId] = (DATA.votes[candidateId] || 0) + 1;
      DATA.voterChoices[voterId] = candidateId;
      saveData(DATA);
      console.log('[VOTE SWITCH]', { ip:getClientIp(req), from: prev, to: candidateId });
      return res.json({ ok: true, switched: true });
    }

    if (!prev) {
      DATA.votes[candidateId] = (DATA.votes[candidateId] || 0) + 1;
      DATA.voterChoices[voterId] = candidateId;
      saveData(DATA);
      console.log('[VOTE OK]', { ip:getClientIp(req), candidateId, total: DATA.votes[candidateId] });
      return res.json({ ok: true, first: true });
    }

    // Revoter pour le même parti = no‑op
    return res.json({ ok: true, duplicate: true });
  }catch(e){
    console.error('[VOTE ERR]', e);
    res.status(500).json({ error:'Erreur serveur' });
  }
});

/* ---------- Boot ---------- */
app.listen(PORT, ()=>console.log(`Serveur prêt sur port ${PORT}`));
