/* PERT Chart / Network Diagram — node & panah dari data dependensi proyek. */
'use strict';

const NODE_W = 210, NODE_H = 104, GAP_X = 96, GAP_Y = 26, PAD = 30;
const state = { data: null, layout: {}, markCritical: true };

function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function load() {
  try {
    const res = await fetch(`/api/projects/${window.PERT_PROJECT_ID}/pert`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Gagal memuat data');
    state.data = data;
    if (!data.nodes.length) {
      $('pertError').innerHTML = '<div class="alert alert-info">Proyek ini belum memiliki tugas.</div>';
      $('pertNodes').innerHTML = ''; $('pertEdges').innerHTML = '';
      $('pertStatus').textContent = 'Belum ada data tugas';
      return;
    }
    if (!data.cpm_ok) {
      $('pertError').innerHTML = '<div class="alert alert-warning">Analisis jalur kritis belum dapat dilakukan: ' +
        escapeHtml(data.cpm_reason) + ' Jaringan tetap ditampilkan dari data tersimpan.</div>';
    } else { $('pertError').innerHTML = ''; }
    $('pertStatus').textContent = `${data.nodes.length} node · ${data.edges.length} hubungan` +
      (data.cpm_ok ? ' · jalur kritis aktif' : '');
    render();
  } catch (err) {
    $('pertError').innerHTML = '<div class="alert alert-danger">Gagal memuat PERT Chart: ' + escapeHtml(err.message) + '</div>';
  }
}

function computeLayout() {
  const { nodes, edges } = state.data;
  const ids = new Set(nodes.map(n => n.id));
  const preds = {}; nodes.forEach(n => { preds[n.id] = []; });
  edges.forEach(e => { if (ids.has(e.from) && ids.has(e.to)) preds[e.to].push(e.from); });

  // kedalaman = panjang jalur dependensi terpanjang dari akar (topological DP)
  const depth = {}; nodes.forEach(n => { depth[n.id] = 0; });
  const indeg = {}; nodes.forEach(n => { indeg[n.id] = preds[n.id].length; });
  const queue = nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
  const order = [];
  const adj = {}; nodes.forEach(n => { adj[n.id] = []; });
  edges.forEach(e => { if (ids.has(e.from) && ids.has(e.to)) adj[e.from].push(e.to); });
  const indegCopy = { ...indeg };
  while (queue.length) {
    const u = queue.shift(); order.push(u);
    adj[u].forEach(v => {
      depth[v] = Math.max(depth[v], depth[u] + 1);
      if (--indegCopy[v] === 0) queue.push(v);
    });
  }
  // jika ada sisa (siklus/tidak topologis), tampilkan berdasarkan urutan data
  nodes.forEach(n => { if (depth[n.id] === undefined) depth[n.id] = 0; });

  const columns = {};
  nodes.forEach(n => { (columns[depth[n.id]] = columns[depth[n.id]] || []).push(n); });
  Object.keys(columns).forEach(k => {
    columns[k].sort((a, b) => (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0));
  });

  const layout = {};
  let maxRows = 1;
  const colKeys = Object.keys(columns).map(Number).sort((a, b) => a - b);
  colKeys.forEach((k, ci) => {
    columns[k].forEach((n, ri) => {
      layout[n.id] = { x: PAD + ci * (NODE_W + GAP_X), y: PAD + ri * (NODE_H + GAP_Y) };
      maxRows = Math.max(maxRows, ri + 1);
    });
  });
  const width = PAD * 2 + colKeys.length * (NODE_W + GAP_X);
  const height = PAD * 2 + maxRows * (NODE_H + GAP_Y);
  return { layout, width, height };
}

function render() {
  const { layout, width, height } = computeLayout();
  state.layout = layout;
  const canvas = $('pertCanvas');
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  // node
  const byId = {}; state.data.nodes.forEach(n => { byId[n.id] = n; });
  let html = '';
  state.data.nodes.forEach(n => {
    const p = layout[n.id]; if (!p) return;
    html += `<div class="pert-node ${n.is_critical ? 'crit' : ''} ${n.status === 'Selesai' ? 'done' : ''}"
      data-id="${n.id}" style="left:${p.x}px;top:${p.y}px">
      <div class="pn-name">${escapeHtml(n.name)}</div>
      <div class="pn-meta">${n.duration} hr · ${n.start || '-'} → ${n.end || '-'}</div>
      <div class="pn-foot">
        <span class="badge badge-${escapeHtml(n.status.toLowerCase().replace(' ', '-'))}">${escapeHtml(n.status)}</span>
        ${n.is_critical ? '<span class="badge badge-critical">kritis</span>' : ''}
        <small>${Math.round(n.progress)}%</small>
      </div>
    </div>`;
  });
  $('pertNodes').innerHTML = html;

  // edges
  const svg = $('pertEdges');
  svg.setAttribute('width', width); svg.setAttribute('height', height);
  svg.style.width = width + 'px'; svg.style.height = height + 'px';
  let paths = `<defs>
    <marker id="pArrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#64748b"></path></marker>
    <marker id="pArrowCrit" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#dc2626"></path></marker>
  </defs>`;
  state.data.edges.forEach(e => {
    const a = layout[e.from], b = layout[e.to];
    const na = byId[e.from], nb = byId[e.to];
    if (!a || !b) return;
    const critical = state.markCritical && na && nb && na.is_critical && nb.is_critical;
    const stroke = critical ? '#dc2626' : '#64748b';
    const sw = critical ? 2.6 : 1.4;
    const dash = e.type === 'SS' ? '6 4' : '';
    let x1, y1, x2, y2, d;
    if (b.x >= a.x + NODE_W - 10) {
      // maju (kiri ke kanan)
      x1 = a.x + NODE_W; y1 = a.y + NODE_H / 2;
      x2 = b.x - 6; y2 = b.y + NODE_H / 2;
      const midX = (x1 + x2) / 2;
      d = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
    } else {
      // mundur/samping: rute melengkung ke bawah
      x1 = a.x + NODE_W / 2; y1 = a.y + NODE_H;
      x2 = b.x + NODE_W / 2; y2 = b.y;
      const midY = Math.max(y1, y2) + 34;
      d = `M${x1},${y1} V${midY} H${x2} V${y2}`;
    }
    paths += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}"
      stroke-dasharray="${dash}" marker-end="url(#${critical ? 'pArrowCrit' : 'pArrow'})"></path>`;
    const lx = (x1 + x2) / 2 + 4, ly = (y1 + y2) / 2 - 5;
    paths += `<text x="${lx}" y="${ly}" font-size="11" font-weight="600" fill="${stroke}">${e.type}${e.lag ? ' +' + e.lag : ''}</text>`;
  });
  svg.innerHTML = paths;

  $('pertNodes').querySelectorAll('.pert-node').forEach(node => {
    node.addEventListener('click', () => showDetail(Number(node.dataset.id)));
  });
}

function showDetail(id) {
  const n = state.data.nodes.find(x => x.id === id);
  if (!n) return;
  const related = state.data.edges.filter(e => e.from === id || e.to === id);
  const nameOf = i => { const x = state.data.nodes.find(k => k.id === i); return x ? x.name : '#' + i; };
  let html = `<h3>${escapeHtml(n.name)} ${n.is_critical ? '<span class="badge badge-critical">jalur kritis</span>' : ''}</h3>
    <dl class="meta">
      <div><dt>Durasi</dt><dd>${n.duration} hari kerja</dd></div>
      <div><dt>Mulai (ES)</dt><dd>${n.start || '-'}</dd></div>
      <div><dt>Selesai (EF)</dt><dd>${n.end || '-'}</dd></div>
      <div><dt>Slack</dt><dd>${n.slack === null || n.slack === undefined ? '-' : n.slack + ' hari kerja'}</dd></div>
      <div><dt>Status</dt><dd>${escapeHtml(n.status)}</dd></div>
      <div><dt>Progres</dt><dd>${Math.round(n.progress)}%</dd></div>
    </dl>`;
  if (related.length) {
    html += '<p><strong>Hubungan:</strong></p><ul class="list">';
    related.forEach(e => {
      if (e.from === id) html += `<li>→ ${escapeHtml(nameOf(e.to))} <span class="badge badge-info">${e.type}</span>${e.lag ? ' lag ' + e.lag + ' hr' : ''}</li>`;
      else html += `<li>← ${escapeHtml(nameOf(e.from))} <span class="badge badge-info">${e.type}</span>${e.lag ? ' lag ' + e.lag + ' hr' : ''}</li>`;
    });
    html += '</ul>';
  }
  html += `<a class="btn btn-sm btn-secondary" href="/projects/${window.PERT_PROJECT_ID}/tasks/${n.id}">Buka Detail Tugas</a>`;
  $('pertDetail').innerHTML = html;
}

document.addEventListener('DOMContentLoaded', () => {
  const cb = $('showCriticalOnly');
  if (cb) cb.addEventListener('change', e => { state.markCritical = e.target.checked; if (state.data) render(); });
  load();
});
