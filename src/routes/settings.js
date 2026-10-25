'use strict';
// Pengaturan dasar aplikasi (khusus Admin) — disimpan pada tabel app_settings.
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireRole('admin'));

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}
function getSetting(db, key, def) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return r ? r.value : def;
}

router.get('/', (req, res) => {
  const db = getDb();
  ensureTable(db);
  res.render('settings', {
    title: 'Pengaturan Aplikasi',
    settings: {
      app_name: getSetting(db, 'app_name', 'SIPM Event Kampus'),
      default_work_start: getSetting(db, 'default_work_start', '08:00'),
      default_work_end: getSetting(db, 'default_work_end', '17:00'),
      default_duration: getSetting(db, 'default_duration', '1'),
      footer: getSetting(db, 'footer', 'Sistem Informasi Manajemen Proyek Penyelenggaraan Event Kampus')
    }
  });
});

router.post('/', (req, res) => {
  const db = getDb();
  ensureTable(db);
  const up = db.prepare('INSERT INTO app_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  ['app_name', 'default_work_start', 'default_work_end', 'default_duration', 'footer'].forEach(k => {
    if (req.body[k] !== undefined) up.run(k, String(req.body[k]).slice(0, 200));
  });
  req.session.flash = { type: 'success', text: 'Pengaturan disimpan.' };
  res.redirect('/settings');
});

module.exports = router;
