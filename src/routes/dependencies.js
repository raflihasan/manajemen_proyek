'use strict';
// Modul ketergantungan tugas (FS/SS + lag) dengan validasi siklus.
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin, canManageProject, canAccessProject } = require('../middleware/auth');
const { validateDependency } = require('../validate');
const { computeCPM, detectCycle } = require('../services/scheduler');

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

function renderPage(req, res, a, errors = [], extra = {}) {
  const { db, project } = a;
  const tasks = db.prepare('SELECT id, name, parent_id FROM tasks WHERE project_id = ? ORDER BY sort_order, id').all(project.id);
  const deps = db.prepare(`
    SELECT d.*, t1.name AS pred_name, t2.name AS succ_name FROM task_dependencies d
    JOIN tasks t1 ON t1.id = d.predecessor_id JOIN tasks t2 ON t2.id = d.successor_id
    WHERE t1.project_id = ? AND t2.project_id = ? ORDER BY d.id`).all(project.id, project.id);
  const cycle = detectCycle(tasks, deps);
  res.render('dependencies', {
    title: 'Ketergantungan Tugas', project, tab: 'dependensi', tasks, deps,
    errors, cycleDetected: cycle.hasCycle, old: {},
    canManage: canManageProject(req.session.user), ...extra
  });
}

router.get('/', (req, res) => {
  const a = access(req, res); if (!a) return;
  renderPage(req, res, a, req.query.error ? [decodeURIComponent(req.query.error)] : []);
});

router.post('/tambah', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola dependensi.' });
  const { db, project } = a;
  const d = req.body;
  const errors = validateDependency(d);
  const predId = Number(d.predecessor_id), succId = Number(d.successor_id);

  if (!errors.length) {
    if (predId === succId) errors.push('Tugas tidak boleh bergantung pada dirinya sendiri.');
    const pred = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(predId);
    const succ = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(succId);
    if (!pred || !succ) errors.push('Tugas pendahulu atau penerus tidak valid.');
    else if (pred.project_id !== project.id || succ.project_id !== project.id)
      errors.push('Tugas pendahulu dan penerus harus berasal dari proyek yang sama.');
    else if (pred.project_id !== succ.project_id)
      errors.push('Tugas pendahulu dan penerus harus berasal dari proyek yang sama.');
    const dup = db.prepare('SELECT id FROM task_dependencies WHERE predecessor_id = ? AND successor_id = ?').get(predId, succId);
    if (dup) errors.push('Hubungan dependensi antara kedua tugas tersebut sudah ada.');
  }

  // uji siklus: simulasikan penambahan lalu periksa
  if (!errors.length) {
    const tasks = db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(project.id);
    const deps = db.prepare(`
      SELECT predecessor_id, successor_id FROM task_dependencies d
      JOIN tasks t ON t.id = d.predecessor_id WHERE t.project_id = ?`).all(project.id);
    deps.push({ predecessor_id: predId, successor_id: succId });
    const c = detectCycle(tasks, deps);
    if (c.hasCycle) {
      errors.push('Dependensi ditolak karena menyebabkan siklus dependensi (lingkaran) yang membuat jadwal tidak dapat dihitung. Periksa kembali hubungan antar tugas.');
    }
  }

  if (errors.length) {
    res.status(400);
    return renderPage(req, res, a, errors, { old: d });
  }
  db.prepare('INSERT INTO task_dependencies (predecessor_id, successor_id, type, lag, notes) VALUES (?,?,?,?,?)')
    .run(predId, succId, d.type, Number(d.lag || 0), d.notes || '');
  req.session.flash = { type: 'success', text: 'Hubungan ketergantungan ditambahkan dan jadwal dihitung ulang.' };
  res.redirect(`/projects/${project.id}/dependencies`);
});

router.post('/:depId/edit', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola dependensi.' });
  const { db, project } = a;
  const dep = db.prepare(`
    SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.predecessor_id
    WHERE d.id = ? AND t.project_id = ?`).get(Number(req.params.depId), project.id);
  if (!dep) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Dependensi tidak ditemukan.' });
  const d = req.body;
  const errors = [];
  if (!['FS', 'SS'].includes(d.type)) errors.push('Jenis dependensi harus FS atau SS.');
  const lag = Number(d.lag);
  if (!Number.isInteger(lag) || lag < 0) errors.push('Lag harus berupa angka bulat tidak negatif.');
  if (errors.length) return renderPage(req, res, a, errors, { old: d });
  db.prepare('UPDATE task_dependencies SET type = ?, lag = ?, notes = ? WHERE id = ?')
    .run(d.type, lag, d.notes || '', dep.id);
  req.session.flash = { type: 'success', text: 'Dependensi diperbarui.' };
  res.redirect(`/projects/${project.id}/dependencies`);
});

router.post('/:depId/delete', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola dependensi.' });
  const { db, project } = a;
  const dep = db.prepare(`
    SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.predecessor_id
    WHERE d.id = ? AND t.project_id = ?`).get(Number(req.params.depId), project.id);
  if (!dep) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Dependensi tidak ditemukan.' });
  db.prepare('DELETE FROM task_dependencies WHERE id = ?').run(dep.id);
  req.session.flash = { type: 'success', text: 'Dependensi dihapus.' };
  res.redirect(`/projects/${project.id}/dependencies`);
});

module.exports = router;
