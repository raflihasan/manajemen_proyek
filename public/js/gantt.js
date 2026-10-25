/* Gantt Chart — merender data dari /api/projects/:id/gantt (bukan gambar statis). */
'use strict';

const ROW_H = 34;
const state = { data: null, scale: 'hari', showDeps: true, rows: [], rangeStart: '', rangeEnd: '' };

function $(id) { return document.getElementById(id); }
function diffDays(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
function colW() { return state.scale === 'hari' ? 26 : state.scale === 'minggu' ? 12 : 5; }
const BULAN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
const HARI = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];

function isOff(dateStr, data) {
  if ((data.holidays || []).some(h => h.date === dateStr)) return true;
  const dow = new Date(dateStr.split('-')[0], dateStr.split('-')[1] - 1, dateStr.split('-')[2]).getDay();
  const wm = data.workdayMap || {};
  return wm[dow] === false;
}

function orderedRows(tasks) {
  const byParent = {}, ids = new Set(tasks.map(t => t.id));
  tasks.forEach(t => {
    const p = (t.parent_id && ids.has(t.parent_id)) ? t.parent_id : 0;
    (byParent[p] = byParent[p] || []).push(t);
  });
  const out = [];
  function walk(pid, depth) {
    (byParent[pid] || []).forEach(t => {
      out.push({ ...t, depth });
      walk(t.id, depth + 1);
    });
  }
  walk(0, 0);
  // tugas yatim (induk tidak ada di proyek) tetap ditampilkan
  return out;
}

