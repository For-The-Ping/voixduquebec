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

  async function fetchJSON(url, opts={}){
    const r = await fetch(url, { headers:{'Content-Type':'application/json'}, ...opts });
    if (!r.ok){ const t=await r.text(); try{ throw new Error(JSON.parse(t).error||t) }catch{ throw new Error(t) } }
    return r.json();
  }

  function renderCandidates(list){
    const wrap = $('#candidate-list'); wrap.innerHTML='';
    list.forEach(c=>{
      const color = c.color || pickColor(c.name);
      const label = document.createElement('label');
      label.className='candidate';
      label.innerHTML = `
        <span class="dot" style="--dot:${color}"></span>
        <input type="checkbox" name="candidate" value="${c.id}" />
        <span class="cand-name">${c.name}</span>`;
      wrap.appendChild(label);
    });
    wrap.addEventListener('change', e=>{
      if (e.target && e.target.name==='candidate' && e.target.checked){
        $$('input[name="candidate"]').forEach(x=>{ if(x!==e.target) x.checked=false; });
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

  // Plugin : étiquettes % + acronyme dans chaque part
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
  }

  async function sha256Hex(s){ const b=new TextEncoder().encode(s); const d=await crypto.subtle.digest('SHA-256',b);
    return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,'0')).join(''); }
  function countLeadingZeroBitsFromHex(hex){ let bits=0; for(let i=0;i<hex.length;i++){ const n=parseInt(hex[i],16);
    if(n===0){bits+=4;continue} for(let j=3;j>=0;j--){ if(((n>>j)&1)===0) bits++; else return bits } } return bits; }
  async function solvePow(ch,bits){ let n=0; while(true){ const h=await sha256Hex(`${ch}:${n}`);
    if(countLeadingZeroBitsFromHex(h)>=bits) return n; n++; } }

  async function vote(ev){
    ev.preventDefault(); const s=$$('input[name="candidate"]').find(x=>x.checked); const msg=$('#msg');
    if(!s){ msg.textContent='Sélectionnez un parti.'; return; }
    try{
      msg.textContent='Préparation (preuve de travail)…';
      const {challenge,bits}=await fetchJSON('/api/pow'); const nonce=await solvePow(challenge,bits);
      msg.textContent='Envoi…';
      await fetchJSON('/api/vote',{ method:'POST', body:JSON.stringify({ candidateId:Number(s.value), pow:{challenge,nonce} }) });
      msg.textContent='Merci! Vote enregistré.'; await refresh();
    }catch(e){ msg.textContent=e.message||'Erreur lors du vote.'; }
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
      await refresh(); setInterval(refresh,30000);
    }catch(e){ console.error(e); const msg=$('#msg'); if(msg) msg.textContent=e.message; }
  });

// public/app.js
async function envoyerVote(candidateId, pow) {
  const payload = {
    candidateId,
    pow, // ton objet { challenge, nonce }
    nonce: (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)) + Date.now(),
    ts: Date.now(),
    // cf_turnstile_response: await turnstile.getResponse() // seulement si activé
  };

  const res = await fetch('/api/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log('Réponse vote:', data);
}

document.getElementById('voteBtn').addEventListener('click', async (e) => {
  const candidateId = Number(e.target.dataset.id);

  // récupère ton challenge PoW
  const powChallenge = await fetch('/api/pow').then(r=>r.json());
  const pow = { challenge: powChallenge.challenge, nonce: 12345 }; 
  // 👆 remplace par ton vrai calcul PoW

  await envoyerVote(candidateId, pow);
});
})();
