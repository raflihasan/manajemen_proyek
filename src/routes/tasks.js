'use strict';
// Modul tugas & subtugas per proyek.
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin, canManageProject, canAccessProject } = require('../middleware/auth');
const { validateTask } = require('../validate');
const { computeCPM, getCalendar, addWorkdays } = require('../services/scheduler');

const router = express.Router({ mergeParams: true });
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

function loadWithCpm(db, projectId) {
  const cpm = computeCPM(db, projectId);
  const map = {};
  if (cpm.ok) cpm.tasks.forEach(t => { map[t.id] = t; });
  return { cpm, map };
}

function computeTaskDates(db, projectId, startDate, duration) {
  const ctx = getCalendar(db, projectId);
  return { start: startDate, end: addWorkdays(startDate, duration, ctx) };
}

// Daftar tugas (filter: status, prioritas, anggota; pencarian nama)
router.get('/', (req, res) => {
  const a = access(req, res); if (!a) return;
  const { db, project } = a;
  const { cpm, map } = loadWithCpm(db, project.id);
  let tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order, id').all(project.id);

  const f = {
    status: req.query.status || '', priority: req.query.priority || '',
    member: req.query.member || '', q: String(req.query.q || '').trim()
  };
  if (f.status) tasks = tasks.filter(t => t.status === f.status);
  if (f.priority) tasks = tasks.filter(t => t.priority === f.priority);
  if (f.q) tasks = tasks.filter(t => t.name.toLowerCase().includes(f.q.toLowerCase()));
  if (f.member) {
    const ids = db.prepare('SELECT task_id FROM resource_assignments WHERE resource_id = ?')
      .all(Number(f.member)).map(r => r.task_id);
    tasks = tasks.filter(t => ids.includes(t.id));
  }
  const members = db.prepare(`
    SELECT DISTINCT r.id, r.full_name FROM resources r
    JOIN resource_assignments a ON a.resource_id = r.id
    JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ? ORDER BY r.full_name`).all(project.id);
  const resources = db.prepare('SELECT id, full_name, role, is_active FROM resources ORDER BY full_name').all();

  // lengkapi tanggal terhitung + info kritis/dependensi
  tasks = tasks.map(t => {
    const c = map[t.id] || null;
    const calc = (!c && t.start_date) ? computeTaskDates(db, project.id, t.start_date, t.duration) : null;
    return {
      ...t,
      calc_start: c ? c.es : (t.start_date || null),
      calc_end: c ? c.ef : (t.end_date || (calc ? calc.end : null)),
      slack: c ? c.slack : null,
      is_critical: c ? c.isCritical : false,
      conflict: c ? c.conflict : null
    };
  });

  const deps = db.prepare(`
    SELECT d.*, t1.name AS pred_name, t2.name AS succ_name FROM task_dependencies d
    JOIN tasks t1 ON t1.id = d.predecessor_id JOIN tasks t2 ON t2.id = d.successor_id
    WHERE t1.project_id = ?`).all(project.id);
  const assignments = db.prepare(`
    SELECT a.*, r.full_name FROM resource_assignments a
    JOIN resources r ON r.id = a.resource_id JOIN tasks t ON t.id = a.task_id
    WHERE t.project_id = ?`).all(project.id);

  res.render('tasks/list', {
    title: 'Tugas', project, tab: 'tugas', tasks, deps, assignments, members, resources,
    filters: f, cpmError: cpm.ok ? null : cpm.reason,
    canManage: canManageProject(req.session.user)
  });
});

// Form tugas baru
router.get('/baru', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola tugas.' });
  const { db, project } = a;
  const parents = db.prepare('SELECT id, name FROM tasks WHERE project_id = ? AND parent_id IS NULL ORDER BY sort_order').all(project.id);
  const resources = db.prepare('SELECT id, full_name, role, is_active FROM resources ORDER BY full_name').all();
  res.render('tasks/form', { title: 'Tugas Baru', project, task: null, parents, resources, errors: [], old: { priority: 'Sedang', status: 'Belum Dimulai', duration: 1, progress: 0 }, canManage: true });
});

