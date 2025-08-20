(() => {
  const $ = s => document.querySelector(s);
  let chart, DATA, PARTY_INDEX;

  async function loadData() {
    const res = await fetch('/data/history.json');
    if (!res.ok) throw new Error('history.json manquant');
    DATA = await res.json();
    PARTY_INDEX = Object.fromEntries(DATA.parties.map(p => [p.id, p]));
  }

  function renderYearList() {
    const years = Object.keys(DATA.years).sort((a,b) => b.localeCompare(a));
    const ul = $('#year-list'); ul.innerHTML = '';
    years.forEach((y, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<button class="year-btn" data-year="${y}">${y}</button>`;
      ul.appendChild(li);
    });
    // sélection par défaut = plus récente
    selectYear(years[0]);
    // events
    ul.addEventListener('click', (e) => {
      const btn = e.target.closest('.year-btn');
      if (!btn) return;
      selectYear(btn.dataset.year);
    });
  }

  function selectYear(year) {
    // UI active
    document.querySelectorAll('.year-btn').forEach(b => b.classList.toggle('active', b.dataset.year === year));
    // titre
    $('#year-title').textContent = `Résultats ${year}`;
    // données
    const entry = DATA.years[year];
    const order = DATA.parties.map(p => p.id); // ordre constant
    const labels = order.map(id => PARTY_INDEX[id]?.name || id);
    const values = order.map(id => Number(entry.results[id] || 0));
    const colors = order.map(id => PARTY_INDEX[id]?.color || '#888');

    // donut
    drawDonut(labels, values, colors);

    // table
    renderTable(order.map((id, i) => ({
      id, name: labels[i], value: values[i], color: colors[i]
    })));
  }

  function drawDonut(labels, values, colors) {
    const total = values.reduce((a,b)=>a+b,0);
    if (chart) chart.destroy();
    const ctx = document.getElementById('hist-chart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }] },
      options: { responsive:true, cutout:'65%', plugins:{ legend:{ display:true, position:'bottom' } } }
    });
    const leaderIdx = values.indexOf(Math.max(...values));
    $('#center-label').innerHTML = total > 0
      ? `<div class="lead">${(values[leaderIdx]||0).toFixed(1)}%</div>
         <div class="sub">en tête — ${labels[leaderIdx]}</div>`
      : `<div class="lead">0%</div><div class="sub">Aucune donnée</div>`;
  }

  function renderTable(rows) {
    const wrap = $('#table-wrap'); wrap.innerHTML = '';
    const html = `
      <table class="table">
        <thead><tr><th>Parti</th><th>% voix</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><span class="dot" style="--dot:${r.color}"></span> ${r.name}</td>
              <td>${r.value.toFixed(1)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
    wrap.innerHTML = html;
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await loadData();
      renderYearList();
    } catch (e) {
      console.error(e);
      alert("Impossible de charger l'historique. Vérifie /public/data/history.json");
    }
  });
})();
