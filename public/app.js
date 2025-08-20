// app.js — pie chart + étiquettes dans les parts + cases à cocher (1 choix)
(() => {
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  let chart;

  // Couleurs fallback si l'API ne renvoie pas "color"
  const PARTY_COLORS = [
    { test: /coalition avenir québec|caq/i,               color: '#0aa2c0' },
    { test: /parti québécois|pq|plamondon/i,              color: '#1b4db3' },
    { test: /parti libéral du québec|plq/i,               color: '#d32f2f' },
    { test: /québec solidaire|qs/i,                       color: '#f36f21' },
    { test: /parti conservateur du québec|pcq|duhaime/i,  color: '#1d2e6e' },
    { test: /parti vert du québec|pvq/i,                  color: '#2e7d32' },
  ];
  const pickColor = (name, fallback = '#888') => {
    const hit = PARTY_COLORS.find(p => p.test.test(name));
    return hit ? hit.color : fallback;
  };

  const partyAcronym = (name) => {
    const map = [
      { re:/coalition avenir québec|caq/i,               ac:'CAQ' },
      { re:/parti québécois|pq/i,                        ac:'PQ'  },
      { re:/parti libéral du québec|plq/i,               ac:'PLQ' },
      { re:/québec solidaire|qs/i,                       ac:'QS'  },
      { re:/parti conservateur du québec|pcq/i,          ac:'PCQ' },
      { re:/parti vert du québec|pvq/i,                  ac:'PVQ' },
    ];
    const hit = map.find(m => m.re.test(name));
    if (hit) return hit.ac;
    return name.replace(/[()]/g,'')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !/^(de|du|des|la|le|les|et)$/i.test(w))
      .map(w => w[0].toUpperCase())
      .slice(0,4).join('');
  };

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    if (!res.ok) {
      const t = await res.text();
      try { throw new Error(JSON.parse(t).error || t); }
      catch { throw new Error(t); }
    }
    return res.json();
  }

  /* -------- UI -------- */

  // Cases à cocher (mais 1 seul choix autorisé → on décoche les autres au clic)
  function renderCandidates(list) {
    const wrap = $('#candidate-list'); if (!wrap) return;
    wrap.innerHTML = '';
    list.forEach(c => {
      const id = `cand-${c.id}`;
      const color = c.color || pickColor(c.name);

      const label = document.createElement('label');
      label.className = 'candidate';
      label.innerHTML = `
        <span class="dot" style="--dot:${color}"></span>
        <input type="checkbox" name="candidate" value="${c.id}" id="${id}" />
        <span class="cand-name">${c.name}</span>
      `;
      wrap.appendChild(label);
    });

    // Un seul checkbox actif : on décoche les autres quand on en coche un
    wrap.addEventListener('change', (e) => {
      if (e.target && e.target.name === 'candidate') {
        const me = e.target;
        if (me.checked) {
          $$('input[name="candidate"]').forEach(box => {
            if (box !== me) box.checked = false;
          });
        }
      }
    });
  }

  function renderTable(results) {
    const mount = $('#results-table'); if (!mount) return;
    mount.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'table';
    table.innerHTML = `
      <thead>
        <tr><th>Parti / Candidat</th><th>Votes</th><th>%</th></tr>
      </thead>
      <tbody>
        ${results.map(r => `
          <tr>
            <td><span class="dot" style="--dot:${r.color || pickColor(r.name)}"></span> ${r.name}</td>
            <td>${r.votes}</td>
            <td>${(r.percent ?? 0).toFixed(1)}%</td>
          </tr>
        `).join('')}
      </tbody>
    `;
    mount.appendChild(table);
  }

  // Plugin pour écrire % + acronyme dans chaque part
  const sliceLabels = {
    id: 'sliceLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const ds = chart.data.datasets[0];
      if (!ds) return;
      const meta = chart.getDatasetMeta(0);
      const total = ds.data.reduce((a,b)=>a+b,0) || 0;

      ctx.save();
      ctx.fillStyle = '#0b1220';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      meta.data.forEach((arc, i) => {
        const val = Number(ds.data[i] || 0);
        if (!val || !total) return;
        const pct = val / total * 100;
        if (pct < 3) return; // évite d’étiqueter les toutes petites parts

        const { x, y, startAngle, endAngle, outerRadius } = arc;
        const angle = (startAngle + endAngle) / 2;
        const r = outerRadius * 0.62; // distance du centre
        const tx = x + Math.cos(angle) * r;
        const ty = y + Math.sin(angle) * r;

        ctx.font = '700 12px ui-sans-serif, system-ui';
        const label = `${pct.toFixed(1)}% ${partyAcronym(chart.data.labels[i] || '')}`;
        ctx.fillText(label, tx, ty);
      });

      ctx.restore();
    }
  };

  function drawPie(data) {
    const canvas = $('#chart'); if (!canvas) return;

    const labels = data.results.map(r => r.name);
    const values = data.results.map(r => r.votes);
    const colors = data.results.map(r => r.color || '#888');

    if (chart) chart.destroy();
    chart = new Chart(canvas.getContext('2d'), {
      type: 'pie',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        responsive: true,
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: { enabled: true }
        }
      },
      plugins: [sliceLabels]
    });

    // plus de label central pour le camembert plein
    const center = $('#center-label'); if (center) center.innerHTML = '';
  }

  /* -------- Data flow -------- */

  async function refresh() {
    const candidates = await fetchJSON('/api/candidates');
    renderCandidates(candidates);

    const data = await fetchJSON('/api/results');
    // enrichit les couleurs au cas où
    data.results = data.results.map(r => ({ ...r, color: r.color || pickColor(r.name) }));

    renderTable(data.results);
    drawPie(data);
  }

  /* -------- PoW + vote -------- */

  async function sha256Hex(s) {
    const bytes = new TextEncoder().encode(s);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2,'0')).join('');
  }
  function countLeadingZeroBitsFromHex(hex){
    let bits=0;
    for (let i=0;i<hex.length;i++){
      const n=parseInt(hex[i],16);
      if (n===0){ bits+=4; continue; }
      for (let j=3;j>=0;j--){
        if (((n>>j)&1)===0) bits++; else return bits;
      }
    }
    return bits;
  }
  async function solvePow(challenge, bits){
    let nonce = 0;
    while(true){
      const h = await sha256Hex(`${challenge}:${nonce}`);
      if (countLeadingZeroBitsFromHex(h) >= bits) return nonce;
      nonce++;
    }
  }

  async function vote(ev){
    ev.preventDefault();
    const msg = $('#msg');

    // récupère la (seule) checkbox cochée
    const selected = $$('input[name="candidate"]').find(x => x.checked);
    if (!selected) { msg.textContent = 'Sélectionnez un parti.'; return; }

    try{
      msg.textContent = 'Préparation (preuve de travail)…';
      const { challenge, bits } = await fetchJSON('/api/pow');
      const nonce = await solvePow(challenge, bits);

      msg.textContent = 'Envoi…';
      await fetchJSON('/api/vote', {
        method: 'POST',
        body: JSON.stringify({
          candidateId: Number(selected.value),
          pow: { challenge, nonce }
        })
      });

      msg.textContent = 'Merci! Vote enregistré.';
      await refresh();
    }catch(e){
      msg.textContent = e.message || 'Erreur lors du vote.';
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const form = $('#vote-form');
    if (form) form.addEventListener('submit', vote);
    await refresh();
    setInterval(refresh, 30000);
  });
})();
