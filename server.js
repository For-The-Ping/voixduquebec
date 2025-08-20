/**
 * Voix du Québec — Sondage provincial (Express + PoW + limites)
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-session-secret';
const SESSION_COOKIE = process.env.SESSION_COOKIE || 'v_sid';
const POW_BITS = Number(process.env.POW_BITS || 18);      // difficulté PoW
const TZ = process.env.TZ || 'America/Toronto';
const DEMO = process.env.DEMO_MODE === '1';               // démo = limites très larges

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ---------- Persistance simple (JSON) ---------- */
const DATA_FILE = path.join(__dirname, 'tallies.json');
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return { votes: {} }; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
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
// init votes manquants
for (const c of candidates) if (!DATA.votes[c.id]) DATA.votes[c.id] = 0;
saveData(DATA);

/* ---------- Helpers ---------- */
function todayStr(){ return DateTime.now().setZone(TZ).toISODate(); }
function getClientIp(req){
  let ip = req.ip || '';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || '0.0.0.0';
}
function ensureSession(req, res){
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
  return crypto.randomBytes(16).toString('hex') + ':' + sid; // lié à la session
}

/* ---------- Limites anti‑spam (mémoire) ---------- */
const ipBuckets = new Map();      // ip -> {windowStart,count10m,day,countDay}
const sessionBuckets = new Map(); // sid -> {lastVoteTs,day,countDay}
const MIN_INTERVAL_MS     = DEMO ? 3000  : 60000;  // 3s démo / 60s normal
const SESSION_MAX_PER_DAY = DEMO ? 1000  : 10;
const IP_MAX_10MIN        = DEMO ? 1000  : 5;
const IP_MAX_PER_DAY      = DEMO ? 5000  : 100;

function checkLimits(req,res,next){
  const now = Date.now();
  const ip  = getClientIp(req);
  const sid = ensureSession(req,res);

  // IP window
  const ipEntry = ipBuckets.get(ip) || { windowStart: now, count10m:0, day: todayStr(), countDay:0 };
  if (now - ipEntry.windowStart > 10*60*1000){ ipEntry.windowStart = now; ipEntry.count10m = 0; }
  if (ipEntry.day !== todayStr()){ ipEntry.day = todayStr(); ipEntry.countDay = 0; }
  ipEntry.count10m++; ipEntry.countDay++; ipBuckets.set(ip, ipEntry);
  if (ipEntry.count10m > IP_MAX_10MIN) return res.status(429).json({ error:'Trop de votes IP (10 min)' });
  if (ipEntry.countDay  > IP_MAX_PER_DAY) return res.status(429).json({ error:'Quota quotidien IP atteint' });

  // Session window
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

/* ---------- Routes ---------- */
app.get('/api/health', (req,res)=>{
  res.json({ ok:true, pow_bits: POW_BITS, today: todayStr(), demo: DEMO });
});

app.get('/api/candidates', (req,res)=> res.json(candidates));

app.get('/api/results', (req,res)=>{
  const total = Object.values(DATA.votes).reduce((a,b)=>a+b,0);
  const results = candidates.map(c=>{
    const v = DATA.votes[c.id] || 0;
    const percent = total ? Math.round(v*1000/total)/10 : 0;
    return { id:c.id, name:c.name, votes:v, percent, color:c.color };
  });
  const leader = results.reduce((acc,r)=>(acc && acc.votes>r.votes)?acc:r, null);
  res.json({ total, leader, results });
});

app.get('/api/pow', (req,res)=>{
  res.json({ challenge: makeChallenge(req), bits: POW_BITS });
});

app.post('/api/vote', checkLimits, (req,res)=>{
  try{
    const { candidateId, pow } = req.body || {};
    if (!Number.isInteger(candidateId)) return res.status(400).json({ error:'candidateId invalide' });
    const cand = candidates.find(c => c.id === candidateId);
    if (!cand) return res.status(404).json({ error:'Candidat inconnu' });

    if (!verifyPowPayload(pow)) return res.status(400).json({ error:'Preuve de travail invalide' });

    DATA.votes[candidateId] = (DATA.votes[candidateId] || 0) + 1;
    saveData(DATA);

    console.log('[VOTE OK]', { ip:getClientIp(req), candidateId, total: DATA.votes[candidateId] });
    res.json({ ok:true });
  }catch(e){
    console.error('[VOTE ERR]', e);
    res.status(500).json({ error:'Erreur serveur' });
  }
});

/* ---------- Boot ---------- */
app.listen(PORT, ()=>console.log(`Serveur prêt sur port ${PORT}`));
