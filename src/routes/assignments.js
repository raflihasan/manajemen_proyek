'use strict';
// Modul penugasan sumber daya ke tugas + peringatan konflik.
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin, canManageProject, canAccessProject } = require('../middleware/auth');
const { validateAssignment } = require('../validate');
const { computeWorkload } = require('../services/resourceWorkload');
const { compare, rangeDates, addDays } = require('../utils/date');

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

// Konflik untuk satu penugasan (dihitung dari data aktual).
function assignmentConflicts(db, projectId, a) {
  const conflicts = [];
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(a.task_id);
  const res = db.prepare('SELECT * FROM resources WHERE id = ?').get(a.resource_id);
  if (!task || !res) return conflicts;
  const s = a.start_date || task.start_date;
  const e = a.end_date || task.end_date || task.start_date;

  if (res.is_active !== 1) {
    conflicts.push(`Anggota "${res.full_name}" berstatus nonaktif tetapi masih ditugaskan.`);
  }
  // alokasi pada hari yang sama melebihi 100%
  if (s && e) {
    const others = db.prepare(`
      SELECT a2.*, t2.name AS task_name, t2.start_date AS ts, t2.end_date AS te
      FROM resource_assignments a2 JOIN tasks t2 ON t2.id = a2.task_id
      WHERE a2.resource_id = ? AND a2.task_id <> ? AND t2.project_id = ?`)
      .all(res.id, task.id, projectId);
    for (const d of rangeDates(s, e)) {
      let total = a.allocation || 0;
      for (const o of others) {
        const os = o.start_date || o.ts, oe = o.end_date || o.te;
        if (os && oe && compare(d, os) >= 0 && compare(d, oe) <= 0) total += (o.allocation || 0);
      }
      if (total > 100) {
        conflicts.push(`Alokasi gabungan ${res.full_name} mencapai ${total}% pada ${d} (melebihi kapasitas 100%).`);
      }
    }
    // bertabrakan dengan hari libur pribadi
    const abs = db.prepare(`
      SELECT * FROM resource_unavailability WHERE resource_id = ? AND status <> 'Ditolak'
        AND start_date <= ? AND end_date >= ?`).all(res.id, e, s);
    abs.forEach(x => {
      conflicts.push(`Penugasan bertabrakan dengan ketidakhadiran ${res.full_name} (${x.start_date} s/d ${x.end_date}${x.reason ? ' — ' + x.reason : ''}).`);
    });
  }
  return conflicts;
}

router.get('/', (req, res) => {
  const a = access(req, res); if (!a) return;
  const { db, project } = a;
  const assignments = db.prepare(`
    SELECT a.*, t.name AS task_name, r.full_name AS resource_name, r.role AS resource_role,
           r.is_active AS resource_active, t.start_date AS task_start, t.end_date AS task_end,
           t.status AS task_status
    FROM resource_assignments a
    JOIN tasks t ON t.id = a.task_id
    JOIN resources r ON r.id = a.resource_id
    WHERE t.project_id = ?
    ORDER BY r.full_name, t.name`).all(project.id);
  const tasks = db.prepare('SELECT id, name, start_date, end_date FROM tasks WHERE project_id = ? ORDER BY sort_order, id').all(project.id);
  const resources = db.prepare('SELECT id, full_name, role, is_active FROM resources ORDER BY full_name').all();

  // konflik keseluruhan proyek
  const today = res.locals.today;
  const end = tasks.reduce((acc, t) => (t.end_date && t.end_date > acc) ? t.end_date : acc, today);
  const start = tasks.reduce((acc, t) => (t.start_date && t.start_date < acc) ? t.start_date : acc, today);
  let workload = { rows: [], conflicts: [] };
  try { workload = computeWorkload(db, project.id, start || today, end || today); }
  catch (e) { console.error('Workload gagal:', e.message); }

  // konflik per penugasan
  const withConflicts = assignments.map(x => ({
    ...x, conflicts: assignmentConflicts(db, project.id, x)
  }));
  const conflictList = withConflicts.filter(x => x.conflicts.length);

  res.render('assignments', {
    title: 'Penugasan Sumber Daya', project, tab: 'penugasan',
    assignments: withConflicts, tasks, resources,
    globalConflicts: workload.conflicts, conflictList,
    canManage: canManageProject(req.session.user), errors: [], old: {}
  });
});

