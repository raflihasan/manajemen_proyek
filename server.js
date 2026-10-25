'use strict';
// ============================================================================
// Sistem Informasi Manajemen Proyek Penyelenggaraan Event Kampus
// Titik masuk aplikasi (Express.js + EJS + SQLite).
// ============================================================================
const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./src/config');
const { ensureSchema } = require('./src/db/schema');
const { seed } = require('./src/db/seed');
const { toISODate } = require('./src/utils/date');

// siapkan skema + data awal
ensureSchema();
seed(false);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: config.sessionName,
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }
}));

// variabel global untuk view
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  res.locals.today = toISODate(new Date());
  delete req.session.flash;
  res.locals.currentPath = req.path;
  next();
});

app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/dashboard'));
app.use('/projects', require('./src/routes/projects'));
app.use('/projects/:id/calendar', require('./src/routes/calendarRoutes'));
app.use('/projects/:id/gantt', require('./src/routes/gantt'));
app.use('/projects/:id/pert', require('./src/routes/pert'));
app.use('/projects/:id/critical', require('./src/routes/critical'));
app.use('/projects/:id/resource-chart', require('./src/routes/resourceChart'));
app.use('/projects/:id/report', require('./src/routes/report'));
app.use('/projects/:id/tasks', require('./src/routes/tasks'));
app.use('/projects/:id/dependencies', require('./src/routes/dependencies'));
app.use('/projects/:id/assignments', require('./src/routes/assignments'));
app.use('/tasks', require('./src/routes/tasksGlobal'));
app.use('/resources', require('./src/routes/resources'));
app.use('/users', require('./src/routes/users'));
app.use('/settings', require('./src/routes/settings'));
app.use('/api', require('./src/routes/api'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Tidak Ditemukan',
    message: 'Halaman yang Anda minta tidak ditemukan.' });
});
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Kesalahan Server',
    message: 'Terjadi kesalahan pada server. ' + (err.message || '') });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Aplikasi berjalan di http://localhost:${config.port}`);
  });
}

module.exports = app;
