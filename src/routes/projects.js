'use strict';
// Modul proyek: daftar, buat, ubah, hapus, detail (tab ringkasan).
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin, canManageProject, canAccessProject } = require('../middleware/auth');
const { validateProject } = require('../validate');
const { computeCPM, getCalendar, workdaysBetween } = require('../services/scheduler');

const router = express.Router();
router.use(requireLogin);

function access(req, res) {
  const db = getDb();
  const r = canAccessProject(db, req.session.user, Number(req.params.id));
  if (!r.ok) {
    res.status(r.project ? 403 : 404).render('error', {
      title: 'Tidak Berwenang', message: r.reason || 'Proyek tidak ditemukan.'
    });
    return null;
  }
  return { db, project: r.project };
}

// Daftar proyek
router.get('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const q = String(req.query.q || '').trim();
  const filterStatus = req.query.status || '';
  let sql = `SELECT p.*, u.full_name AS manager_name FROM projects p
             LEFT JOIN users u ON u.id = p.manager_id`;
  const params = [];
  const where = [];
  if (user.role === 'manajer') {
    where.push('(p.manager_id = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?))');
    params.push(user.id, user.id);
  } else if (user.role === 'anggota') {
    where.push('EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?)');
    params.push(user.id);
  }
  if (q) { where.push('(p.name LIKE ? OR p.organization LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (filterStatus) { where.push('p.status = ?'); params.push(filterStatus); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY p.start_date DESC';
  const projects = db.prepare(sql).all(...params);

  // progres aktual (berbobot durasi) + keterlambatan
  for (const p of projects) {
    try {
      const cpm = computeCPM(db, p.id);
      p.est_end = cpm.ok ? cpm.estimatedEnd : null;
      p.late = cpm.ok && cpm.lateThanTarget;
      p.critical_count = cpm.ok ? cpm.criticalCount : 0;
    } catch (e) { p.est_end = null; p.late = false; p.critical_count = 0; }
  }
  res.render('projects/list', {
    title: 'Daftar Proyek', projects, q, filterStatus,
    canManage: canManageProject(req.session.user)
  });
});

// Form buat proyek
router.get('/baru', (req, res) => {
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Hanya Admin dan Manajer Proyek yang dapat membuat proyek.' });
  const db = getDb();
  const users = db.prepare("SELECT id, full_name, role FROM users WHERE is_active = 1 ORDER BY full_name").all();
  res.render('projects/form', { title: 'Proyek Baru', project: null, users, errors: [], old: {} });
});

router.post('/baru', (req, res) => {
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang.' });
  const db = getDb();
  const d = req.body;
  const errors = validateProject(d);
  const users = db.prepare("SELECT id, full_name, role FROM users WHERE is_active = 1 ORDER BY full_name").all();
  if (errors.length) return res.status(400).render('projects/form', { title: 'Proyek Baru', project: null, users, errors, old: d });
  const managerId = Number(d.manager_id) || req.session.user.id;
  const mgr = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(managerId);
  if (!mgr) { errors.push('Manajer proyek harus merupakan pengguna yang valid.'); return res.status(400).render('projects/form', { title: 'Proyek Baru', project: null, users, errors, old: d }); }

  const info = db.prepare(`
    INSERT INTO projects (name, organization, description, location, start_date, target_end_date, manager_id, status, progress)
    VALUES (?,?,?,?,?,?,?,?,0)`).run(
    d.name.trim(), d.organization.trim(), d.description || '', d.location || '',
    d.start_date, d.target_end_date, managerId, d.status || 'Perencanaan');
  const pid = info.lastInsertRowid;
  db.prepare('INSERT INTO work_calendars (project_id, work_start, work_end) VALUES (?,?,?)').run(pid, '08:00', '17:00');
  const cal = db.prepare('SELECT id FROM work_calendars WHERE project_id = ?').get(pid);
  const insWd = db.prepare('INSERT INTO calendar_workdays (calendar_id, day_of_week, is_workday) VALUES (?,?,?)');
  for (let i = 0; i <= 6; i++) insWd.run(cal.id, i, (i === 0 || i === 6) ? 0 : 1);
  db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?,?)').run(pid, managerId);
  req.session.flash = { type: 'success', text: 'Proyek berhasil dibuat.' };
  res.redirect(`/projects/${pid}`);
});

