'use strict';
// Halaman Gantt Chart (data diambil klien via /api/projects/:id/gantt).
const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { projectAccess } = require('../middleware/projectAccess');
const { canManageProject } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireLogin, projectAccess);

router.get('/', (req, res) => {
  res.render('gantt', {
    title: 'Gantt Chart', project: req.project, tab: 'gantt',
    canManage: canManageProject(req.session.user)
  });
});

module.exports = router;
