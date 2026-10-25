'use strict';
// API JSON untuk visualisasi (Gantt, PERT, Resource Chart, Jalur Kritis).
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin, canManageProject, canAccessProject } = require('../middleware/auth');
const { computeCPM, getCalendar, addWorkdays, workdaysBetween } = require('../services/scheduler');
const { computeWorkload } = require('../services/resourceWorkload');
const { compare, addDays, toISODate } = require('../utils/date');

const router = express.Router();
router.use(requireLogin);

function guard(req, res) {
  const db = getDb();
  const r = canAccessProject(db, req.session.user, Number(req.params.id));
  if (!r.ok) { res.status(r.project ? 403 : 404).json({ ok: false, message: r.reason || 'Proyek tidak ditemukan.' }); return null; }
  return { db, project: r.project };
}

// --- data Gantt ---
router.get('/projects/:id/gantt', (req, res) => {
  const g = guard(req, res); if (!g) return;
  const { db, project } = g;
  let cpm = null;
  try { cpm = computeCPM(db, project.id); } catch (e) { console.error('CPM gantt:', e.message); }
  const cpmMap = {};
  if (cpm && cpm.ok) cpm.tasks.forEach(t => { cpmMap[t.id] = t; });

  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order, id').all(project.id);
  const deps = db.prepare(`
    SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.predecessor_id
    WHERE t.project_id = ?`).all(project.id);
  const assignments = db.prepare(`
    SELECT a.task_id, a.resource_id, r.full_name FROM resource_assignments a
    JOIN resources r ON r.id = a.resource_id JOIN tasks t ON t.id = a.task_id
    WHERE t.project_id = ?`).all(project.id);
  const calendarCtx = getCalendar(db, project.id);

  const rows = tasks.map(t => {
    const c = cpmMap[t.id];
    const start = c ? c.es : t.start_date;
    const end = c ? c.ef : t.end_date;
    return {
      id: t.id, parent_id: t.parent_id, name: t.name, duration: t.duration,
      priority: t.priority, status: t.status, progress: t.progress,
      start, end, sort_order: t.sort_order,
      is_critical: c ? c.isCritical : false, slack: c ? c.slack : null,
      conflict: c ? c.conflict : null,
      assignees: assignments.filter(a => a.task_id === t.id).map(a => a.full_name)
    };
  });

  res.json({
    ok: true, project: { id: project.id, name: project.name, start: project.start_date, target: project.target_end_date },
    tasks: rows, deps,
    holidays: calendarCtx.holidays,
    workdayMap: calendarCtx.workdayMap,
    cpm_ok: !!(cpm && cpm.ok), cpm_reason: cpm && !cpm.ok ? cpm.reason : null,
    estimatedEnd: cpm && cpm.ok ? cpm.estimatedEnd : null
  });
});

