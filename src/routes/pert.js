'use strict';
// Halaman PERT Chart / Network Diagram.
const express = require('express');
const { requireLogin, canManageProject } = require('../middleware/auth');
const { projectAccess } = require('../middleware/projectAccess');

const router = express.Router({ mergeParams: true });
router.use(requireLogin, projectAccess);

router.get('/', (req, res) => {
  res.render('pert', {
    title: 'PERT Chart', project: req.project, tab: 'pert',
    canManage: canManageProject(req.session.user)
  });
});

module.exports = router;
