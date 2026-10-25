'use strict';
// Halaman Resource Chart.
const express = require('express');
const { requireLogin, canManageProject } = require('../middleware/auth');
const { projectAccess } = require('../middleware/projectAccess');

const router = express.Router({ mergeParams: true });
router.use(requireLogin, projectAccess);

router.get('/', (req, res) => {
  let cpm = null;
  try { cpm = require('../services/scheduler').computeCPM(req.db, req.project.id); } catch (e) { cpm = null; }
  res.render('resourceChart', {
    title: 'Resource Chart', project: req.project, tab: 'resource-chart', cpm,
    canManage: canManageProject(req.session.user)
  });
});

module.exports = router;
