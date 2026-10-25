'use strict';
// ============================================================================
// MODUL PERHITUNGAN JADWAL (satu sumber logika untuk Gantt, PERT, Jalur
// Kritis, Resource Chart, dan Laporan).
// ============================================================================
const { addDays, diffDays, dayOfWeek, compare, toISODate, rangeDates } = require('../utils/date');

// ---------------------------------------------------------------------------
// 1. KALENDER KERJA
// ---------------------------------------------------------------------------
function getCalendar(db, projectId) {
  let cal = db.prepare('SELECT * FROM work_calendars WHERE project_id = ?').get(projectId);
  if (!cal) {
    // buat kalender default bila belum ada
    const ins = db.prepare(
      'INSERT INTO work_calendars (project_id, work_start, work_end) VALUES (?,?,?)'
    ).run(projectId, '08:00', '17:00');
    cal = db.prepare('SELECT * FROM work_calendars WHERE id = ?').get(ins.lastInsertRowid);
  }
  let workdays = db.prepare(
    'SELECT day_of_week, is_workday FROM calendar_workdays WHERE calendar_id = ?'
  ).all(cal.id);
  if (workdays.length === 0) {
    const insWd = db.prepare(
      'INSERT INTO calendar_workdays (calendar_id, day_of_week, is_workday) VALUES (?,?,?)'
    );
    // default: Senin-Sabtu kerja, Minggu libur
    for (let d = 0; d <= 6; d++) insWd.run(cal.id, d, d === 0 ? 0 : 1);
    workdays = db.prepare(
      'SELECT day_of_week, is_workday FROM calendar_workdays WHERE calendar_id = ?'
    ).all(cal.id);
  }
  const holidays = db.prepare(
    'SELECT date, name, kind FROM calendar_holidays WHERE calendar_id = ?'
  ).all(cal.id);
  const workdayMap = {};
  workdays.forEach(w => { workdayMap[w.day_of_week] = w.is_workday === 1; });
  const holidaySet = new Set(holidays.map(h => h.date));
  return { calendar: cal, workdayMap, holidays, holidaySet };
}

function isWorkday(dateStr, ctx) {
  if (ctx.holidaySet.has(dateStr)) return false;
  return ctx.workdayMap[dayOfWeek(dateStr)] !== false;
}

// Cari hari kerja ke-n (1-based) mulai dari startDate (startDate sendiri dihitung
// hari ke-1 bila hari kerja).
function addWorkdays(startDate, duration, ctx) {
  if (duration <= 0) return startDate;
  let cur = startDate;
  // pastikan startDate hari kerja; jika tidak, majukan ke hari kerja berikutnya
  let guard = 0;
  while (!isWorkday(cur, ctx) && guard < 3650) { cur = addDays(cur, 1); guard++; }
  let count = 1;
  while (count < duration && guard < 5000) {
    cur = addDays(cur, 1);
    guard++;
    if (isWorkday(cur, ctx)) count++;
  }
  return cur;
}

// Durasi hari kerja antara dua tanggal (inklusif), mengabaikan hari libur.
function workdaysBetween(start, end, ctx) {
  if (!start || !end || compare(end, start) < 0) return 0;
  let n = 0;
  for (const d of rangeDates(start, end)) if (isWorkday(d, ctx)) n++;
  return n;
}

