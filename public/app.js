(() => {
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  let chart;

  // ===== CSS vars (pour les labels dessinés dans le canvas) =================
  const cssVar = (name, fb=null) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  const PIE_LABEL_COLOR = () => cssVar('--pie-label-color', '#fff');

  // Taille responsive: se base sur la largeur réelle du canvas
  const PIE_LABEL_SIZE = (chart) => {
    const base = parseFloat(cssVar('--pie-label-font-size', '16')) || 16;
    const w = chart?.canvas?.clientWidth || chart?.width || 460;

    // 320px -> ~12px ; 720px -> base (ex: 25)
    const scaled = Math.round((w / 720) * base);
    return Math.max(11, Math.min(base, scaled));
  };

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

  // ===== Nonce pour anti-replay =============================================
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

  // leader/role viennent idéalement du backend
  const leader = (c.leader && c.leader.trim()) || extractLeader(c.name);

  // role: "intérim", "co-porte-parole", etc.
  const role = (c.role && String(c.role).trim())
    ? ` <span class="role">(${String(c.role).trim()})</span>`
    : '';

  const display = leader
   ? `<strong>${acro}</strong> ${leader}<span class="role">(${String(c.role).trim()})</span>`
  : `<strong>${acro}</strong>`;
  
  const label = document.createElement('label');
  label.className='candidate';

  // tooltip: nom complet + rôle (si dispo)
  label.title = c.name + (c.role ? ` (${c.role})` : '');

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

  // ===== Labels dans les tranches (responsive) ===============================
  // Desktop: "12.3% PQ"
  // Mobile:  "12.3%" (pour éviter les débordements)
  const sliceLabels = {
    id:'sliceLabels',
    afterDatasetsDraw(chart){
      const {ctx}=chart, ds=chart.data?.datasets?.[0];
      if(!ds) return;

      const meta  = chart.getDatasetMeta(0);
      const total = (ds.data||[]).reduce((a,b)=>a+Number(b||0),0)||0;
      if (!total) return;

      const w = chart.canvas?.clientWidth || chart.width || 0;
      const isMobile = w > 0 && w < 420;
      const minPct = isMobile ? 6 : 3;

      ctx.save();
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.font = `700 ${PIE_LABEL_SIZE(chart)}px ui-sans-serif,system-ui`;

      meta.data.forEach((arc,i)=>{
        const v = Number(ds.data[i]||0); if(!v) return;
        const pct = v/total*100;
        if (pct < minPct) return;

        const {x,y,startAngle,endAngle,outerRadius} = arc;
        const a = (startAngle+endAngle)/2;

        // plus proche du centre sur mobile pour limiter débordements
        const r = outerRadius * (isMobile ? 0.58 : 0.68);

        const lx = x + Math.cos(a)*r;
        const ly = y + Math.sin(a)*r;

        const label = isMobile
          ? `${pct.toFixed(1)}%`
          : `${pct.toFixed(1)}% ${partyAcronym(chart.data.labels[i]||'')}`;

        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,.35)';
        ctx.fillStyle   = PIE_LABEL_COLOR();
        ctx.strokeText(label, lx, ly);
        ctx.fillText(label, lx, ly);
      });

      ctx.restore();
    }
  };

  // ===== Donut épais + "pop" au survol (mobile friendly) =====================
  function drawPie(data){
    const c = document.getElementById('chart'); if (!c) return;

    const labels = data.results.map(r=>r.name);
    const values = data.results.map(r=>r.votes);
    const colors = data.results.map(r=>r.color || pickColor(r.name));

    const isMobile = (c.clientWidth || 0) < 420;

    if (chart) chart.destroy();

    chart = new Chart(c.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: '#fff',
          borderWidth: 2,
          hoverOffset: isMobile ? 6 : 12,
          spacing: 2,
          radius: '96%',
        }]
      },
      options: {
        responsive: true,
        cutout: '38%',
        layout: { padding: 4 },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            callbacks: {
              title: () => null,
              label: (ctx) => {
                const total = ctx.dataset.data.reduce((a,b)=>a+Number(b||0),0) || 0;
                const v = Number(ctx.raw||0);
                const pct = total ? (v*100/total) : 0;
                const acro = partyAcronym(ctx.label || '');
                return `${acro} : ${v} votes (${pct.toFixed(1)}%)`;
              }
            }
          }
        },
        animation: { duration: 500 },
        onHover: (evt, els) => {
          evt.native.target.style.cursor = els?.length ? 'pointer' : 'default';
        }
      },
      plugins: [sliceLabels]
    });
  }

  // ===== Refresh global ======================================================
  async function refresh() {
    const cands = await fetchJSON('/api/candidates');
    renderCandidates(cands);

    const data = await fetchJSON('/api/results');
    data.results = data.results.map(r=>({ ...r, color:r.color||pickColor(r.name) }));
    renderTable(data.results);
    drawPie(data);
  }

  // ===== Vote (anti-replay + Turnstile optionnel) ============================
  async function vote(ev){
    ev.preventDefault();
    const s=$$('input[name="candidate"]').find(x=>x.checked);
    const msg=$('#msg');
    if(!s) return;

    try{
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
      await fetchJSON('/api/vote', { method:'POST', body: JSON.stringify(payload) });

      if (msg) msg.textContent='Merci! Vote enregistré.';
      await refresh();
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

  // ===== Boot ================================================================
  document.addEventListener('DOMContentLoaded', async ()=>{
    try{
      await waitForChart();

      const f=$('#vote-form'); if(f) f.addEventListener('submit', vote);

      await refresh();
      setInterval(refresh,30000);

      // Redessine bien au changement d’orientation / resize
      window.addEventListener('resize', () => { if (chart) chart.update(); });
    }catch(e){
      console.error(e);
      const msg=$('#msg'); if(msg) msg.textContent=e.message;
    }
  });
})();
