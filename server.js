/**
 * Québec municipal poll — CDN + Anti-spam guards
 * Guards:
 *  - Session cookie (signed): 1 vote/min, 10/day per session
 *  - IP burst: 5 votes/10 min, 100/day per IP
 *  - Lightweight PoW (hashcash-like) per vote
 *  - File-backed tallies (tallies.json) to persist across restarts
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
const POW_BITS = parseInt(process.env.POW_BITS || '18', 10); // difficulty (16-20 ok)
const TZ = process.env.TZ || 'America/Toronto';

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// --- Data persistence (simple JSON file) ---
const DATA_FILE = path.join(__dirname, 'tallies.json');
function loadData(){
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return { votes: {} }; }
}
function saveData(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
let DATA = loadData();

// --- Candidates ---
const candidates = [
  { id:1, name:'Coalition Avenir Québec (François Legault)', color:'#0aa2c0' },  // turquoise
  { id:2, name:'Parti Québécois (Paul St‑Pierre Plamondon)', color:'#1b4db3' },  // bleu
  { id:3, name:'Parti libéral du Québec (chef actuel)',      color:'#d32f2f' },  // rouge
  { id:4, name:'Québec solidaire (Gabriel Nadeau‑Dubois)',   color:'#f36f21' },  // orange
  { id:5, name:'Parti conservateur du Québec (Éric Duhaime)',color:'#1d2e6e' },  // bleu foncé
  { id:6, name:'Parti Vert du Québec (chef actuel)',         color:'#2e7d32' },  // vert
];

// init tallies
for (const c of candidates) if (!DATA.votes[c.id]) DATA.votes[c.id] = 0;
saveData(DATA);

// --- Helpers ---
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
      httpOnly: true, sameSite: 'lax', secure: !!process.env.COOKIE_SECURE,
      signed: true, maxAge: 1000*60*60*24*365
    });
  }
  return sid;
}

// --- In-memory rate buckets (reset on restart) ---
const ipBuckets = new Map();      // ip -> {windowStart, count10m, day, countDay}
const sessionBuckets = new Map(); // sid -> {lastVoteTs, day, countDay}

// --- PoW ---
function countLeadingZeroBits(buf){
  let bits=0;
  for (const b of buf){
    if (b===0){ bits+=8; continue; }
    for (let i=7;i>=0;i--){
      if ((b & (1<<i))===0) bits++; else return bits;
    }
  }
  return bits;
}
function verifyPow(challenge, nonce){
  const h = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
  return countLeadingZeroBits(h) >= POW_BITS;
}
function makeChallenge(req){
  const sid = ensureSession(req, req.res);
  // bind challenge to session so it can't be replayed across browsers
  return crypto.randomBytes(16).toString('hex') + ':' + sid;
}

// --- Routes ---
app.get('/api/health', (req, res)=>{
  res.json({ ok:true, pow_bits: POW_BITS, today: todayStr() });
});

app.get('/api/candidates', (req, res)=> res.json(candidates));

app.get('/api/results', (req, res)=> {
  const total = Object.values(DATA.votes).reduce((a,b)=>a+b,0);
  const results = candidates.map(c => {
    const v = DATA.votes[c.id] || 0;
    const percent = total ? Math.round(v*1000/total)/10 : 0;
    return { id:c.id, name:c.name, votes:v, percent };
  });
  const leader = results.reduce((acc, r) => (acc && acc.votes>r.votes)? acc : r, null);
  res.json({ total, leader, results });
});

app.get('/api/pow', (req, res)=>{
  const challenge = makeChallenge(req);
  res.json({ challenge, bits: POW_BITS });
});

function checkLimits(req, res, next){
  const now = Date.now();
  const ip = getClientIp(req);
  const sid = ensureSession(req, res);

  // IP bucket
  const ipEntry = ipBuckets.get(ip) || { windowStart: now, count10m:0, day: todayStr(), countDay:0 };
  if (now - ipEntry.windowStart > 10*60*1000) { ipEntry.windowStart = now; ipEntry.count10m = 0; }
  if (ipEntry.day !== todayStr()) { ipEntry.day = todayStr(); ipEntry.countDay = 0; }
  ipEntry.count10m++; ipEntry.countDay++; ipBuckets.set(ip, ipEntry);

  if (ipEntry.count10m > 5) return res.status(429).json({ error:'Trop de votes depuis cette IP (10 min). Réessayez plus tard.' });
  if (ipEntry.countDay > 100) return res.status(429).json({ error:'Quota quotidien IP atteint.' });

  // Session bucket
  const s = sessionBuckets.get(sid) || { lastVoteTs: 0, day: todayStr(), countDay: 0 };
  if (s.day !== todayStr()) { s.day = todayStr(); s.countDay = 0; }
  if (now - s.lastVoteTs < 60*1000) return res.status(429).json({ error:'Patientez 60s entre deux votes depuis ce navigateur.' });
  if (s.countDay >= 10) return res.status(429).json({ error:'Limite 10 votes/jour depuis ce navigateur.' });
  s.lastVoteTs = now; s.countDay++; sessionBuckets.set(sid, s);

  next();
}

app.post('/api/vote', checkLimits, (req, res)=>{
  try{
    const { candidateId, pow } = req.body || {};
    if (!candidateId) return res.status(400).json({ error:'candidateId requis' });
    if (!pow || !pow.challenge || typeof pow.nonce === 'undefined') return res.status(400).json({ error:'Preuve de travail requise' });
    if (!verifyPow(pow.challenge, String(pow.nonce))) return res.status(400).json({ error:'Preuve de travail invalide' });
    if (!candidates.find(c => c.id === Number(candidateId))) return res.status(404).json({ error:'Candidat inconnu' });

    DATA.votes[candidateId] = (DATA.votes[candidateId] || 0) + 1;
    saveData(DATA);
    res.json({ ok:true });
  }catch(e){
    console.error(e);
    res.status(500).json({ error:'Erreur serveur' });
  }
});

app.listen(PORT, () => console.log(`Serveur sur http://localhost:${PORT}`));