router.post('/baru', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola tugas.' });
  const { db, project } = a;
  const d = { ...req.body, project_id: project.id };
  const errors = validateTask(d);
  const parents = db.prepare('SELECT id, name FROM tasks WHERE project_id = ? AND parent_id IS NULL ORDER BY sort_order').all(project.id);
  const resources = db.prepare('SELECT id, full_name, role, is_active FROM resources ORDER BY full_name').all();
  if (d.parent_id) {
    const p = db.prepare('SELECT id FROM tasks WHERE id = ? AND project_id = ?').get(Number(d.parent_id), project.id);
    if (!p) errors.push('Tugas induk tidak valid.');
  }
  if (errors.length) return res.status(400).render('tasks/form', { title: 'Tugas Baru', project, task: null, parents, resources, errors, old: d, canManage: true });

  const duration = Number(d.duration);
  const start = d.start_date || project.start_date;
  const { end } = computeTaskDates(db, project.id, start, duration);
  const sortOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM tasks WHERE project_id = ?').get(project.id).n;
  const info = db.prepare(`
    INSERT INTO tasks (project_id, parent_id, name, description, start_date, duration, end_date,
      priority, status, progress, notes, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    project.id, d.parent_id ? Number(d.parent_id) : null, d.name.trim(), d.description || '',
    start, duration, end, d.priority, d.status, Number(d.progress), d.notes || '', sortOrder);
  const taskId = info.lastInsertRowid;

  // penugasan awal (jika dipilih)
  (Array.isArray(d.resource_ids) ? d.resource_ids : (d.resource_ids ? [d.resource_ids] : []))
    .forEach(rid => {
      const r = db.prepare('SELECT id FROM resources WHERE id = ?').get(Number(rid));
      if (r) db.prepare('INSERT OR IGNORE INTO resource_assignments (task_id, resource_id, role_on_task, allocation, start_date, end_date) VALUES (?,?,?,?,?,?)')
        .run(taskId, r.id, '', 100, start, end);
    });

  db.prepare("INSERT INTO task_progress_history (task_id, new_progress, new_status, changed_by) VALUES (?,?,?,?)")
    .run(taskId, Number(d.progress), d.status, req.session.user.id);
  req.session.flash = { type: 'success', text: 'Tugas berhasil dibuat.' };
  res.redirect(`/projects/${project.id}/tasks`);
});

// Detail tugas
router.get('/:taskId', (req, res) => {
  const a = access(req, res); if (!a) return;
  const { db, project } = a;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(Number(req.params.taskId), project.id);
  if (!task) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Tugas tidak ditemukan.' });
  const { cpm, map } = loadWithCpm(db, project.id);
  const c = map[task.id] || null;
  const calc = (!c && task.start_date) ? computeTaskDates(db, project.id, task.start_date, task.duration) : null;
  const enriched = {
    ...task,
    calc_start: c ? c.es : task.start_date,
    calc_end: c ? c.ef : (task.end_date || (calc ? calc.end : null)),
    slack: c ? c.slack : null, is_critical: c ? c.isCritical : false,
    conflict: c ? c.conflict : null
  };
  const subtasks = db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order, id').all(task.id)
    .map(t => {
      const cc = map[t.id];
      return { ...t, calc_start: cc ? cc.es : t.start_date, calc_end: cc ? cc.ef : t.end_date, is_critical: cc ? cc.isCritical : false };
    });
  const assignments = db.prepare(`
    SELECT a.*, r.full_name, r.role AS resource_role, r.is_active FROM resource_assignments a
    JOIN resources r ON r.id = a.resource_id WHERE a.task_id = ? ORDER BY r.full_name`).all(task.id);
  const allResources = db.prepare('SELECT id, full_name, role, is_active FROM resources ORDER BY full_name').all();
  const deps = db.prepare(`
    SELECT d.*, t1.name AS pred_name, t2.name AS succ_name FROM task_dependencies d
    JOIN tasks t1 ON t1.id = d.predecessor_id JOIN tasks t2 ON t2.id = d.successor_id
    WHERE d.predecessor_id = ? OR d.successor_id = ?`).all(task.id, task.id);
  const history = db.prepare(`
    SELECT h.*, u.full_name FROM task_progress_history h LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.task_id = ? ORDER BY h.changed_at DESC LIMIT 20`).all(task.id);
  const siblings = db.prepare('SELECT id, name FROM tasks WHERE project_id = ? AND id <> ? ORDER BY sort_order')
    .all(project.id, task.id);

  res.render('tasks/detail', {
    title: task.name, project, tab: 'tugas', task: enriched, subtasks, assignments,
    allResources, deps, history, siblings,
    canManage: canManageProject(req.session.user),
    errors: [], cpmError: cpm.ok ? null : cpm.reason
  });
});

// Form ubah tugas
router.get('/:taskId/edit', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola tugas.' });
  const { db, project } = a;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(Number(req.params.taskId), project.id);
  if (!task) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Tugas tidak ditemukan.' });
  const parents = db.prepare('SELECT id, name FROM tasks WHERE project_id = ? AND parent_id IS NULL AND id <> ? ORDER BY sort_order').all(project.id, task.id);
  const resources = db.prepare('SELECT id, full_name, role, is_active FROM resources ORDER BY full_name').all();
  const assigned = db.prepare('SELECT resource_id FROM resource_assignments WHERE task_id = ?').all(task.id).map(r => r.resource_id);
  res.render('tasks/form', { title: 'Ubah Tugas', project, task, parents, resources, errors: [], old: { assigned }, canManage: true });
});

router.post('/:taskId/edit', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola tugas.' });
  const { db, project } = a;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(Number(req.params.taskId), project.id);
  if (!task) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Tugas tidak ditemukan.' });
  const d = { ...req.body, project_id: project.id };
  const errors = validateTask(d);
  const parents = db.prepare('SELECT id, name FROM tasks WHERE project_id = ? AND parent_id IS NULL AND id <> ? ORDER BY sort_order').all(project.id, task.id);
  const resources = db.prepare('SELECT id, full_name, role, is_active FROM resources ORDER BY full_name').all();
  if (d.parent_id && Number(d.parent_id) === task.id) errors.push('Tugas tidak boleh menjadi induk dirinya sendiri.');
  if (errors.length) return res.status(400).render('tasks/form', { title: 'Ubah Tugas', project, task, parents, resources, errors, old: d, canManage: true });

  const duration = Number(d.duration);
  const start = d.start_date || task.start_date || project.start_date;
  const { end } = computeTaskDates(db, project.id, start, duration);
  const oldProg = task.progress, oldStatus = task.status;
  db.prepare(`
    UPDATE tasks SET parent_id=?, name=?, description=?, start_date=?, duration=?, end_date=?,
      priority=?, status=?, progress=?, notes=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(d.parent_id ? Number(d.parent_id) : null, d.name.trim(), d.description || '',
    start, duration, end, d.priority, d.status, Number(d.progress), d.notes || '', task.id);
  db.prepare("INSERT INTO task_progress_history (task_id, old_progress, new_progress, old_status, new_status, changed_by) VALUES (?,?,?,?,?,?)")
    .run(task.id, oldProg, Number(d.progress), oldStatus, d.status, req.session.user.id);
  req.session.flash = { type: 'success', text: 'Tugas berhasil diperbarui. Jadwal terkait dihitung ulang dari data terbaru.' };
  res.redirect(`/projects/${project.id}/tasks/${task.id}`);
});

