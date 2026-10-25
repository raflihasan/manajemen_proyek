'use strict';
// Autentikasi: login & logout.
const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/connection');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Login', error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const user = db.prepare(
    'SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = 1'
  ).get(String(username || '').trim(), String(username || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).render('login', {
      title: 'Login', error: 'Username/email atau password salah, atau akun nonaktif.'
    });
  }
  req.session.user = {
    id: user.id, username: user.username, full_name: user.full_name,
    role: user.role, email: user.email
  };
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
