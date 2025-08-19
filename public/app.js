// app.js — version lisible + couleurs de parti + pastille
(() => {
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  let chart;

  // Couleurs par défaut si l'API ne renvoie pas "color"
  const PARTY_COLORS = [
    { test: /coalition avenir québec|caq/i,           color: '#0aa2c0' },
    { test: /parti québécois|pq|plamondon/i,          color: '#1b4db3' },
    { test: /parti libéral du québec|plq/i,           color: '#d32f2f' },
    { test: /québec solidaire|qs/i,                   color: '#f36f21' },
    { test: /parti conservateur du québec|pcq|duhaime/i, color: '#1d2e6e' },
    { test: /parti vert|pvq/i,                        color: '#2e7d32' },
  ];
  const pickColor = (name, fallback = '#888') => {
    const hit = PARTY_COLORS.find(p => p.test.test(name));
    return hit ? hit.color : fallback;
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

  // ---- UI ----

  function renderCandidates(list) {
    const wrap = $('#candidate-list');
    if (!wrap) return;
    wrap.innerHTML = '';

    list.forEach(c => {
      const id = `cand-${c.id}`;
      const color = c.color || pickColor(c.name);

      const label = document.createElement('label');
      label.className = 'candidate';
      label.innerHTML = `
        <span class="dot" style="--dot:${color}"></span>
        <input type="radio" name="candidate" value="${c.id}" id="${id}" />
        <span>${c.name}</span>
      `;
      wrap.appendChild(label);
    });
  }

  function renderTable(results) {
    const mount = $('#results-table');
    if (!mount) return;
    mount.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'table';
    table.innerHTML = `
      <thead>
        <tr><th>Candidat</th><th>Votes</th><th>%</th></tr>
      </thead>
      <tbody>
        ${results.map(r => `
          <tr>
            <td>
              <span class="dot" style="--dot:${r.color || pickColor(r.name)}"></span>
              ${r.name}
            </td>
            <td>${r.votes}</td>
            <td>${(r.percent ?? 0).toFixed(1)}%</td>
          </tr>
        `).join('')}
      </tbody>
    `;
    mount.appendChild(table);
  }

  function drawDonut(data) {
    const canvas = $('#chart');
    if (!canvas) return;

    const total  = data.total  || 0;
    const leader = data.leader || null;

    const labels = data.results.map(r => r.name);
    const values = data.results.map(r => r.votes);
    const colors = data.results.map(r => r.color || pickColor(r.name));

    if (chart) chart.destroy();
    chart = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }]
      },
      options: {
        responsive: true,
        cutout: '65%',
        plugins: { legend: { display: true, position: 'bottom' } }
      }
    });

    const center = $('#center-label');
    if (center) {
      if (leader && total > 0) {
        center.innerHTML = `
          <div class="lead">${leader.percent.toFixed(1)}%</div>
          <div class="sub">en tête — ${leader.name}<br/>
            <small>Total votes: ${total}</small>
          </div>
        `;
      } else {
        center.innerHTML = `<div class="lead">0%</div><div class="sub">Aucun vote pour l'instant</div>`;
      }
    }
  }

  // ---- Data flow ----

  async function refresh() {
    // /api/candidates DOIT renvoyer { id, name, color? }
    const candidates = await fetchJSON('/api/candidates');
    renderCandidates(candidates);

    // /api/results DOIT renvoyer color pour que le donut reprenne les couleurs
    const data = await fetchJSON('/api/results');
    // si l'API n'a pas de colors, enrichit côté client à partir du nom
    data.results = data.results.map(r => ({ ...r, color: r.color || pickColor(r.name) }));

    renderTable(data.results);
    drawDonut(data);
  }

  // ---- PoW (preuve de travail) + vote ----

  async function sha256Hex(s) {
    const bytes = new TextEncoder().encode(s);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map(x => x.toString(16).padStart(2, '0'))
      .join('');
  }

  function countLeadingZeroBitsFromHex(hex) {
    let bits = 0;
    for (let i = 0; i < hex.length; i++) {
      const n = parseInt(hex[i], 16);
      if (n === 0) { bits += 4; continue; }
      for (let j = 3; j >= 0; j--) {
        if (((n >> j) & 1) === 0) bits++;
        else return bits;
      }
    }
    return bits;
  }

  async function solvePow(challenge, bits) {
    let nonce = 0;
    while (true) {
      const h = await sha256Hex(`${challenge}:${nonce}`);
      if (countLeadingZeroBitsFromHex(h) >= bits) return nonce;
      nonce++;
    }
  }

  async function vote(ev) {
    ev.preventDefault();
    const msg = $('#msg');
    const selected = $$('input[name="candidate"]:checked')[0];
    if (!selected) { msg.textContent = 'Sélectionnez un candidat.'; return; }

    try {
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
    } catch (e) {
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