// Offset hari kerja: hari kerja ke-k setelah tanggal dasar (k bisa negatif).
function addWorkdayOffset(base, k, ctx) {
  let cur = base;
  if (k === 0) return cur;
  const step = k > 0 ? 1 : -1;
  let remaining = Math.abs(k);
  let guard = 0;
  while (remaining > 0 && guard < 5000) {
    cur = addDays(cur, step);
    guard++;
    if (isWorkday(cur, ctx)) remaining--;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// 2. MUAT DATA PROYEK (tugas, dependensi, penugasan)
// ---------------------------------------------------------------------------
function loadProjectData(db, projectId) {
  const ctx = getCalendar(db, projectId);
  const tasks = db.prepare(`
    SELECT t.*, p.start_date AS project_start, p.target_end_date AS project_target,
           p.status AS project_status, p.name AS project_name
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ?
    ORDER BY t.sort_order, t.id
  `).all(projectId);
  const deps = db.prepare(`
    SELECT d.*, tp.name AS predecessor_name, ts.name AS successor_name
    FROM task_dependencies d
    JOIN tasks tp ON tp.id = d.predecessor_id
    JOIN tasks ts ON ts.id = d.successor_id
    WHERE tp.project_id = ? AND ts.project_id = ?
  `).all(projectId, projectId);
  const assignments = db.prepare(`
    SELECT a.*, r.full_name AS resource_name, r.role AS resource_role, r.is_active
    FROM resource_assignments a JOIN resources r ON r.id = a.resource_id
    JOIN tasks t ON t.id = a.task_id
    WHERE t.project_id = ?
  `).all(projectId);
  return { ctx, tasks, deps, assignments };
}

// ---------------------------------------------------------------------------
// 3. JALUR KRITIS (CPM: forward pass ES/EF, backward pass LS/LF, float)
// ---------------------------------------------------------------------------
function detectCycle(tasks, deps) {
  const ids = new Set(tasks.map(t => t.id));
  const adj = {};
  tasks.forEach(t => { adj[t.id] = []; });
  deps.forEach(d => {
    if (ids.has(d.predecessor_id) && ids.has(d.successor_id))
      adj[d.predecessor_id].push(d.successor_id);
  });
  const state = {}; // 0=unvisited,1=visiting,2=done
  let hasCycle = false;
  const cyclePath = [];
  function dfs(u) {
    state[u] = 1;
    for (const v of adj[u]) {
      if (state[v] === 1) { hasCycle = true; cyclePath.push(u, v); return; }
      if (!state[v]) { dfs(v); if (hasCycle) { cyclePath.push(u); return; } }
    }
    state[u] = 2;
  }
  for (const t of tasks) if (!state[t.id]) { dfs(t.id); if (hasCycle) break; }
  return { hasCycle, cyclePath: cyclePath.reverse() };
}

function computeCPM(db, projectId) {
  const { ctx, tasks, deps } = loadProjectData(db, projectId);
  const result = {
    ok: false, reason: null, tasks: [], deps, ctx,
    projectDuration: 0, estimatedEnd: null, criticalPaths: [],
    holidays: ctx.holidays, workdayMap: ctx.workdayMap, calendar: ctx.calendar
  };

  if (tasks.length === 0) {
    result.reason = 'Belum ada tugas dalam proyek ini.';
    return result;
  }
  const noDuration = tasks.filter(t => !t.duration || t.duration <= 0);
  if (noDuration.length > 0) {
    result.reason = 'Beberapa tugas belum memiliki durasi valid: ' +
      noDuration.map(t => t.name).join(', ');
    return result;
  }
  const { hasCycle, cyclePath } = detectCycle(tasks, deps);
  if (hasCycle) {
    const names = cyclePath.map(id => (tasks.find(t => t.id === id) || {}).name || id);
    result.reason = 'Terdapat siklus dependensi antar tugas: ' + names.join(' → ');
    return result;
  }

  const byId = {};
  tasks.forEach(t => { byId[t.id] = t; });
  const predsOf = {}; // successor_id -> [dep]
  const succsOf = {};
  tasks.forEach(t => { predsOf[t.id] = []; succsOf[t.id] = []; });
  deps.forEach(d => {
    if (byId[d.successor_id] && byId[d.predecessor_id]) {
      predsOf[d.successor_id].push(d);
      succsOf[d.predecessor_id].push(d);
    }
  });

  // Topological order (Kahn)
  const indeg = {};
  tasks.forEach(t => { indeg[t.id] = predsOf[t.id].length; });
  const queue = tasks.filter(t => indeg[t.id] === 0).map(t => t.id);
  const topo = [];
  while (queue.length) {
    const u = queue.shift();
    topo.push(u);
    for (const d of succsOf[u]) {
      indeg[d.successor_id]--;
      if (indeg[d.successor_id] === 0) queue.push(d.successor_id);
    }
  }
  if (topo.length !== tasks.length) {
    result.reason = 'Terdapat siklus dependensi yang menghalangi perhitungan jadwal.';
    return result;
  }

  const defaultStart = tasks[0].project_start;
  const ES = {}, EF = {}, LS = {}, LF = {}, durationOf = {};
  const baseStart = {}; // penentuan tanggal mulai efektif per tugas

  // FORWARD PASS
  for (const id of topo) {
    const t = byId[id];
    const preds = predsOf[id];
    let earliest = null;
    if (preds.length === 0) {
      earliest = t.start_date || defaultStart;
    } else {
      let best = null;
      for (const d of preds) {
        const p = byId[d.predecessor_id];
        const pES = ES[d.predecessor_id], pEF = EF[d.predecessor_id];
        if (!pES || !pEF) continue;
        let cand;
        if (d.type === 'FS') {
          cand = addWorkdayOffset(pEF, (d.lag || 0) + 1, ctx);
        } else { // SS
          cand = addWorkdayOffset(pES, d.lag || 0, ctx);
        }
        if (best === null || compare(cand, best) > 0) best = cand;
      }
      // tanggal mulai manual yang lebih akhir tetap dihormati
      earliest = best || t.start_date || defaultStart;
      if (t.start_date && compare(t.start_date, earliest) > 0) earliest = t.start_date;
    }
    if (!isWorkday(earliest, ctx)) {
      let g = 0;
      while (!isWorkday(earliest, ctx) && g < 3650) { earliest = addDays(earliest, 1); g++; }
    }
    ES[id] = earliest;
    baseStart[id] = earliest;
    EF[id] = addWorkdays(earliest, t.duration, ctx);
    // catat konflik bila tanggal mulai manual lebih awal dari yang diizinkan dependensi
    if (t.start_date && preds.length > 0) {
      for (const d of preds) {
        const p = byId[d.predecessor_id];
        let earliestAllowed;
        if (d.type === 'FS') {
          earliestAllowed = addWorkdayOffset(EF[d.predecessor_id], (d.lag || 0) + 1, ctx);
        } else {
          earliestAllowed = addWorkdayOffset(ES[d.predecessor_id], d.lag || 0, ctx);
        }
        if (compare(t.start_date, earliestAllowed) < 0) {
          t._conflict = `Tanggal mulai ${t.start_date} lebih awal dari yang diizinkan dependensi ke ${p.name} (paling cepat ${earliestAllowed}).`;
          break;
        }
      }
    }
  }

  // tanggal selesai jaringan = EF terakhir; target proyek dipakai bila lebih akhir
  let networkEnd = null;
  for (const id of topo) {
    if (networkEnd === null || compare(EF[id], networkEnd) > 0) networkEnd = EF[id];
  }
  const projectTarget = byId[topo[0]].project_target;
  // CPM klasik: LF tugas akhir = akhir jaringan (bukan target proyek), agar
  // jalur kritis selalu teridentifikasi. Target dipakai untuk deteksi keterlambatan.
  const lfBase = networkEnd;

  // BACKWARD PASS
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i];
    const succs = succsOf[id];
    if (succs.length === 0) {
      LF[id] = lfBase;
    } else {
      let earliestLF = null;
      for (const d of succs) {
        const sLS = LS[d.successor_id];
        if (sLS === undefined) continue;
        let cand;
        if (d.type === 'FS') {
          cand = addWorkdayOffset(sLS, -((d.lag || 0) + 1), ctx);
        } else { // SS
          cand = addWorkdayOffset(sLS, -(d.lag || 0), ctx);
          // SS: pred harus mulai sebelum/sama dengan successor - lag,
          // tetapi LF pred juga dibatasi agar tidak melewati batas.
          cand = compare(cand, addWorkdays(sLS, byId[d.successor_id].duration - 1, ctx)) <= 0
            ? cand : addWorkdays(sLS, byId[d.successor_id].duration - 1, ctx);
        }
        if (earliestLF === null || compare(cand, earliestLF) < 0) earliestLF = cand;
      }
      LF[id] = earliestLF || lfBase;
    }
    // LF tidak boleh sebelum EF (bila proyek harus selesai tepat waktu, float = 0)
    if (compare(LF[id], EF[id]) < 0) LF[id] = EF[id];
    const t = byId[id];
    LS[id] = subtractWorkdays(LF[id], t.duration, ctx);
    if (compare(LS[id], ES[id]) < 0) LS[id] = ES[id];
  }

  // FLOAT + status kritis
  const rows = [];
  for (const id of topo) {
    const t = byId[id];
    const slack = workdaysBetween(ES[id], LS[id], ctx) - 1; // hari kerja kelonggaran
    const floatVal = Math.max(0, slack);
    rows.push({
      ...t,
      es: ES[id], ef: EF[id], ls: LS[id], lf: LF[id],
      slack: floatVal,
      isCritical: floatVal === 0,
      conflict: t._conflict || null
    });
  }

  // Cari jalur kritis (rantai predecessor dari setiap tugas kritis berfloat 0)
  const criticalSet = new Set(rows.filter(r => r.isCritical).map(r => r.id));
  const paths = [];
  const rowById = {};
  rows.forEach(r => { rowById[r.id] = r; });
  function traceBack(id, acc) {
    const preds = predsOf[id].filter(d => criticalSet.has(d.predecessor_id));
    if (preds.length === 0) { acc.push(id); return acc; }
    // ikuti semua jalur kritis (bisa bercabang)
    const parentPreds = predsOf[id].filter(d => criticalSet.has(d.predecessor_id));
    for (const d of parentPreds) {
      if (acc.includes(d.predecessor_id)) continue;
      const branch = traceBack(d.predecessor_id, [...acc, id]);
      if (branch) paths.push(branch);
    }
    return null;
  }
  rows.filter(r => r.isCritical && predsOf[r.id].length === 0)
    .forEach(r => {
      const chain = [];
      (function walk(id) {
        chain.push(id);
        const next = succsOf[id].filter(d => criticalSet.has(d.successor_id));
        if (next.length > 0) {
          // ambil penerus yang mempertahankan float 0 dengan EF terbesar (jalur pengikat)
          let bestD = next[0];
          for (const d of next) {
            if (compare(EF[d.successor_id], EF[bestD.successor_id]) > 0) bestD = d;
          }
          walk(bestD.successor_id);
        }
      })(r.id);
      paths.push(chain);
    });
  const uniquePaths = [];
  const seen = new Set();
  paths.forEach(p => {
    const key = p.join('>');
    if (!seen.has(key)) { seen.add(key); uniquePaths.push(p); }
  });

  result.ok = true;
  result.tasks = rows;
  result.projectDuration = workdaysBetween(
    rows.reduce((a, r) => (compare(r.es, a) < 0 ? r.es : a), rows[0].es),
    networkEnd, ctx);
  result.estimatedEnd = networkEnd;
  result.targetEnd = projectTarget;
  result.lateThanTarget = (projectTarget && compare(networkEnd, projectTarget) > 0);
  result.criticalPaths = uniquePaths.map(p => p.map(id => ({
    id, name: rowById[id].name, duration: rowById[id].duration,
    es: ES[id], ef: EF[id]
  })));
  result.criticalCount = criticalSet.size;
  return result;
}

// kurangi n hari kerja dari tanggal (untuk backward pass)
function subtractWorkdays(startDate, duration, ctx) {
  if (duration <= 0) return startDate;
  let cur = startDate;
  let guard = 0;
  while (!isWorkday(cur, ctx) && guard < 3650) { cur = addDays(cur, -1); guard++; }
  let count = 1;
  while (count < duration && guard < 5000) {
    cur = addDays(cur, -1);
    guard++;
    if (isWorkday(cur, ctx)) count++;
  }
  return cur;
}

module.exports = {
  getCalendar, isWorkday, addWorkdays, workdaysBetween, addWorkdayOffset,
  loadProjectData, computeCPM, detectCycle, subtractWorkdays
};