// Detail proyek (tab ringkasan)
router.get('/:id', (req, res) => {
  const a = access(req, res); if (!a) return;
  const { db, project } = a;
  project.manager_name = (db.prepare('SELECT full_name FROM users WHERE id = ?').get(project.manager_id) || {}).full_name || '-';
  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(project.id);
  const members = db.prepare(`
    SELECT u.id, u.full_name, u.role, pm.id AS pm_id FROM project_members pm
    JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.full_name`).all(project.id);
  const resources = db.prepare(`
    SELECT DISTINCT r.* FROM resources r JOIN resource_assignments a ON a.resource_id = r.id
    JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ? ORDER BY r.full_name`).all(project.id);

  // progres berbobot durasi (tugas induk saja agar subtugas tidak ganda)
  const parents = tasks.filter(t => !t.parent_id);
  const totalDur = parents.reduce((s, t) => s + Math.max(1, t.duration), 0);
  const weighted = parents.reduce((s, t) => s + Math.max(1, t.duration) * (t.progress || 0), 0);
  const progress = totalDur ? Math.round(weighted / totalDur) : 0;
  if (progress !== project.progress) {
    db.prepare('UPDATE projects SET progress = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(progress, project.id);
    project.progress = progress;
  }

  let cpm = null, cpmError = null;
  try {
    cpm = computeCPM(db, project.id);
    if (!cpm.ok) cpmError = cpm.reason;
  } catch (e) { cpmError = e.message; }

  const statusCounts = {
    total: tasks.length,
    belum: tasks.filter(t => t.status === 'Belum Dimulai').length,
    berjalan: tasks.filter(t => t.status === 'Berjalan').length,
    selesai: tasks.filter(t => t.status === 'Selesai').length,
    terhambat: tasks.filter(t => t.status === 'Terhambat').length
  };
  res.render('projects/detail', {
    title: project.name, project, tab: 'ringkasan', members, resources,
    tasks, statusCounts, cpm, cpmError,
    canManage: canManageProject(req.session.user),
    isMember: true, workdays: cpm && cpm.ok ? cpm.projectDuration : 0
  });
});

// Form edit proyek
router.get('/:id/edit', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Hanya Admin dan Manajer Proyek yang dapat mengubah proyek.' });
  const db = a.db;
  const users = db.prepare("SELECT id, full_name, role FROM users WHERE is_active = 1 ORDER BY full_name").all();
  res.render('projects/form', { title: 'Ubah Proyek', project: a.project, users, errors: [], old: {} });
});

router.post('/:id/edit', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang.' });
  const db = a.db, d = req.body;
  const errors = validateProject(d);
  const users = db.prepare("SELECT id, full_name, role FROM users WHERE is_active = 1 ORDER BY full_name").all();
  if (errors.length) return res.status(400).render('projects/form', { title: 'Ubah Proyek', project: a.project, users, errors, old: d });
  const managerId = Number(d.manager_id) || a.project.manager_id;
  db.prepare(`
    UPDATE projects SET name=?, organization=?, description=?, location=?, start_date=?,
      target_end_date=?, manager_id=?, status=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(d.name.trim(), d.organization.trim(), d.description || '', d.location || '',
    d.start_date, d.target_end_date, managerId, d.status, a.project.id);
  db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?,?)').run(a.project.id, managerId);
  req.session.flash = { type: 'success', text: 'Proyek berhasil diperbarui.' };
  res.redirect(`/projects/${a.project.id}`);
});

// Hapus proyek
router.post('/:id/delete', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Hanya Admin yang dapat menghapus proyek.' });
  }
  const db = a.db;
  const berjalan = a.project.status === 'Berjalan';
  const tugasAktif = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ('Berjalan','Terhambat')"
  ).get(a.project.id).n;
  if (berjalan && tugasAktif > 0 && !req.body.konfirmasi) {
    return res.status(400).render('error', {
      title: 'Penghapusan Ditolak',
      message: `Proyek berjalan memiliki ${tugasAktif} tugas aktif. Ubah status proyek atau selesaikan tugas terlebih dahulu, atau ulangi dengan konfirmasi hapus paksa.`
    });
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(a.project.id);
  req.session.flash = { type: 'success', text: 'Proyek berhasil dihapus beserta data turunannya.' };
  res.redirect('/projects');
});

module.exports = router;
