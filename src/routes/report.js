'use strict';
// Halaman Laporan Proyek + ekspor CSV.
const express = require('express');
const { requireLogin, canManageProject } = require('../middleware/auth');
const { projectAccess } = require('../middleware/projectAccess');
const { computeCPM } = require('../services/scheduler');
const { computeWorkload, estimateCost } = require('../services/resourceWorkload');
const { compare } = require('../utils/date');

const router = express.Router({ mergeParams: true });
router.use(requireLogin, projectAccess);

function buildReport(db, project, today) {
  const manager = db.prepare('SELECT full_name FROM users WHERE id = ?').get(project.manager_id);
  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order, id').all(project.id);
  const parents = tasks.filter(t => !t.parent_id);
  const members = db.prepare(`
    SELECT u.full_name, u.role, u.email FROM project_members pm
    JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.full_name`).all(project.id);

  let cpm = null;
  try { cpm = computeCPM(db, project.id); } catch (e) { console.error('CPM laporan:', e.message); }
  const cpmMap = {};
  if (cpm && cpm.ok) cpm.tasks.forEach(t => { cpmMap[t.id] = t; });

  // progres berbobot durasi (tugas induk)
  const totalDur = parents.reduce((s, t) => s + Math.max(1, t.duration), 0);
  const weighted = parents.reduce((s, t) => s + Math.max(1, t.duration) * (t.progress || 0), 0);
  const progress = totalDur ? Math.round(weighted / totalDur) : 0;

  const overdue = tasks.filter(t => t.parent_id === null &&
    t.status !== 'Selesai' && t.status !== 'Dibatalkan' && t.end_date && compare(t.end_date, today) < 0);
  const critical = cpm && cpm.ok ? cpm.tasks.filter(t => t.isCritical) : [];

  const assignments = db.prepare(`
    SELECT a.*, t.name AS task_name, r.full_name AS resource_name, r.rate, r.rate_unit
    FROM resource_assignments a JOIN tasks t ON t.id = a.task_id
    JOIN resources r ON r.id = a.resource_id WHERE t.project_id = ?`).all(project.id);

  let workload = { rows: [], conflicts: [] };
  let cost = { items: [], total: 0, assumptions: '' };
  try {
    const start = project.start_date;
    const end = (cpm && cpm.ok && cpm.estimatedEnd) ? cpm.estimatedEnd : project.target_end_date;
    workload = computeWorkload(db, project.id, start, end);
    cost = estimateCost(db, project.id, start, end);
  } catch (e) { console.error('Workload laporan:', e.message); }

  const statusCounts = {
    total: tasks.length, selesai: tasks.filter(t => t.status === 'Selesai').length,
    berjalan: tasks.filter(t => t.status === 'Berjalan').length,
    belum: tasks.filter(t => t.status === 'Belum Dimulai').length,
    terhambat: tasks.filter(t => t.status === 'Terhambat').length,
    batal: tasks.filter(t => t.status === 'Dibatalkan').length
  };

  return { manager, tasks, parents, members, cpm, cpmMap, progress, overdue,
    critical, assignments, workload, cost, statusCounts };
}

router.get('/', (req, res) => {
  const db = req.db, project = req.project;
  const data = buildReport(db, project, res.locals.today);
  res.render('report', {
    title: 'Laporan Proyek', project, tab: 'laporan', ...data,
    canManage: canManageProject(req.session.user)
  });
});

// Ekspor CSV
router.get('/csv', (req, res) => {
  const db = req.db, project = req.project;
  const data = buildReport(db, project, res.locals.today);
  const esc = v => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const lines = [];
  lines.push(['Laporan Proyek', project.name].map(esc).join(','));
  lines.push(['Organisasi', project.organization].map(esc).join(','));
  lines.push(['Perkiraan selesai', (data.cpm && data.cpm.ok) ? data.cpm.estimatedEnd : '-'].map(esc).join(','));
  lines.push(['Progres proyek (%)', data.progress].map(esc).join(','));
  lines.push('');
  lines.push(['ID', 'Nama Tugas', 'Induk', 'Mulai', 'Durasi', 'Selesai', 'Prioritas', 'Status', 'Progres', 'ES', 'EF', 'LS', 'LF', 'Slack', 'Kritis'].map(esc).join(','));
  data.tasks.forEach(t => {
    const c = data.cpmMap[t.id];
    lines.push([
      t.id, t.name, t.parent_id || '', t.start_date || (c ? c.es : ''), t.duration,
      t.end_date || (c ? c.ef : ''), t.priority, t.status, t.progress,
      c ? c.es : '', c ? c.ef : '', c ? c.ls : '', c ? c.lf : '',
      c ? c.slack : '', c ? (c.isCritical ? 'YA' : 'tidak') : ''
    ].map(esc).join(','));
  });
  lines.push('');
  lines.push(['Anggota', 'Peran', 'Tugas Ditugaskan', 'Total Alokasi (%)'].map(esc).join(','));
  data.workload.rows.forEach(r => {
    lines.push([r.resource.full_name, r.resource.role,
      r.assignments.map(a => a.task_name).join('; '),
      Object.values(r.daily).reduce((a, b) => a + b, 0)].map(esc).join(','));
  });
  const filename = `laporan-${project.name.replace(/[^\w]+/g, '-').toLowerCase()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + lines.join('\r\n'));
});

module.exports = router;
