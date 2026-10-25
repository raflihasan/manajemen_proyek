'use strict';
// Pengelolaan akun pengguna (khusus Admin).
const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/connection');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireRole('admin'));

router.get('/', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, email, full_name, role, is_active, created_at FROM users ORDER BY full_name').all();
  res.render('users/list', { title: 'Akun Pengguna', users, errors: [], old: {} });
});

router.get('/baru', (req, res) => {
  res.render('users/form', { title: 'Akun Baru', user: null, errors: [], old: { role: 'anggota' } });
});

router.post('/baru', (req, res) => {
  const db = getDb();
  const d = req.body;
  const errors = [];
  if (!d.username || !String(d.username).trim()) errors.push('Username wajib diisi.');
  if (!d.full_name || !String(d.full_name).trim()) errors.push('Nama lengkap wajib diisi.');
  if (!d.password || String(d.password).length < 6) errors.push('Password minimal 6 karakter.');
  if (!['admin', 'manajer', 'anggota'].includes(d.role)) errors.push('Peran tidak valid.');
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) errors.push('Format email tidak valid.');
  if (!errors.length) {
    const dup = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?')
      .get(String(d.username).trim(), d.email ? String(d.email).trim() : '__none__');
    if (dup) errors.push('Username atau email sudah digunakan.');
  }
  if (errors.length) return res.status(400).render('users/form', { title: 'Akun Baru', user: null, errors, old: d });
  db.prepare('INSERT INTO users (username, email, full_name, password_hash, role, is_active) VALUES (?,?,?,?,?,?)')
    .run(String(d.username).trim(), d.email || '', String(d.full_name).trim(),
      bcrypt.hashSync(String(d.password), 10), d.role, d.is_active ? 1 : 0);
  req.session.flash = { type: 'success', text: 'Akun pengguna dibuat.' };
  res.redirect('/users');
});

router.get('/:uid/edit', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username, email, full_name, role, is_active FROM users WHERE id = ?').get(Number(req.params.uid));
  if (!user) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Akun tidak ditemukan.' });
  res.render('users/form', { title: 'Ubah Akun', user, errors: [], old: {} });
});

router.post('/:uid/edit', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.uid));
  if (!user) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Akun tidak ditemukan.' });
  const d = req.body;
  const errors = [];
  if (!d.full_name || !String(d.full_name).trim()) errors.push('Nama lengkap wajib diisi.');
  if (!['admin', 'manajer', 'anggota'].includes(d.role)) errors.push('Peran tidak valid.');
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) errors.push('Format email tidak valid.');
  if (d.password && String(d.password).length < 6) errors.push('Password baru minimal 6 karakter.');
  if (errors.length) return res.status(400).render('users/form', { title: 'Ubah Akun', user, errors, old: d });

  db.prepare(`UPDATE users SET full_name=?, email=?, role=?, is_active=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(String(d.full_name).trim(), d.email || '', d.role, d.is_active ? 1 : 0, user.id);
  if (d.password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(d.password), 10), user.id);
  }
  // jangan biarkan diri sendiri menonaktifkan akun sendiri
  if (Number(req.params.uid) === req.session.user.id && !d.is_active) {
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(user.id);
  }
  req.session.flash = { type: 'success', text: 'Akun diperbarui.' };
  res.redirect('/users');
});

module.exports = router;
