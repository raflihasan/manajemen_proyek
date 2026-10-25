'use strict';
// Guard akses proyek yang dapat dipakai semua route /projects/:id/*
const { getDb } = require('../db/connection');
const { canAccessProject } = require('./auth');

function projectAccess(req, res, next) {
  const db = getDb();
  const r = canAccessProject(db, req.session.user, Number(req.params.id));
  if (!r.ok) {
    return res.status(r.project ? 403 : 404).render('error', {
      title: r.project ? 'Tidak Berwenang' : 'Tidak Ditemukan',
      message: r.reason || 'Proyek tidak ditemukan.'
    });
  }
  req.project = r.project;
  req.db = db;
  next();
}

module.exports = { projectAccess };
