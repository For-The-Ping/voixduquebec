(() => {
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  let chart;

  // Couleurs fallback si le backend n'en renvoie pas
  const PARTY_COLORS = [
    { test:/coalition avenir québec|caq/i,               color:'#0aa2c0' },
    { test:/parti québécois|pq|plamondon/i,              color:'#1b4db3' },
    { test:/parti libéral du québec|plq/i,               color:'#d32f2f' },
    { test:/québec solidaire|qs/i,                       color:'#f36f21' },
    { test:/parti conservateur du québec|pcq|duhaime/i,  color:'#1d2e6e' },
    { test:/parti vert du québec|pvq/i,                  color:'#2e7d32' }
  ];
  const pickColor = (name, fb='#888') => (PARTY_COLORS.find(p=>p.test.test(name))?.color || fb);

  const partyAcronym = (name) => {
    const map = [
      { re:/coalition avenir québec|caq/i, ac:'CAQ' }, { re:/parti québécois|pq/i, ac:'PQ' },
      { re:/parti libéral du québec|plq/i, ac:'PLQ' }, { re:/québec solidaire|qs/i, ac:'QS' },
      { re:/parti conservateur du québec|pcq/i, ac:'PCQ'}, { re:/parti vert du québec|pvq/i, ac:'PVQ' }
    ];
    const hit = map.find(m=>m.re.test(name)); if (hit) return hit.ac;
    return name.replace(/[()]/g,'').split(/\s+/).filter(w=>w.length>=3&&!/^(de|du|des|la|le|les|et)$/i.test(w))
      .map(w=>w[0].toUpperCase()).slice(0,4).join('');
  };

  // extrait "Chef" si le nom contient "(Chef Nom)" ; sinon chaîne vide
  const extractLeader = (name) => (name.match(/\(([^)]+)\)/)?.[1] || '').trim();

  async function fetchJSON(url, opts={}){
    const r = await fetch(url, { headers:{'Content-Type':'application/json'}, ...opts });
    if (!r.ok){ const t=await r.text(); try{ throw new Error(JSON.parse(t).error||t) }catch{ throw new Error(t) } }
    return r.json();
  }

  function renderCandidates(list){
    const wrap = $('#candidate-list'); wrap.innerHTML='';
    list.forEach(c=>{
      const color = c.color || pickColor(c.name);
      const acro  = partyAcronym(c.name);
      const chief = extractLeader(c.name);
      const display = chief ? `${acro} — ${chief}` : acro;

      const label = document.createElement('label');
      label.className='candidate';
      label.title = c.name; // tooltip avec le nom complet
      label.innerHTML = `
        <span class="dot" style="--dot:${color}"></span>
        <input type="checkbox" name="candidate" value="${c.id}" />
        <span class="cand-name">${display}</span>`;
      wrap.appendChild(label);
    });

    // garde le comportement "un seul choix" même si checkboxes
    wrap.addEventListener('change', e=>{
      if (e.target && e.target.name==='candidate' && e.target.checked){
        $$( 'input[name="candidate"]' ).forEach(x=>{ if(x!==e.target) x.checked=false; });
      }
    });
  }

  function renderTable(res){
    const m=$('#results-table'); m.innerHTML='';
    const t=document.createElement('table'); t.className='table';
    t.innerHTML = `<thead><tr><th>Parti / Candidat</th><th>Votes</th><th>%</th></tr></thead>
      <tbody>${res.map(r=>`
        <tr>
          <td><span class="dot" style="--dot:${r.color||pickColor(r.name)}"></span> ${r.name}</td>
          <td>${r.votes}</td><td>${(r.percent??0).toFixed(1)}%</td>
        </tr>`).join('')}</tbody>`;
    m.appendChild(t);
  }

  // Plugin Chart.js : % + sigles
  const sliceLabels = {
    id:'sliceLabels',
    afterDatasetsDraw(chart){
      const {ctx}=chart, ds=chart.data.datasets[0];
      if(!ds) return; const meta=chart.getDatasetMeta(0), total=ds.data.reduce((a,b)=>a+b,0)||0;
      ctx.save(); ctx.fillStyle='#0b1220'; ctx.textAlign='center'; ctx.textBaseline='middle';
      meta.data.forEach((arc,i)=>{
        const v=Number(ds.data[i]||0); if(!v||!total) return; const pct=v/total*100; if(pct<3) return;
        const {x,y,startAngle,endAngle,outerRadius}=arc; const a=(startAngle+endAngle)/2; const r=outerRadius*0.62;
        ctx.font='700 12px ui-sans-serif,system-ui';
        ctx.fillText(`${pct.toFixed(1)}% ${partyAcronym(chart.data.labels[i]||'')}`, x+Math.cos(a)*r, y+Math.sin(a)*r);
      }); ctx.restore();
    }
  };

  function drawPie(data){
    const c=$('#chart'); const labels=data.results.map(r=>r.name);
    const values=data.results.map(r=>r.votes); const colors=data.results.map(r=>r.color||pickColor(r.name));
    if(chart) chart.destroy();
    chart=new Chart(c.getContext('2d'),{
      type:'pie',
      data:{ labels, datasets:[{ data:values, backgroundColor:colors, borderWidth:0 }] },
      options:{ responsive:true, plugins:{ legend:{display:true,position:'bottom'}, tooltip:{enabled:true} } },
      plugins:[sliceLabels]
    });
    const center=$('#center-label'); if(center) center.innerHTML='';
  }

  async function refresh(){
    const cands=await fetchJSON('/api/candidates'); renderCandidates(cands);
    const data=await fetchJSON('/api/results'); data.results=data.results.map(r=>({...r,color:r.color||pickColor(r.name)}));
    renderTable(data.results); drawPie(data);
    await updateAuthStatus();
  }

  // === PoW utils ===
  async function sha256Hex(s){ const b=new TextEncoder().encode(s); const d=await crypto.subtle.digest('SHA-256',b);
    return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,'0')).join(''); }
  function countLeadingZeroBitsFromHex(hex){ let bits=0; for(let i=0;i<hex.length;i++){ const n=parseInt(hex[i],16);
    if(n===0){bits+=4;continue} for(let j=3;j>=0;j--){ if(((n>>j)&1)===0) bits++; else return bits } } return bits; }
  async function solvePow(ch,bits){ let n=0; while(true){ const h=await sha256Hex(`${ch}:${n}`);
    if(countLeadingZeroBitsFromHex(h)>=bits) return n; n++; } }

  // Anti‑replay: nonce
  function makeNonce(){
    if (crypto.randomUUID) return crypto.randomUUID();
    const a=new Uint8Array(16); crypto.getRandomValues(a);
    return Array.from(a).map(x=>x.toString(16).padStart(2,'0')).join('');
  }

  // Ripple util pour les boutons auth
  function attachRipple(el){
    if (!el) return;
    el.addEventListener('click', () => {
      el.classList.remove('is-rippling');
      // force reflow pour relancer l’animation si clics rapprochés
      // eslint-disable-next-line no-unused-expressions
      el.offsetWidth;
      el.classList.add('is-rippling');
      setTimeout(()=> el.classList.remove('is-rippling'), 500);
    });
  }

  // === OAuth UI ===
  async function updateAuthStatus(){
    try{
      const me = await fetchJSON('/api/me');

      // Texte d’état global (si présent)
      const s = $('#auth-status');
      if (s) {
        if (me.authenticated) s.textContent = 'Connecté ✅';
        else if (me.oauthRequired) s.textContent = 'Connexion requise pour voter';
        else s.textContent = 'Connexion facultative';
      }

      // Boutons (plus de hint)
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

      return me;
    }catch{
      return { authenticated:false, oauthRequired:true };
    }
  }

  async function logout(){
    await fetch('/auth/logout', { method:'POST' });
    await updateAuthStatus();
  }

  // === Vote ===
  async function vote(ev){
    ev.preventDefault();
    const s=$$('input[name="candidate"]').find(x=>x.checked);
    const msg=$('#msg');

    // On enlève le message "Sélectionnez un parti." demandé
    if (!s) { return; }

    try{
      // UX : empêcher si OAuth requis et pas connecté
      const me = await fetchJSON('/api/me');
      if (me.oauthRequired && !me.authenticated) {
        msg.textContent = 'Connectez‑vous avec Google avant de voter.';
        return;
      }

      msg.textContent='Préparation (preuve de travail)…';
      const {challenge,bits}=await fetchJSON('/api/pow');
      const powNonce=await solvePow(challenge,bits);

      // Anti‑replay
      const nonce = makeNonce();
      const ts = Date.now();

      // Turnstile si présent
      let cfToken = null;
      if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
        try { cfToken = window.turnstile.getResponse(); } catch {}
      }

      msg.textContent='Envoi…';
      await fetchJSON('/api/vote', {
        method:'POST',
        body: JSON.stringify({
          candidateId: Number(s.value),
          pow: { challenge, nonce: powNonce },
          nonce, ts,
          ...(cfToken ? { cf_turnstile_response: cfToken } : {})
        })
      });

      msg.textContent='Merci! Vote enregistré (modifiable).';
      await refresh();
    }catch(e){
      msg.textContent=e.message||'Erreur lors du vote.';
    }
  }

  async function waitForChart(maxMs=3000){
    const t0=performance.now(); while(typeof window.Chart==='undefined'){
      if(performance.now()-t0>maxMs) throw new Error('Chart.js non chargé — vérifie /vendor/chart.umd.js');
      await new Promise(r=>setTimeout(r,50));
    }
  }

  document.addEventListener('DOMContentLoaded', async ()=>{
    try{
      await waitForChart();
      const f=$('#vote-form'); if(f) f.addEventListener('submit', vote);

      // Branchement correct sur les IDs HTML + ripple
      const lg = $('#loginBtn');
      if (lg) {
        lg.addEventListener('click', ()=> location.href='/auth/google');
        attachRipple(lg);
      }
      const lo = $('#logoutBtn');
      if (lo) {
        lo.addEventListener('click', logout);
        attachRipple(lo);
      }

      await refresh(); setInterval(refresh,30000);
    }catch(e){ console.error(e); const msg=$('#msg'); if(msg) msg.textContent=e.message; }
  });
})();
