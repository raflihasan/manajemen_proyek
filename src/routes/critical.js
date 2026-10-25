'use strict';
// Halaman Analisis Jalur Kritis.
const express = require('express');
const { requireLogin, canManageProject } = require('../middleware/auth');
const { projectAccess } = require('../middleware/projectAccess');
const { computeCPM } = require('../services/scheduler');

const router = express.Router({ mergeParams: true });
router.use(requireLogin, projectAccess);

router.get('/', (req, res) => {
  const db = req.db, project = req.project;
  let cpm = null;
  try { cpm = computeCPM(db, project.id); } catch (e) { console.error('CPM error:', e); }
  res.render('critical', {
    title: 'Analisis Jalur Kritis', project, tab: 'kritis',
    cpm, cpmError: cpm && !cpm.ok ? cpm.reason : (cpm ? null : 'Perhitungan gagal dijalankan.'),
    canManage: canManageProject(req.session.user)
  });
});

module.exports = router;
