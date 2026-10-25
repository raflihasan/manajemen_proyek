'use strict';
// Kalender kerja proyek: hari kerja, jam kerja, hari libur nasional/khusus, tampilan bulanan.
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin, canManageProject, canAccessProject } = require('../middleware/auth');
const { getCalendar } = require('../services/scheduler');
const { parseISO, toISODate, rangeDates } = require('../utils/date');

const router = express.Router({ mergeParams: true });
router.use(requireLogin);

function access(req, res) {
  const db = getDb();
  const r = canAccessProject(db, req.session.user, Number(req.params.id));
  if (!r.ok) {
    res.status(r.project ? 403 : 404).render('error', {
      title: 'Tidak Berwenang', message: r.reason || 'Proyek tidak ditemukan.'
    });
    return null;
  }
  return { db, project: r.project };
}

// bulan view: ?bulan=YYYY-MM
router.get('/', (req, res) => {
  const a = access(req, res); if (!a) return;
  const { db, project } = a;
  const ctx = getCalendar(db, project.id);
  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth();
  const bulan = req.query.bulan;
  if (bulan && /^\d{4}-\d{2}$/.test(bulan)) {
    year = Number(bulan.slice(0, 4));
    month = Number(bulan.slice(5, 7)) - 1;
  }
  const first = new Date(year, month, 1);
  const startPad = first.getDay(); // 0 minggu
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = toISODate(new Date(year, month, d));
    cells.push({
      date: ds, day: d,
      isWorkday: ctx.workdayMap[new Date(year, month, d).getDay()] !== false &&
                 !ctx.holidaySet.has(ds),
      isWeekend: new Date(year, month, d).getDay() === 0 || new Date(year, month, d).getDay() === 6,
      holiday: ctx.holidays.find(h => h.date === ds) || null
    });
  }
  const monthNames = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  res.render('calendar', {
    title: 'Kalender Kerja', project, tab: 'kalender',
    ctx, cells, year, month, monthNames,
    prevBulan: `${year}-${String(month === 0 ? 12 : month).padStart(2, '0')}`,
    nextBulan: `${year}-${String(month + 2 === 13 ? 1 : month + 2).padStart(2, '0')}`,
    canManage: canManageProject(req.session.user),
    errors: [], flashLocal: null
  });
});

// simpan hari kerja + jam kerja
router.post('/kerja', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengubah kalender.' });
  const db = a.db;
  const ctx = getCalendar(db, a.project.id);
  const upd = db.prepare('UPDATE calendar_workdays SET is_workday = ? WHERE calendar_id = ? AND day_of_week = ?');
  for (let d = 0; d <= 6; d++) {
    const v = req.body['day_' + d] ? 1 : 0;
    const exists = db.prepare('SELECT id FROM calendar_workdays WHERE calendar_id=? AND day_of_week=?').get(ctx.calendar.id, d);
    if (exists) upd.run(v, ctx.calendar.id, d);
    else db.prepare('INSERT INTO calendar_workdays (calendar_id, day_of_week, is_workday) VALUES (?,?,?)').run(ctx.calendar.id, d, v);
  }
  db.prepare("UPDATE work_calendars SET work_start = ?, work_end = ? WHERE id = ?")
    .run(req.body.work_start || '08:00', req.body.work_end || '17:00', ctx.calendar.id);
  req.session.flash = { type: 'success', text: 'Pengaturan hari dan jam kerja disimpan.' };
  res.redirect(`/projects/${a.project.id}/calendar?bulan=${req.body.bulan || ''}`);
});

// tambah hari libur
router.post('/libur', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengubah kalender.' });
  const db = a.db;
  const { date, name, kind } = req.body;
  if (!date || !name) {
    req.session.flash = { type: 'error', text: 'Tanggal dan nama hari libur wajib diisi.' };
    return res.redirect(`/projects/${a.project.id}/calendar?bulan=${req.body.bulan || ''}`);
  }
  const ctx = getCalendar(db, a.project.id);
  db.prepare('INSERT OR REPLACE INTO calendar_holidays (calendar_id, date, name, kind) VALUES (?,?,?,?)')
    .run(ctx.calendar.id, date, name.trim(), kind === 'nasional' ? 'nasional' : 'khusus');
  req.session.flash = { type: 'success', text: 'Hari libur ditambahkan.' };
  res.redirect(`/projects/${a.project.id}/calendar?bulan=${String(date).slice(0, 7)}`);
});

// hapus hari libur (khusus maupun nasional dalam proyek ini)
router.post('/libur/:holidayId/delete', (req, res) => {
  const a = access(req, res); if (!a) return;
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang mengubah kalender.' });
  const db = a.db;
  const ctx = getCalendar(db, a.project.id);
  db.prepare('DELETE FROM calendar_holidays WHERE id = ? AND calendar_id = ?').run(Number(req.params.holidayId), ctx.calendar.id);
  req.session.flash = { type: 'success', text: 'Hari libur dihapus.' };
  res.redirect(`/projects/${a.project.id}/calendar?bulan=${req.body.bulan || ''}`);
});

module.exports = router;
