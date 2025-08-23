(() => {
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  let chart;

  // ===== CSS vars (pour les labels dessinés dans le canvas) =================
  const cssVar = (name, fb=null) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  const PIE_LABEL_COLOR = () => cssVar('--pie-label-color', '#fff');
  const PIE_LABEL_SIZE  = () => parseFloat(cssVar('--pie-label-font-size', '16')) || 16;

  // ===== Couleurs de partis (fallback) ======================================
  const PARTY_COLORS = [
    { test:/coalition avenir québec|caq/i,               color:'#0aa2c0' },
    { test:/parti québécois|pq|plamondon/i,              color:'#1b4db3' },
    { test:/parti libéral du québec|plq/i,               color:'#d32f2f' },
    { test:/québec solidaire|qs/i,                       color:'#f36f21' },
    { test:/parti conservateur du québec|pcq|duhaime/i,  color:'#1d2e6e' },
    { test:/parti vert du québec|pvq/i,                  color:'#2e7d32' }
  ];
  const pickColor = (name, fb='#888') =>
    (PARTY_COLORS.find(p=>p.test.test(name))?.color || fb);

  // ===== Nonce pour anti‑replay =============================================
  function makeNonce(){
    if (crypto.randomUUID) return crypto.randomUUID();
    const a=new Uint8Array(16); crypto.getRandomValues(a);
    return Array.from(a).map(x=>x.toString(16).padStart(2,'0')).join('');
  }

  // ===== ACRONYME + chef pour la liste de vote (droite) =====================
  const partyAcronym = (name) => {
    const map = [
      { re:/coalition avenir québec|caq/i, ac:'CAQ' }, { re:/parti québécois|pq/i, ac:'PQ' },
      { re:/parti libéral du québec|plq/i, ac:'PLQ' }, { re:/québec solidaire|qs/i, ac:'QS' },
      { re:/parti conservateur du québec|pcq/i, ac:'PCQ'}, { re:/parti vert du québec|pvq/i, ac:'PVQ' }
    ];
    const hit = map.find(m=>m.re.test(name)); if (hit) return hit.ac;
    return name.replace(/[()]/g,'').split(/\s+/)
      .filter(w=>w.length>=3&&!/^(de|du|des|la|le|les|et)$/i.test(w))
      .map(w=>w[0].toUpperCase()).slice(0,4).join('');
  };
  const extractLeader = (name) => (name.match(/\(([^)]+)\)/)?.[1] || '').trim();

  // ===== Fetch JSON helper (robuste) ========================================
  async function fetchJSON(url, opts={}){
    const r = await fetch(url, { headers:{'Content-Type':'application/json'}, ...opts });
    if (!r.ok){
      const t = await r.text();
      try { throw new Error(JSON.parse(t).error || t); }
      catch { throw new Error(t); }
    }
    return r.json();
  }

  // ===== Rendu liste de vote (droite) =======================================
  function renderCandidates(list){
    const wrap = $('#candidate-list'); if (!wrap) return;
    wrap.innerHTML='';

    list.forEach(c=>{
      const color  = c.color || pickColor(c.name);
      const acro   = partyAcronym(c.name);
      const leader = (c.leader && c.leader.trim()) || extractLeader(c.name);
      const display = leader ? `<strong>${acro}</strong> ${leader}` : acro;

      const label = document.createElement('label');
      label.className='candidate';
      label.title = c.name; // tooltip : nom complet
      label.innerHTML = `
        <span class="dot" style="--dot:${color}"></span>
        <input type="checkbox" name="candidate" value="${c.id}" />
        <span class="cand-name">${display}</span>`;
      wrap.appendChild(label);
    });

    // Un seul choix
    wrap.addEventListener('change', e=>{
      if (e.target && e.target.name==='candidate' && e.target.checked){
        $$('input[name="candidate"]').forEach(x=>{ if(x!==e.target) x.checked=false; });
      }
    });
  }

  // ===== Tableau des résultats (noms complets) ==============================
  function renderTable(res){
    const m=$('#results-table'); if (!m) return;
    m.innerHTML='';
    const t=document.createElement('table'); t.className='table';
    t.innerHTML = `<thead><tr><th>Parti / Candidat</th><th>Votes</th><th>%</th></tr></thead>
      <tbody>${res.map(r=>`
        <tr>
          <td><span class="dot" style="--dot:${r.color||pickColor(r.name)}"></span> ${r.name}</td>
          <td>${r.votes}</td><td>${(r.percent??0).toFixed(1)}%</td>
        </tr>`).join('')}</tbody>`;
    m.appendChild(t);
  }

  // ===== Labels blancs au centre des parts ==================================
  const sliceLabels = {
    id:'sliceLabels',
    afterDatasetsDraw(chart){
      const {ctx}=chart, ds=chart.data?.datasets?.[0];
      if(!ds) return;
      const meta  = chart.getDatasetMeta(0);
      const total = (ds.data||[]).reduce((a,b)=>a+Number(b||0),0)||0;

      ctx.save();
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.font = `700 ${PIE_LABEL_SIZE()}px ui-sans-serif,system-ui`;

      meta.data.forEach((arc,i)=>{
        const v = Number(ds.data[i]||0); if(!v||!total) return;
        const pct = v/total*100;
        if (pct < 3) return; // évite les micro-tranches illisibles

        const {x,y,startAngle,endAngle,outerRadius} = arc;
        const a = (startAngle+endAngle)/2;
        const r = outerRadius*0.62;
        const label = `${pct.toFixed(1)}% ${partyAcronym(chart.data.labels[i]||'')}`;
        const lx = x + Math.cos(a)*r, ly = y + Math.sin(a)*r;

        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,.35)';
        ctx.fillStyle   = PIE_LABEL_COLOR();
        ctx.strokeText(label, lx, ly);
        ctx.fillText(label, lx, ly);
      });
      ctx.restore();
    }
  };

  // ===== Camembert (sans légende) ============================================
  function drawPie(data){
    const c = $('#chart'); if (!c) return;
    const labels = data.results.map(r=>r.name);
    const values = data.results.map(r=>r.votes);
    const colors = data.results.map(r=>r.color||pickColor(r.name));

    if (chart) chart.destroy();

    chart = new Chart(c.getContext('2d'), {
      type: 'pie',
      data: { labels, datasets:[{ data: values, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true }
        }
      },
      plugins: [sliceLabels]
    });
  }

  // ===== "Vote actuel" (UI) ==================================================
  const currentVoteEl   = document.getElementById('current-vote');
  const currentVoteDot  = document.getElementById('current-vote-dot');
  const currentVoteAcr  = document.getElementById('current-vote-acronym');

  function renderCurrentVote(vote) {
    if (!currentVoteEl) return;
    if (!vote) {
      currentVoteEl.hidden = false;
      if (currentVoteDot) currentVoteDot.style.background = '#bbb';
      if (currentVoteAcr) currentVoteAcr.textContent = 'aucun vote enregistré';
      return;
    }
    currentVoteEl.hidden = false;
    const name = vote.name || '';
    const color = vote.color || pickColor(name);
    if (currentVoteDot) currentVoteDot.style.background = color;
    if (currentVoteAcr) currentVoteAcr.textContent = partyAcronym(name);
  }

  async function loadMyVoteIfConnected() {
    try {
      const me = await fetchJSON('/api/me');
      const loginBtn  = $('#loginBtn');
      const logoutBtn = $('#logoutBtn');

      if (loginBtn && logoutBtn) {
        if (me.authenticated) {
          loginBtn.style.display  = 'none';
          logoutBtn.style.display = 'inline-flex';
        } else {
          loginBtn.style.display  = 'inline-flex';
          logoutBtn.style.display = 'none';
        }
      }

      if (!me.authenticated) {
        if (currentVoteEl) currentVoteEl.hidden = true; // cache si non connecté
        return;
      }

      const data = await fetchJSON('/api/myvote');
      if (data && data.authenticated) {
        renderCurrentVote(data.vote || null);
      } else {
        if (currentVoteEl) currentVoteEl.hidden = true;
      }
    } catch {
      if (currentVoteEl) currentVoteEl.hidden = true;
    }
  }

  // ===== Refresh global =====================================================
  async function refresh(options = {}) {
    const { currentChoice } = options;

    const cands = await fetchJSON('/api/candidates');
    renderCandidates(cands);

    const data = await fetchJSON('/api/results');
    data.results = data.results.map(r=>({ ...r, color:r.color||pickColor(r.name) }));
    renderTable(data.results);
    drawPie(data);

    if (currentChoice) {
      renderCurrentVote(currentChoice);
    } else {
      await loadMyVoteIfConnected();
    }
  }

  // ===== Auth UI ============================================================
  async function logout(){
    await fetch('/auth/logout', { method:'POST' });
    await loadMyVoteIfConnected();
  }

  // ===== Vote (anti‑replay + Turnstile optionnel) ============================
  async function vote(ev){
    ev.preventDefault();
    const s=$$('input[name="candidate"]').find(x=>x.checked);
    const msg=$('#msg');
    if(!s) return;

    try{
      const me = await fetchJSON('/api/me');
      if (me.oauthRequired && !me.authenticated) {
        if (msg) msg.textContent = 'Connectez‑vous avec Google avant de voter.';
        return;
      }

      const payload = {
        candidateId: Number(s.value),
        nonce: makeNonce(),
        ts: Date.now()
      };

      // Turnstile si présent
      if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
        try { payload.cf_turnstile_response = window.turnstile.getResponse(); } catch {}
      }

      if (msg) msg.textContent='Envoi…';
      const resp = await fetchJSON('/api/vote', { method:'POST', body: JSON.stringify(payload) });

      if (msg) msg.textContent='Merci! Vote enregistré.';
      await refresh({ currentChoice: resp && resp.choice ? resp.choice : null });
    }catch(e){
      if (msg) {
        const m = (e && e.message) ? String(e.message) : 'Erreur lors du vote.';
        try { msg.textContent = JSON.parse(m).error || m; } catch { msg.textContent = m; }
      }
    }
  }

  // ===== Attendre que Chart.js soit chargé ============================
  async function waitForChart(maxMs=3000){
    const t0=performance.now();
    while(typeof window.Chart==='undefined'){
      if(performance.now()-t0>maxMs) throw new Error('Chart.js non chargé — vérifie /vendor/chart.umd.js');
      await new Promise(r=>setTimeout(r,50));
    }
  }

  // ===== Petit effet ripple sur les boutons auth =============================
  function attachRipple(el){
    if (!el) return;
    el.addEventListener('click', () => {
      el.classList.remove('is-rippling'); el.offsetWidth; // reflow
      el.classList.add('is-rippling');
      setTimeout(()=> el.classList.remove('is-rippling'), 500);
    });
  }

  // ===== Boot ================================================================
  document.addEventListener('DOMContentLoaded', async ()=>{
    try{
      await waitForChart();

      const f=$('#vote-form'); if(f) f.addEventListener('submit', vote);
      const lg = $('#loginBtn');  if (lg) { lg.addEventListener('click', ()=> location.href='/auth/google'); attachRipple(lg); }
      const lo = $('#logoutBtn'); if (lo) { lo.addEventListener('click', (e)=>{ e.preventDefault(); logout(); }); attachRipple(lo); }

      await refresh();
      setInterval(refresh,30000);
    }catch(e){
      console.error(e);
      const msg=$('#msg'); if(msg) msg.textContent=e.message;
    }
  });
})();
