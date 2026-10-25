'use strict';
// Utilitas tanggal: penanganan tanggal secara aman (tanpa timezone drift).
// Semua tanggal disimpan sebagai string 'YYYY-MM-DD'.

function toISODate(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseISO(s) {
  if (!s) return null;
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function addDays(s, n) {
  const dt = parseISO(s);
  dt.setDate(dt.getDate() + n);
  return toISODate(dt);
}

function diffDays(a, b) {
  // selisih hari kalender dari a ke b (b - a)
  const da = parseISO(a), db = parseISO(b);
  const ms = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) -
             Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  return Math.round(ms / 86400000);
}

function dayOfWeek(s) {
  // 0=Minggu ... 6=Sabtu
  return parseISO(s).getDay();
}

function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function rangeDates(start, end) {
  const out = [];
  let cur = start;
  let guard = 0;
  while (compare(cur, end) <= 0 && guard < 4000) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard++;
  }
  return out;
}

module.exports = { toISODate, parseISO, addDays, diffDays, dayOfWeek, compare, rangeDates };
