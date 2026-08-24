/**
 * Voix du Québec — Sondage provincial
 * Express + anti-spam + persistance JSON (tallies.json)
 * Auth Google supprimée : vote sans login
 * Politique: REPLACE (on peut changer d'avis)
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

/* ---------- Config ---------- */
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const USING_HTTPS = /^https:\/\//i.test(BASE_URL);

const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-session-secret';
const SESSION_COOKIE = process.env.SESSION_COOKIE || 'v_sid';
const TZ = process.env.TZ || 'America/Toronto';
const DEMO = process.env.DEMO_MODE === '1';

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
const VOTE_POLICY = 'REPLACE';

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser(SESSION_SECRET));

/* ---------- Redirections 301 (SEO) ---------- */
/* IMPORTANT: placer AVANT le static et les autres routes */
const REDIRECTS = new Map([
  ['/transparence',  '/'],
  ['/resultats',     '/stats'],
  ['/methodologie',  '/']
]);

app.use((req, res, next) => {
  const dest = REDIRECTS.get(req.path);
  if (dest) return res.redirect(301, dest);
  next();
});

/* ---------- robots.txt & noindex sur /recherche ---------- */
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /recherche'
  ].join('\n'));
});

app.use('/recherche', (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

/* ---------- Static ---------- */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ---------- Persistance JSON ---------- */
const DATA_FILE = path.join(__dirname, 'tallies.json');
function loadData(){
  try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf-8')); }
  catch { return { votes:{}, voterChoices:{} }; }
}
function saveData(data){ fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); }
let DATA = loadData();
if (!DATA.votes) DATA.votes = {};
if (!DATA.voterChoices) DATA.voterChoices = {};

/* ---------- Candidats ---------- */
const candidates = [
  { id:1, name:'Coalition Avenir Québec', leader:'Christine Fréchette', role:'cheffe', color:'#00a8e7ff' },
  { id:2, name:'Parti Québécois', leader:'Paul St-Pierre Plamondon', role:'chef', color:'#1b4db3' },
  { id:3, name:'Parti libéral du Québec', leader:'Charles Milliard', role:'chef', color:'#d32f2f' },
  { id:4, name:'Québec solidaire', leader:'Ruba Ghazal', role:'cheffe', color:'#f36f21' },
  { id:5, name:'Parti conservateur du Québec', leader:'Éric Duhaime', role:'chef', color:'#1d2e6e' },
  { id:6, name:'Parti vert du Québec', leader:'Alex Tyrrell', role:'chef', color:'#2e7d32' },
];

for (const c of candidates) if (!DATA.votes[c.id]) DATA.votes[c.id] = 0;
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

function ensureLightSession(req,res){
  let sid = req.signedCookies[SESSION_COOKIE];
  if (!sid){
    sid = crypto.randomBytes(16).toString('hex');
    res.cookie(SESSION_COOKIE, sid, {
      httpOnly:true, sameSite:'lax',
      secure: USING_HTTPS,
      signed:true, maxAge: 1000*60*60*24*365
    });
  }
  return sid;
}

function getFallbackVoterId(req, sid){
  const ua = (req.get('user-agent') || '').slice(0,256);
  return crypto.createHmac('sha256', SESSION_SECRET).update(`${sid}::${ua}`).digest('hex');
}

function talliesFromVoterChoices(voterChoices){
  const t = {};
  for (const c of Object.values(voterChoices || {})){
    if (Number.isInteger(c)) t[c] = (t[c] || 0) + 1;
  }
  return t;
}

/* ---------- Anti-replay (nonce + ts) ---------- */
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

/* ---------- Limites anti-spam ---------- */
const ipBuckets = new Map();      // ip -> {windowStart,count10m,day,countDay}
const sessionBuckets = new Map(); // sid -> {lastVoteTs,day,countDay}
const MIN_INTERVAL_MS     = DEMO ? 3000  : 60000; // 1 min / session
const SESSION_MAX_PER_DAY = DEMO ? 1000  : 10;
const IP_MAX_10MIN        = DEMO ? 1000  : 5;
const IP_MAX_PER_DAY      = DEMO ? 5000  : 100;

function checkLimits(req,res,next){
  const now = Date.now();
  const ip  = getClientIp(req);
  const sid = ensureLightSession(req,res);

  const ipEntry = ipBuckets.get(ip) || { windowStart: now, count10m:0, day: todayStr(), countDay:0 };
  if (now - ipEntry.windowStart > 10*60*1000){ ipEntry.windowStart = now; ipEntry.count10m = 0; }
  if (ipEntry.day !== todayStr()){ ipEntry.day = todayStr(); ipEntry.countDay = 0; }
  ipEntry.count10m++; ipEntry.countDay++; ipBuckets.set(ip, ipEntry);
  if (ipEntry.count10m > IP_MAX_10MIN) return res.status(429).json({ error:'Trop de votes IP (10 min)' });
  if (ipEntry.countDay  > IP_MAX_PER_DAY) return res.status(429).json({ error:'Quota quotidien IP atteint' });

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

/* ---------- API ---------- */
app.get('/api/health', (req,res)=>{
  res.json({
    ok:true, today: todayStr(), demo: DEMO,
    turnstile: !!TURNSTILE_SECRET, vote_policy: VOTE_POLICY
  });
});

app.get('/api/candidates', (req,res)=> res.json(candidates));

app.get('/api/results', (req,res)=>{
  const recomputed = talliesFromVoterChoices(DATA.voterChoices);

  const total = Object.values(recomputed).reduce((a,b)=>a+b,0);
  const results = candidates.map(c=>{
    const v = recomputed[c.id] || 0;
    const percent = total ? Math.round(v*1000/total)/10 : 0;
    return { id:c.id, name:c.name, votes:v, percent, color:c.color };
  });

  const maxVotes = results.reduce((m, r) => Math.max(m, r.votes), 0);
  const leaders  = maxVotes > 0 ? results.filter(r => r.votes === maxVotes) : [];
  const leader   = leaders.length === 1 ? leaders[0] : null;

  res.json({ total, leader, isTie: leaders.length > 1, leaders, results });
});

// Ordre: quotas -> captcha -> anti-replay -> REPLACE
app.post('/api/vote', checkLimits, verifyTurnstile, verifyReplay, (req,res)=>{
  try{
    const { candidateId } = req.body || {};
    if (!Number.isInteger(candidateId)) return res.status(400).json({ error:'candidateId invalide' });
    if (!candidates.find(c => c.id === candidateId)) return res.status(404).json({ error:'Candidat inconnu' });

    const sid = ensureLightSession(req, res);
    const voterId = getFallbackVoterId(req, sid);
    const prev = DATA.voterChoices[voterId];

    const candObj = candidates.find(c => c.id === candidateId);

    if (prev && prev !== candidateId) {
      if (DATA.votes[prev] && DATA.votes[prev] > 0) DATA.votes[prev] -= 1;
      DATA.votes[candidateId] = (DATA.votes[candidateId] || 0) + 1;
      DATA.voterChoices[voterId] = candidateId;
      saveData(DATA);
      return res.json({ ok: true, switched: true, choice: { id: candObj.id, name: candObj.name, color: candObj.color } });
    }

    if (!prev) {
      DATA.votes[candidateId] = (DATA.votes[candidateId] || 0) + 1;
      DATA.voterChoices[voterId] = candidateId;
      saveData(DATA);
      return res.json({ ok: true, first: true, choice: { id: candObj.id, name: candObj.name, color: candObj.color } });
    }

    // même parti = no-op
    return res.json({ ok: true, duplicate: true, choice: { id: candObj.id, name: candObj.name, color: candObj.color } });
  }catch(e){
    console.error('[VOTE ERR]', e);
    res.status(500).json({ error:'Erreur serveur' });
  }
});

/* ---------- 404 propre ---------- */
app.use((req, res) => {
  res.status(404).send('Page non trouvée');
});

/* ---------- Boot ---------- */
const http = require('http');
const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`Serveur prêt sur ${process.env.BASE_URL || `http://${HOST}:${PORT}`}`);
});
