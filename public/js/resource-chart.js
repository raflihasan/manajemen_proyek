/* Resource Chart — beban kerja anggota per hari dari penugasan + alokasi tersimpan. */
'use strict';

const COL_W = 22, ROW_H = 62;
const state = { data: null, member: '' };
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
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(n) { return Number(n).toLocaleString('id-ID'); }

async function load() {
  const start = $('rcStart').value, end = $('rcEnd').value;
  $('rcStatus').textContent = 'Memuat data…';
  try {
    const url = `/api/projects/${window.RC_PROJECT_ID}/resource?start=${start}&end=${end}`;
    const res = await fetch(url, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Gagal memuat data');
    state.data = data;
    const sel = $('rcMember');
    const keep = sel.value;
    sel.innerHTML = '<option value="">Semua anggota</option>' +
      data.rows.map(r => `<option value="${r.resource.id}">${escapeHtml(r.resource.full_name)}</option>`).join('');
    sel.value = keep;
    render();
  } catch (err) {
    $('rcError').innerHTML = '<div class="alert alert-danger">Gagal memuat Resource Chart: ' + escapeHtml(err.message) + '</div>';
    $('rcStatus').textContent = 'Gagal memuat';
  }
}

function render() {
  const data = state.data;
  let rows = data.rows;
  if (state.member) rows = rows.filter(r => String(r.resource.id) === String(state.member));
  const start = data.start, end = data.end;
  const nDays = diffDays(start, end) + 1;
  const totalW = nDays * COL_W;
  $('rcStatus').textContent = `${rows.length} anggota · ${start} → ${end} · ${nDays} hari`;

  if (!rows.length) {
    $('rcNames').innerHTML = '<div class="rc-name-row muted" style="padding:12px">Tidak ada anggota dengan penugasan.</div>';
    $('rcHeader').innerHTML = ''; $('rcBody').innerHTML = '';
    $('rcConflicts').innerHTML = '<p class="muted">Tidak ada data.</p>';
    $('rcSummary').innerHTML = '';
    return;
  }

  // header tanggal
  const BULAN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const HARI = ['M','S','S','R','K','J','S'];
  let head = '<div class="rc-head-row">';
  for (let i = 0; i < nDays; i++) {
    const d = addDays(start, i);
    const dow = new Date(d.slice(0, 4), d.slice(5, 7) - 1, d.slice(8, 10)).getDay();
    const weekend = dow === 0 || dow === 6;
    head += `<div class="rc-head-cell ${weekend ? 'off' : ''}" style="width:${COL_W}px">
      <b>${d.slice(8, 10)}</b><i>${HARI[dow]}</i></div>`;
  }
  head += '</div>';
  $('rcHeader').innerHTML = head;
  $('rcHeader').style.width = totalW + 'px';

  // nama anggota
  let names = '';
  rows.forEach(r => {
    names += `<div class="rc-name-row ${r.isOverallocated ? 'over' : ''}" style="height:${ROW_H}px">
      <a href="/resources/${r.resource.id}"><strong>${escapeHtml(r.resource.full_name)}</strong></a>
      <small class="muted">${escapeHtml(r.resource.role || '')}</small>
      ${r.isOverallocated ? '<span class="badge badge-danger">beban &gt;100%</span>' : ''}
      ${!r.hasAssignment ? '<span class="badge badge-sedang">tanpa tugas</span>' : ''}
    </div>`;
  });
  $('rcNames').innerHTML = names;

  // badan: blok penugasan + strip pemanfaatan harian
  let body = '';
  const absSet = {};
  rows.forEach((r, ri) => {
    const top = ri * ROW_H;
    // background kolom (weekend/libur tidak diketahui di sini — dibiarkan netral)
    body += `<div class="rc-rowline" style="top:${top}px"></div>`;

    // blok penugasan
    r.assignments.forEach(a => {
      const s = a.start_date || a.task_start, e = a.end_date || a.task_end;
      if (!s || !e) return;
      const from = Math.max(0, diffDays(start, s));
      const to = Math.min(nDays - 1, diffDays(start, e));
      if (to < 0 || from >= nDays) return;
      const x = from * COL_W, w = Math.max(COL_W / 2, (to - from + 1) * COL_W);
      body += `<div class="rc-block ${a.allocation > 100 ? 'over' : ''}" style="left:${x}px;top:${top + 4}px;width:${w - 2}px"
        title="${escapeHtml(a.task_name)} · ${a.allocation}% · ${s} → ${e}">
        ${escapeHtml(a.task_name)} <b>${a.allocation}%</b></div>`;
    });

    // strip beban harian
    for (let i = 0; i < nDays; i++) {
      const d = addDays(start, i);
      const load = r.daily[d] || 0;
      const absent = (r.absenceDates || []).includes(d);
      let cls = 'rc-cell';
      if (absent) cls += ' absent';
      else if (load > 100) cls += ' over';
      else if (load > 0) cls += ' load';
      body += `<div class="${cls}" style="left:${i * COL_W}px;top:${top + 34}px;width:${COL_W - 1}px;height:20px"
        title="${d}: ${load}%${absent ? ' · TIDAK HADIR' : ''}"></div>`;
      if (load > 0) {
        body += `<div class="rc-load-label" style="left:${i * COL_W}px;top:${top + 36}px;width:${COL_W}px">${load}</div>`;
      }
    }
  });
  const bodyEl = $('rcBody');
  bodyEl.style.width = totalW + 'px';
  bodyEl.style.height = (rows.length * ROW_H) + 'px';
  bodyEl.innerHTML = body;

  // konflik
  const conflicts = (data.conflicts || []).filter(c => !state.member || String(c.resource_id) === String(state.member));
  const unassigned = rows.filter(r => !r.hasAssignment);
  let cHtml = '';
  if (conflicts.length) {
    cHtml += `<div class="alert alert-warning"><strong>${conflicts.length} peringatan:</strong><ul>` +
      conflicts.slice(0, 15).map(c => `<li>${escapeHtml(c.message)}</li>`).join('') +
      (conflicts.length > 15 ? `<li>…dan ${conflicts.length - 15} lainnya</li>` : '') + '</ul></div>';
  } else {
    cHtml += '<div class="alert alert-success">Tidak ada konflik beban kerja pada rentang ini.</div>';
  }
  if (unassigned.length) {
    cHtml += `<p class="muted">Anggota tanpa penugasan: ${unassigned.map(r => escapeHtml(r.resource.full_name)).join(', ')}</p>`;
  }
  const absenceRows = rows.filter(r => (r.conflictWithAbsence || []).length);
  if (absenceRows.length) {
    cHtml += '<p class="warn">⚠ Penugasan bertepatan dengan hari libur pribadi: ' +
      absenceRows.map(r => escapeHtml(r.resource.full_name) + ' (' + r.conflictWithAbsence.join(', ') + ')').join('; ') + '</p>';
  }
  $('rcConflicts').innerHTML = cHtml;

  // ringkasan
  let s = '<table class="table"><thead><tr><th>Anggota</th><th>Tugas</th><th>Beban total (%·hari)</th><th>Puncak harian</th></tr></thead><tbody>';
  rows.forEach(r => {
    const total = Object.values(r.daily).reduce((a, b) => a + b, 0);
    s += `<tr class="${r.isOverallocated ? 'row-warning' : ''}">
      <td>${escapeHtml(r.resource.full_name)}</td>
      <td>${r.assignments.length}</td>
      <td>${total}</td>
      <td class="${r.maxDaily > 100 ? 'warn' : ''}">${r.maxDaily}%</td></tr>`;
  });
  s += '</tbody></table><p class="muted">Contoh pembacaan: alokasi 50% pada satu hari kerja = setengah kapasitas harian anggota; dua penugasan 60% pada hari yang sama = 120% (kelebihan beban).</p>';
  $('rcSummary').innerHTML = s;
}

document.addEventListener('DOMContentLoaded', () => {
  $('rcFilter').addEventListener('submit', e => { e.preventDefault(); load(); });
  $('rcMember').addEventListener('change', () => { state.member = $('rcMember').value; render(); });
  const right = $('rcRight');
  right.addEventListener('scroll', () => { document.querySelector('.rc-left').scrollTop = right.scrollTop; });
  load();
});