router.post('/tambah', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola penugasan.' });
  const { db, project } = a;
  const d = req.body;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(Number(d.task_id), project.id);
  if (!task) {
    req.session.flash = { type: 'error', text: 'Tugas tidak valid.' };
    return res.redirect(`/projects/${project.id}/assignments`);
  }
  const payload = {
    resource_id: d.resource_id, allocation: d.allocation,
    start_date: d.start_date || task.start_date, end_date: d.end_date || task.end_date
  };
  const errors = validateAssignment(payload);
  if (errors.length) {
    req.session.flash = { type: 'error', text: errors.join(' ') };
    return res.redirect(`/projects/${project.id}/assignments`);
  }
  const res0 = db.prepare('SELECT * FROM resources WHERE id = ?').get(Number(d.resource_id));
  if (!res0) {
    req.session.flash = { type: 'error', text: 'Sumber daya tidak valid.' };
    return res.redirect(`/projects/${project.id}/assignments`);
  }
  const dup = db.prepare('SELECT id FROM resource_assignments WHERE task_id = ? AND resource_id = ?').get(task.id, res0.id);
  if (dup) {
    db.prepare('UPDATE resource_assignments SET allocation=?, role_on_task=?, start_date=?, end_date=? WHERE id=?')
      .run(Number(d.allocation), d.role_on_task || '', payload.start_date, payload.end_date, dup.id);
  } else {
    db.prepare('INSERT INTO resource_assignments (task_id, resource_id, role_on_task, allocation, start_date, end_date, notes) VALUES (?,?,?,?,?,?,?)')
      .run(task.id, res0.id, d.role_on_task || '', Number(d.allocation), payload.start_date, payload.end_date, d.notes || '');
  }
  // hitung konflik -> tampilkan sebagai peringatan (tidak mengubah data secara diam-diam)
  const newAsg = db.prepare('SELECT * FROM resource_assignments WHERE task_id = ? AND resource_id = ?').get(task.id, res0.id);
  const conflicts = assignmentConflicts(db, project.id, newAsg);
  req.session.flash = conflicts.length
    ? { type: 'warning', text: 'Penugasan tersimpan. Peringatan konflik: ' + conflicts.join(' ') }
    : { type: 'success', text: 'Penugasan tersimpan.' };
  res.redirect(`/projects/${project.id}/assignments`);
});

router.post('/:aid/edit', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola penugasan.' });
  const { db, project } = a;
  const asg = db.prepare(`
    SELECT a.* FROM resource_assignments a JOIN tasks t ON t.id = a.task_id
    WHERE a.id = ? AND t.project_id = ?`).get(Number(req.params.aid), project.id);
  if (!asg) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Penugasan tidak ditemukan.' });
  const payload = {
    resource_id: asg.resource_id, allocation: req.body.allocation,
    start_date: req.body.start_date || asg.start_date,
    end_date: req.body.end_date || asg.end_date
  };
  const errors = validateAssignment(payload);
  if (errors.length) {
    req.session.flash = { type: 'error', text: errors.join(' ') };
    return res.redirect(`/projects/${project.id}/assignments`);
  }
  db.prepare('UPDATE resource_assignments SET allocation=?, role_on_task=?, start_date=?, end_date=?, notes=? WHERE id=?')
    .run(Number(req.body.allocation), req.body.role_on_task || '', payload.start_date, payload.end_date, req.body.notes || '', asg.id);
  const updated = db.prepare('SELECT * FROM resource_assignments WHERE id = ?').get(asg.id);
  const conflicts = assignmentConflicts(db, project.id, updated);
  req.session.flash = conflicts.length
    ? { type: 'warning', text: 'Penugasan diperbarui. Peringatan konflik: ' + conflicts.join(' ') }
    : { type: 'success', text: 'Penugasan diperbarui.' };
  res.redirect(`/projects/${project.id}/assignments`);
});

router.post('/:aid/delete', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengelola penugasan.' });
  const { db, project } = a;
  const asg = db.prepare(`
    SELECT a.*, r.full_name, t.name AS task_name FROM resource_assignments a
    JOIN tasks t ON t.id = a.task_id JOIN resources r ON r.id = a.resource_id
    WHERE a.id = ? AND t.project_id = ?`).get(Number(req.params.aid), project.id);
  if (!asg) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Penugasan tidak ditemukan.' });
  db.prepare('DELETE FROM resource_assignments WHERE id = ?').run(asg.id);
  req.session.flash = { type: 'success', text: `Penugasan ${asg.full_name} pada tugas "${asg.task_name}" dihapus.` };
  res.redirect(`/projects/${project.id}/assignments`);
});

module.exports = router;