// Reschedule via drag-and-drop (divalidasi terhadap dependensi + kalender kerja)
router.post('/projects/:id/gantt/reschedule', (req, res) => {
  const g = guard(req, res); if (!g) return;
  if (!canManageProject(req.session.user)) return res.status(403).json({ ok: false, message: 'Tidak berwenang mengubah jadwal.' });
  const { db, project } = g;
  const { task_id, new_start } = req.body;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(Number(task_id), project.id);
  if (!task) return res.status(404).json({ ok: false, message: 'Tugas tidak ditemukan.' });
  if (!new_start || !/^\d{4}-\d{2}-\d{2}$/.test(new_start))
    return res.status(400).json({ ok: false, message: 'Tanggal mulai tidak valid.' });

  const ctx = getCalendar(db, project.id);
  let start = new_start;
  let guardN = 0;
  const { isWorkday } = require('../services/scheduler');
  while (!isWorkday(start, ctx) && guardN < 60) { start = addDays(start, 1); guardN++; }
  const end = addWorkdays(start, task.duration, ctx);

  // validasi terhadap pendahulu (FS/SS)
  const preds = db.prepare('SELECT * FROM task_dependencies WHERE successor_id = ?').all(task.id);
  for (const d of preds) {
    const p = db.prepare('SELECT * FROM tasks WHERE id = ?').get(d.predecessor_id);
    if (!p) continue;
    const pcpm = computeCPM(db, project.id);
    const pRow = pcpm.ok ? pcpm.tasks.find(x => x.id === p.id) : null;
    const pEF = pRow ? pRow.ef : p.end_date;
    const pES = pRow ? pRow.es : p.start_date;
    if (!pEF) continue;
    let earliest;
    if (d.type === 'FS') earliest = require('../services/scheduler').addWorkdayOffset(pEF, (d.lag || 0) + 1, ctx);
    else earliest = require('../services/scheduler').addWorkdayOffset(pES, d.lag || 0, ctx);
    if (compare(start, earliest) < 0) {
      return res.status(400).json({
        ok: false,
        message: `Jadwal ditolak: tugas "${task.name}" memiliki ketergantungan ${d.type}${d.lag ? ' dengan lag ' + d.lag : ''} dari "${p.name}", sehingga paling cepat dimulai ${earliest}.`
      });
    }
  }

  db.prepare(`UPDATE tasks SET start_date=?, end_date=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(start, end, task.id);
  res.json({ ok: true, message: `Jadwal "${task.name}" dipindahkan ke ${start} – ${end}.`, start, end });
});

// --- data PERT ---
router.get('/projects/:id/pert', (req, res) => {
  const g = guard(req, res); if (!g) return;
  const { db, project } = g;
  let cpm = null;
  try { cpm = computeCPM(db, project.id); } catch (e) { console.error('CPM pert:', e.message); }
  const cpmMap = {};
  if (cpm && cpm.ok) cpm.tasks.forEach(t => { cpmMap[t.id] = t; });
  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order, id').all(project.id);
  const deps = db.prepare(`
    SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.predecessor_id
    WHERE t.project_id = ?`).all(project.id);
  res.json({
    ok: true,
    nodes: tasks.map(t => {
      const c = cpmMap[t.id];
      return {
        id: t.id, name: t.name, duration: t.duration, status: t.status,
        progress: t.progress, parent_id: t.parent_id,
        start: c ? c.es : t.start_date, end: c ? c.ef : t.end_date,
        slack: c ? c.slack : null, is_critical: c ? c.isCritical : false
      };
    }),
    edges: deps.map(d => ({ id: d.id, from: d.predecessor_id, to: d.successor_id, type: d.type, lag: d.lag })),
    cpm_ok: !!(cpm && cpm.ok), cpm_reason: cpm && !cpm.ok ? cpm.reason : null
  });
});

// --- data Resource Chart ---
router.get('/projects/:id/resource', (req, res) => {
  const g = guard(req, res); if (!g) return;
  const { db, project } = g;
  const today = toISODate(new Date());
  let cpm = null;
  try { cpm = computeCPM(db, project.id); } catch (e) {}
  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(project.id);
  let start = project.start_date;
  let end = (cpm && cpm.ok && cpm.estimatedEnd) ? cpm.estimatedEnd : project.target_end_date;
  if (req.query.start && /^\d{4}-\d{2}-\d{2}$/.test(req.query.start)) start = req.query.start;
  if (req.query.end && /^\d{4}-\d{2}-\d{2}$/.test(req.query.end)) end = req.query.end;
  if (compare(end, start) < 0) { const t = start; start = end; end = t; }
  let data = { rows: [], conflicts: [], dates: [] };
  try { data = computeWorkload(db, project.id, start, end); } catch (e) { console.error('Resource:', e.message); }
  res.json({ ok: true, start, end, rows: data.rows, conflicts: data.conflicts, dates: data.dates });
});

// --- data jalur kritis (untuk konsistensi lintas halaman) ---
router.get('/projects/:id/critical', (req, res) => {
  const g = guard(req, res); if (!g) return;
  let cpm = null;
  try { cpm = computeCPM(g.db, g.project.id); } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
  res.json(cpm.ok ? {
    ok: true, tasks: cpm.tasks, criticalPaths: cpm.criticalPaths,
    projectDuration: cpm.projectDuration, estimatedEnd: cpm.estimatedEnd,
    targetEnd: cpm.targetEnd, lateThanTarget: cpm.lateThanTarget
  } : { ok: false, message: cpm.reason });
});

module.exports = router;
