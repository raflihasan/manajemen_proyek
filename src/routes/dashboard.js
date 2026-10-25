'use strict';
// Dashboard: ringkasan proyek, tugas, jadwal terdekat, dan tugas kritis.
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { computeCPM } = require('../services/scheduler');
const { compare } = require('../utils/date');

const router = express.Router();

function projectScope(db, user) {
  if (user.role === 'admin') return { sql: '', params: [] };
  if (user.role === 'manajer') {
    return {
      sql: ' WHERE (p.manager_id = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?))',
      params: [user.id, user.id]
    };
  }
  return {
    sql: ' WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?)',
    params: [user.id]
  };
}

router.get(['/', '/dashboard'], requireLogin, (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const scope = projectScope(db, user);
  const projects = db.prepare(
    `SELECT p.*, u.full_name AS manager_name FROM projects p
     LEFT JOIN users u ON u.id = p.manager_id ${scope.sql}
     ORDER BY p.start_date DESC`
  ).all(...scope.params);

  // hitung ulang progres proyek (rata-rata berbobot durasi tugas induk)
  const stats = {
    total: projects.length, berjalan: 0, selesai: 0, ditunda: 0, perencanaan: 0, dibatalkan: 0
  };
  projects.forEach(p => {
    const key = String(p.status).toLowerCase();
    if (stats[key] !== undefined) stats[key]++;
  });

  const projectIds = projects.map(p => p.id);
  let tasks = [];
  if (projectIds.length) {
    const ph = projectIds.map(() => '?').join(',');
    tasks = db.prepare(
      `SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.project_id IN (${ph}) AND t.parent_id IS NULL`
    ).all(...projectIds);
  }

  const taskStats = {
    total: tasks.length,
    belum: tasks.filter(t => t.status === 'Belum Dimulai').length,
    berjalan: tasks.filter(t => t.status === 'Berjalan').length,
    selesai: tasks.filter(t => t.status === 'Selesai').length,
    batal: tasks.filter(t => t.status === 'Dibatalkan').length
  };

  // tugas terlambat (target proyek terlewati & belum selesai) & jadwal terdekat
  const today = res.locals.today;
  const overdue = tasks.filter(t =>
    t.status !== 'Selesai' && t.status !== 'Dibatalkan' &&
    t.end_date && compare(t.end_date, today) < 0);

  // jalur kritis per proyek (hitung hanya proyek berjalan/perencanaan)
  let criticalTasks = [];
  const upcoming = [];
  for (const p of projects) {
    if (p.status === 'Selesai' || p.status === 'Dibatalkan') continue;
    try {
      const cpm = computeCPM(db, p.id);
      if (cpm.ok) {
        cpm.tasks.filter(t => t.isCritical && t.status !== 'Selesai').forEach(t => {
          criticalTasks.push({ ...t, project_name: p.name, project_id: p.id });
        });
        // perkiraan keterlambatan
        p.est_end = cpm.estimatedEnd;
        p.late = cpm.lateThanTarget;
      }
    } catch (e) { console.error('CPM dashboard gagal untuk proyek', p.id, e.message); }
  }

  tasks.filter(t => t.status !== 'Selesai' && t.status !== 'Dibatalkan')
    .sort((a, b) => (a.end_date || '9999') < (b.end_date || '9999') ? -1 : 1)
    .slice(0, 8).forEach(t => upcoming.push(t));

  res.render('dashboard', {
    title: 'Dashboard', stats, taskStats, projects,
    criticalTasks: criticalTasks.slice(0, 8), overdue: overdue.slice(0, 8), upcoming
  });
});

module.exports = router;
