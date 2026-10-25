'use strict';
// Pintasan: /tasks/:id -> halaman tugas dalam proyeknya.
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

// Daftar "Tugas Saya": tugas yang ditugaskan ke pengguna login
// (pemetaan pengguna ↔ sumber daya melalui email, sama seperti modul tugas).
router.get('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const rows = db.prepare(`
    SELECT t.id, t.name, t.status, t.progress, t.priority, t.start_date, t.end_date, t.duration,
           t.parent_id, p.id AS project_id, p.name AS project_name,
           a.allocation, a.role_on_task, a.start_date AS astart, a.end_date AS aend
    FROM resource_assignments a
    JOIN resources r ON r.id = a.resource_id
    JOIN tasks t ON t.id = a.task_id
    JOIN projects p ON p.id = t.project_id
    WHERE r.email = ?
    ORDER BY (t.status = 'Selesai'), t.end_date IS NULL, t.end_date
  `).all(user.email || '');
  res.render('myTasks', { title: 'Tugas Saya', tasks: rows });
});

router.get('/:taskId', (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(Number(req.params.taskId));
  if (!t) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Tugas tidak ditemukan.' });
  res.redirect(`/projects/${t.project_id}/tasks/${req.params.taskId}`);
});

module.exports = router;