async function load() {
  const el = $('ganttStatus');
  el.textContent = 'Memuat data…';
  try {
    const res = await fetch(`/api/projects/${window.GANTT_PROJECT_ID}/gantt`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Gagal memuat data');
    state.data = data;
    state.rows = orderedRows(data.tasks);
    if (!state.rows.length) {
      $('ganttError').innerHTML = '<div class="alert alert-info">Proyek ini belum memiliki tugas.</div>';
      $('ganttTaskList').innerHTML = ''; $('ganttBars').innerHTML = ''; $('ganttHeader').innerHTML = '';
      el.textContent = 'Belum ada data tugas';
      return;
    }
    let start = data.project.start, end = data.project.target || data.project.start;
    data.tasks.forEach(t => {
      if (t.start && t.start < start) start = t.start;
      if (t.end && t.end > end) end = t.end;
    });
    if (data.estimatedEnd && data.estimatedEnd > end) end = data.estimatedEnd;
    state.rangeStart = addDays(start, -3);
    state.rangeEnd = addDays(end, 7);
    if (data.cpm_reason) {
      $('ganttError').innerHTML = '<div class="alert alert-warning">Perhitungan jadwal kritis belum dapat dilakukan: ' +
        escapeHtml(data.cpm_reason) + ' — batang ditampilkan berdasarkan tanggal tersimpan.</div>';
    } else { $('ganttError').innerHTML = ''; }
    el.textContent = `${state.rows.length} tugas · ${data.cpm_ok ? 'jalur kritis aktif' : 'tanpa analisis jalur kritis'}` +
      (data.estimatedEnd ? ` · perkiraan selesai ${data.estimatedEnd}` : '');
    render();
  } catch (err) {
    $('ganttError').innerHTML = '<div class="alert alert-danger">Gagal memuat Gantt Chart: ' + escapeHtml(err.message) + '</div>';
    el.textContent = 'Gagal memuat';
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const data = state.data, rows = state.rows, w = colW();
  const nCols = diffDays(state.rangeStart, state.rangeEnd) + 1;
  const totalW = nCols * w;

  // --- daftar tugas (kiri) ---
  const leftHtml = [];
  rows.forEach(t => {
    leftHtml.push(`<div class="gantt-task-row ${t.is_critical ? 'crit' : ''}" data-id="${t.id}"
      style="height:${ROW_H}px;padding-left:${8 + t.depth * 14}px">
      <span class="gt-name" title="${escapeHtml(t.name)}">${t.depth ? '└ ' : ''}${escapeHtml(t.name)}</span>
      <span class="gt-meta">${t.duration}hr</span>
    </div>`);
  });
  $('ganttTaskList').innerHTML = leftHtml.join('');

  // --- header kalender ---
  let header = '<div class="gh-row gh-months">';
  let i = 0;
  while (i < nCols) {
    const d = addDays(state.rangeStart, i);
    const monthKey = d.slice(0, 7);
    let span = 0;
    while (i + span < nCols && addDays(state.rangeStart, i + span).slice(0, 7) === monthKey) span++;
    header += `<div class="gh-month" style="width:${span * w}px">${BULAN[Number(monthKey.slice(5, 7)) - 1]} ${monthKey.slice(0, 4)}</div>`;
    i += span;
  }
  header += '</div><div class="gh-row gh-days">';
  for (let c = 0; c < nCols; c++) {
    const d = addDays(state.rangeStart, c);
    const dow = new Date(d.slice(0, 4), d.slice(5, 7) - 1, d.slice(8, 10)).getDay();
    let label = '';
    if (state.scale === 'hari') {
      label = `<b>${d.slice(8, 10)}</b><i>${HARI[dow].slice(0, 2)}</i>`;
    } else if (state.scale === 'minggu') {
      if (dow === 1) label = `<b>${d.slice(8, 10)}/${d.slice(5, 7)}</b>`;
    } else {
      if (d.slice(8, 10) === '01') label = `<b>${BULAN[Number(d.slice(5, 7)) - 1]}</b>`;
    }
    header += `<div class="gh-day ${isOff(d, data) ? 'off' : ''}" style="width:${w}px">${label}</div>`;
  }
  header += '</div>';
  $('ganttHeader').innerHTML = header;
  $('ganttHeader').style.width = totalW + 'px';

  // --- badan ---
  const body = $('ganttBody');
  body.style.width = totalW + 'px';
  body.style.height = (rows.length * ROW_H) + 'px';

  // kolom libur
  let colsHtml = '';
  for (let c = 0; c < nCols; c++) {
    const d = addDays(state.rangeStart, c);
    if (isOff(d, data)) colsHtml += `<div class="g-col-off" style="left:${c * w}px;width:${w}px"></div>`;
  }
  // baris
  rows.forEach((t, idx) => {
    colsHtml += `<div class="g-rowline" style="top:${idx * ROW_H}px"></div>`;
  });

  // batang
  let barsHtml = '';
  rows.forEach((t, idx) => {
    const s = t.start || state.rangeStart, e = t.end || s;
    const x1 = Math.max(0, diffDays(state.rangeStart, s)) * w;
    const x2 = (diffDays(state.rangeStart, e) + 1) * w;
    const width = Math.max(6, x2 - x1);
    const top = idx * ROW_H + 5;
    barsHtml += `<div class="g-bar ${t.is_critical ? 'crit' : 'noncrit'} ${t.status === 'Selesai' ? 'done' : ''}"
      data-id="${t.id}" ${window.GANTT_CAN_MANAGE ? 'draggable="true"' : ''}
      style="left:${x1}px;top:${top}px;width:${width}px;height:${ROW_H - 10}px"
      title="${escapeHtml(t.name)} (${s} → ${e})">
      <div class="g-bar-prog" style="width:${t.progress}%"></div>
      <span class="g-bar-label">${escapeHtml(t.name)} · ${Math.round(t.progress)}%</span>
    </div>`;
  });
  $('ganttBars').innerHTML = colsHtml + barsHtml;

  drawDeps(totalW);

  // interaksi
  $('ganttBars').querySelectorAll('.g-bar').forEach(bar => {
    bar.addEventListener('click', () => showDetail(Number(bar.dataset.id)));
    bar.addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('text/plain', bar.dataset.id);
      ev.dataTransfer.effectAllowed = 'move';
      bar.classList.add('dragging');
    });
    bar.addEventListener('dragend', () => bar.classList.remove('dragging'));
  });
  const barsArea = $('ganttBars');
  barsArea.addEventListener('dragover', ev => { if (window.GANTT_CAN_MANAGE) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; } });
  barsArea.addEventListener('drop', async ev => {
    if (!window.GANTT_CAN_MANAGE) return;
    ev.preventDefault();
    const id = Number(ev.dataTransfer.getData('text/plain'));
    if (!id) return;
    const rect = barsArea.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    let dayIdx = Math.round(x / colW());
    dayIdx = Math.max(0, dayIdx);
    const newStart = addDays(state.rangeStart, dayIdx);
    const task = state.rows.find(t => t.id === id);
    if (task && task.start === newStart) return;
    $('ganttStatus').textContent = 'Menyimpan jadwal baru…';
    try {
      const res = await fetch(`/api/projects/${window.GANTT_PROJECT_ID}/gantt/reschedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ task_id: id, new_start: newStart })
      });
      const out = await res.json();
      if (!out.ok) {
        $('ganttError').innerHTML = '<div class="alert alert-danger">⚠ ' + escapeHtml(out.message) + '</div>';
      } else {
        $('ganttError').innerHTML = '<div class="alert alert-success">' + escapeHtml(out.message) + '</div>';
      }
      await load();
    } catch (e) {
      $('ganttError').innerHTML = '<div class="alert alert-danger">Gagal menyimpan: ' + escapeHtml(e.message) + '</div>';
    }
  });

  $('ganttLeft').querySelectorAll('.gantt-task-row').forEach(row => {
    row.addEventListener('click', () => showDetail(Number(row.dataset.id)));
  });
}

function drawDeps(totalW) {
  const svg = $('ganttDeps');
  const rows = state.rows, w = colW();
  svg.setAttribute('width', totalW);
  svg.setAttribute('height', rows.length * ROW_H);
  svg.style.width = totalW + 'px';
  svg.style.height = (rows.length * ROW_H) + 'px';
  if (!state.showDeps || !state.data) { svg.innerHTML = ''; return; }
  const idx = {}; rows.forEach((r, i) => { idx[r.id] = i; });
  const pos = {};
  rows.forEach((t, i) => {
    const s = t.start || state.rangeStart, e = t.end || s;
    pos[t.id] = {
      x1: Math.max(0, diffDays(state.rangeStart, s)) * w,
      x2: (diffDays(state.rangeStart, e) + 1) * w,
      y: i * ROW_H + ROW_H / 2
    };
  });
  let paths = `<defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#64748b"></path>
    </marker>
    <marker id="arrowCrit" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#dc2626"></path>
    </marker>
  </defs>`;
  (state.data.deps || []).forEach(d => {
    const a = pos[d.predecessor_id], b = pos[d.successor_id];
    if (!a || !b) return;
    const pa = state.rows.find(t => t.id === d.predecessor_id);
    const pb = state.rows.find(t => t.id === d.successor_id);
    const critical = pa && pb && pa.is_critical && pb.is_critical;
    let x1, y1 = a.y, x2 = b.y;
    if (d.type === 'SS') { x1 = a.x1; } else { x1 = a.x2; }
    let xEnd = b.x1 - 4;
    if (xEnd <= x1 + 10) {
      // rute memutar bila penerus berada di belakang/kiri
      const midX = x1 + 10;
      paths += `<path d="M${x1},${y1} H${midX} V${x2} H${b.x1 - 3}" fill="none"
        stroke="${critical ? '#dc2626' : '#64748b'}" stroke-width="${critical ? 2.4 : 1.3}"
        stroke-dasharray="${d.type === 'SS' ? '5 3' : ''}" marker-end="url(#${critical ? 'arrowCrit' : 'arrow'})"></path>`;
    } else {
      const midX = (x1 + xEnd) / 2;
      paths += `<path d="M${x1},${y1} H${midX} V${x2} H${xEnd}" fill="none"
        stroke="${critical ? '#dc2626' : '#64748b'}" stroke-width="${critical ? 2.4 : 1.3}"
        stroke-dasharray="${d.type === 'SS' ? '5 3' : ''}" marker-end="url(#${critical ? 'arrowCrit' : 'arrow'})"></path>`;
    }
    if (state.scale !== 'bulan' && (d.lag > 0 || d.type === 'SS')) {
      const lx = d.type === 'SS' ? a.x1 + 6 : a.x2 + 6;
      paths += `<text x="${lx}" y="${(y1 + x2) / 2 - 3}" font-size="9" fill="${critical ? '#dc2626' : '#475569'}">${d.type}${d.lag ? ' +' + d.lag + 'hr' : ''}</text>`;
    }
  });
  svg.innerHTML = paths;
}

function showDetail(id) {
  const t = state.data.tasks.find(x => x.id === id);
  if (!t) return;
  const deps = (state.data.deps || []).filter(d => d.predecessor_id === id || d.successor_id === id);
  const nameOf = i => { const x = state.data.tasks.find(k => k.id === i); return x ? x.name : i; };
  let html = `<h3>${escapeHtml(t.name)} ${t.is_critical ? '<span class="badge badge-critical">kritis</span>' : ''}</h3>
    <dl class="meta">
      <div><dt>Mulai</dt><dd>${t.start || '-'}</dd></div>
      <div><dt>Selesai</dt><dd>${t.end || '-'}</dd></div>
      <div><dt>Durasi</dt><dd>${t.duration} hari kerja</dd></div>
      <div><dt>Prioritas</dt><dd>${escapeHtml(t.priority)}</dd></div>
      <div><dt>Status</dt><dd>${escapeHtml(t.status)}</dd></div>
      <div><dt>Progres</dt><dd>${Math.round(t.progress)}%</dd></div>
      <div><dt>Slack</dt><dd>${t.slack === null || t.slack === undefined ? '-' : t.slack + ' hari kerja'}</dd></div>
      <div><dt>Anggota</dt><dd>${t.assignees && t.assignees.length ? escapeHtml(t.assignees.join(', ')) : '-'}</dd></div>
    </dl>`;
  if (t.conflict) html += `<div class="alert alert-warning">⚠ ${escapeHtml(t.conflict)}</div>`;
  if (deps.length) {
    html += '<p><strong>Dependensi:</strong></p><ul class="list">';
    deps.forEach(d => {
      html += `<li>${escapeHtml(nameOf(d.predecessor_id))} <span class="badge badge-info">${d.type}</span>${d.lag ? ' + lag ' + d.lag + ' hr' : ''} → ${escapeHtml(nameOf(d.successor_id))}</li>`;
    });
    html += '</ul>';
  }
  html += `<a class="btn btn-sm btn-secondary" href="/projects/${window.GANTT_PROJECT_ID}/tasks/${t.id}">Buka Detail Tugas</a>`;
  document.getElementById('taskDetail').innerHTML = html;
}

// sinkronkan gulir vertikal daftar ↔ grafik
function syncScroll() {
  const right = $('ganttRight'), leftScroll = $('ganttLeft');
  right.addEventListener('scroll', () => { leftScroll.scrollTop = right.scrollTop; });
}
document.addEventListener('DOMContentLoaded', () => {
  $('ganttScale').addEventListener('change', e => { state.scale = e.target.value; if (state.data) render(); });
  $('showDeps').addEventListener('change', e => { state.showDeps = e.target.checked; if (state.data) render(); });
  syncScroll();
  load();
});
