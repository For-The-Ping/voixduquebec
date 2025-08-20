(() => {
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  let chart;

  // ---- Couleurs fallback
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
  const extractLeader = (name) => {
    const m = name.match(/\(([^)]+)\)/);
    return m ? m[1].trim() : '';
  };

  async function fetchJSON(url, opts={}){
    const r = await fetch(url, { headers:{'Content-Type':'application/json'}, ...opts });
    if (!r.ok){
      const t = await r.text();
      try { throw new Error(JSON.parse(t).error || t); }
      catch { throw new Error(t); }
    }
    return r.json();
  }

  function renderCandidates(list){
    const wrap = $('#candidate-list'); 
    if (!wrap) return;
    wrap.innerHTML='';

    list.forEach(c=>{
      const color  = c.color || pickColor(c.name);
      const acro   = partyAcronym(c.name);
      const leader = (c.leader && c.leader.trim()) || extractLeader(c.name);
      const display = leader ? `${acro} ${leader}` : acro;

      const label = document.createElement('label');
      label.className='candidate';
      label.title = c.name;
      label.innerHTML = `
        <span class="dot" style="--dot:${color}"></span>
        <input type="checkbox" name="candidate" value="${c.id}" />
        <span class="cand-name">${display}</span>`;
      wrap.appendChild(label);
    });

    wrap.addEventListener('change', e=>{
      if (e.target && e.target.name==='candidate' && e.target.checked){
        $$('input[name="candidate"]').forEach(x=>{ if(x!==e.target) x.checked=false; });
      }
    });
  }

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

  const sliceLabels = {
    id:'sliceLabels',
    afterDatasetsDraw(chart){
      const {ctx}=chart, ds=chart.data.datasets[0];
      if(!ds) return; 
      const meta=chart.getDatasetMeta(0), total=ds.data.reduce((a,b)=>a+b,0)||0;
      ctx.save();
      ctx.fillStyle='#fff';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.font='700 16px ui-sans-serif,system-ui';
      meta.data.forEach((arc,i)=>{
        const v=Number(ds.data[i]||0); 
        if(!v||!total) return; 
        const pct=v/total*100; 
        if(pct<3) return;
        const {x,y,startAngle,endAngle,outerRadius}=arc;
        const a=(startAngle+endAngle)/2;
        const r=outerRadius*0.62;
        ctx.fillText(`${pct.toFixed(1)}% ${partyAcronym(chart.data.labels[i]||'')}`,
          x+Math.cos(a)*r, y+Math.sin(a)*r);
      });
      ctx.restore();
    }
  };

  function drawPie(data){
    const c=$('#chart'); if (!c) return;
    const labels=data.results.map(r=>r.name);
    const values=data.results.map(r=>r.votes);
    const colors=data.results.map(r=>r.color||pickColor(r.name));
    if(chart) chart.destroy();
    chart=new Chart(c.getContext('2d'),{
      type:'pie',
      data:{ labels, datasets:[{ data:values, backgroundColor:colors, borderWidth:0 }] },
      options:{ 
        responsive:true,
        layout: { padding: { left: 40, right: 40, top: 20, bottom: 20 } }, // centre mieux
        plugins:{ 
          legend:{
            display:true,
            position:'bottom',
            labels:{ font:{ size:14, weight:'600' } } // police plus grosse
          },
          tooltip:{enabled:true}
        }
      },
      plugins:[sliceLabels]
    });
  }

  async function refresh(){
    const cands = await fetchJSON('/api/candidates');
    renderCandidates(cands);

    const data = await fetchJSON('/api/results');
    data.results = data.results.map(r=>({ ...r, color:r.color||pickColor(r.name) }));
    renderTable(data.results);
    drawPie(data);

    // ---- Auth status minimal : on laisse toujours afficher "Pourquoi la connexion Google ?"
    await updateAuthStatus();
  }

  async function updateAuthStatus(){
    try{
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
      return me;
    }catch{
      return { authenticated:false, oauthRequired:true };
    }
  }

  async function logout(){
    await fetch('/auth/logout', { method:'POST' });
    await updateAuthStatus();
  }

  async function vote(ev){
    ev.preventDefault();
    const s=$$('input[name="candidate"]').find(x=>x.checked);
    const msg=$('#msg');
    if(!s) return;
    try{
      const me = await fetchJSON('/api/me');
      if (me.oauthRequired && !me.authenticated) {
        if (msg) msg.textContent = 'Connectez-vous avec Google avant de voter.';
        return;
      }
      if (msg) msg.textContent='Envoi…';
      await fetchJSON('/api/vote', {
        method:'POST',
        body: JSON.stringify({ candidateId: Number(s.value) })
      });
      if (msg) msg.textContent='Merci! Vote enregistré.';
      await refresh();
    }catch(e){
      if (msg) msg.textContent=e.message||'Erreur lors du vote.';
    }
  }

  document.addEventListener('DOMContentLoaded', async ()=>{
    try{
      const f=$('#vote-form'); if(f) f.addEventListener('submit', vote);
      const lg = $('#loginBtn');
      if (lg) lg.addEventListener('click', ()=> location.href='/auth/google');
      const lo = $('#logoutBtn');
      if (lo) lo.addEventListener('click', logout);
      await refresh();
      setInterval(refresh,30000);
    }catch(e){
      console.error(e);
      const msg=$('#msg'); if(msg) msg.textContent=e.message;
    }
  });
})();
// === Observer les changements de --pie-legend-font-size ===
(function observeLegendFontSize() {
  const root = document.documentElement;
  let last = getComputedStyle(root).getPropertyValue('--pie-legend-font-size');

  function check() {
    const current = getComputedStyle(root).getPropertyValue('--pie-legend-font-size');
    if (current !== last && chart) {
      last = current;
      chart.options.plugins.legend.labels.font.size = parseInt(current, 10) || 12;
      chart.update();
    }
  }

  // Vérifie régulièrement (léger)
  setInterval(check, 500);
})();