// Perbarui progres cepat
router.post('/:taskId/progres', (req, res) => {
  const a = access(req, res); if (!a) return;
  const { db, project } = a;
  const user = req.session.user;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(Number(req.params.taskId), project.id);
  if (!task) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Tugas tidak ditemukan.' });
  // anggota tim hanya boleh mengubah tugas yang ditugaskan kepadanya
  if (user.role === 'anggota') {
    const myRes = db.prepare(`
      SELECT 1 FROM resource_assignments a JOIN resources r ON r.id = a.resource_id
      WHERE a.task_id = ? AND r.email = ?`).get(task.id, user.email);
    const myUser = db.prepare(`
      SELECT 1 FROM resource_assignments a WHERE a.task_id = ? AND a.resource_id =
      (SELECT id FROM resources WHERE email = ?)`).get(task.id, user.email);
    if (!myRes && !myUser) {
      const assignedUsers = db.prepare(`
        SELECT 1 FROM resource_assignments a JOIN resources r ON r.id = a.resource_id
        WHERE a.task_id = ? AND r.email = ?`).get(task.id, user.email || '');
      if (!assignedUsers) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Anda tidak ditugaskan pada tugas ini.' });
    }
  }
  let progress = Number(req.body.progress);
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    req.session.flash = { type: 'error', text: 'Progres harus berada antara 0 dan 100.' };
    return res.redirect(`/projects/${project.id}/tasks/${task.id}`);
  }
  let status = req.body.status || task.status;
  const allowedStatus = ['Belum Dimulai', 'Berjalan', 'Terhambat', 'Selesai', 'Dibatalkan'];
  if (!allowedStatus.includes(status)) status = task.status;
  if (status === 'Selesai') progress = 100;
  if (progress === 100 && (status === 'Berjalan' || status === 'Belum Dimulai')) status = 'Selesai';
  if (progress < 100 && status === 'Selesai') status = 'Berjalan';
  db.prepare(`UPDATE tasks SET progress=?, status=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(progress, status, task.id);
  db.prepare("INSERT INTO task_progress_history (task_id, old_progress, new_progress, old_status, new_status, changed_by) VALUES (?,?,?,?,?,?)")
    .run(task.id, task.progress, progress, task.status, status, user.id);
  req.session.flash = { type: 'success', text: 'Progres tugas diperbarui.' };
  res.redirect(`/projects/${project.id}/tasks/${task.id}`);
});

// Hapus tugas (dengan pemeriksaan relasi)
router.post('/:taskId/delete', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola tugas.' });
  const { db, project } = a;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(Number(req.params.taskId), project.id);
  if (!task) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Tugas tidak ditemukan.' });
  const dependents = db.prepare('SELECT COUNT(*) AS n FROM task_dependencies WHERE predecessor_id = ? OR successor_id = ?').get(task.id, task.id).n;
  const asg = db.prepare('SELECT COUNT(*) AS n FROM resource_assignments WHERE task_id = ?').get(task.id).n;
  const subtasks = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?').get(task.id).n;
  if (dependents > 0 && !req.body.konfirmasi) {
    req.session.flash = { type: 'error', text: `Tugas memiliki ${dependents} relasi dependensi. Hapus dependensi terlebih dahulu atau konfirmasi penghapusan untuk menghapusnya beserta relasinya.` };
    return res.redirect(`/projects/${project.id}/tasks/${task.id}`);
  }
  // penghapusan kaskade: subtugas, dependensi, penugasan (FK ON DELETE CASCADE)
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  req.session.flash = { type: 'success', text: `Tugas dihapus (termasuk ${subtasks} subtugas, ${dependents} dependensi, ${asg} penugasan terkait).` };
  res.redirect(`/projects/${project.id}/tasks`);
});

// Ubah urutan tugas
router.post('/:taskId/urutan', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang.' });
  const { db, project } = a;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(Number(req.params.taskId), project.id);
  if (!task) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Tugas tidak ditemukan.' });
  const dir = req.body.arah === 'naik' ? -1 : 1;
  const siblings = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND parent_id IS ? ORDER BY sort_order, id')
    .all(project.id, task.parent_id);
  const idx = siblings.findIndex(t => t.id === task.id);
  const swap = siblings[idx + dir];
  if (swap) {
    db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?').run(swap.sort_order, task.id);
    db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?').run(task.sort_order, swap.id);
  }
  res.redirect(req.get('Referer') || `/projects/${project.id}/tasks`);
});

module.exports = router;
