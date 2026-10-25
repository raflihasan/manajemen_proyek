'use strict';
// Modul manajemen sumber daya (anggota tim): CRUD, ketidakhadiran, penugasan.
const express = require('express');
const { getDb } = require('../db/connection');
const { requireLogin, canManageProject } = require('../middleware/auth');
const { validateResource } = require('../validate');
const { computeWorkload, estimateCost } = require('../services/resourceWorkload');
const { toISODate } = require('../utils/date');

const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim();
  const status = req.query.status || '';
  let sql = 'SELECT * FROM resources';
  const params = [], where = [];
  if (q) { where.push('(full_name LIKE ? OR role LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status === 'aktif') where.push('is_active = 1');
  if (status === 'nonaktif') where.push('is_active = 0');
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY full_name';
  const resources = db.prepare(sql).all(...params);
  resources.forEach(r => {
    r.assignment_count = db.prepare('SELECT COUNT(*) AS n FROM resource_assignments WHERE resource_id = ?').get(r.id).n;
  });
  res.render('resources/list', {
    title: 'Sumber Daya', resources, q, status,
    canManage: canManageProject(req.session.user)
  });
});

router.get('/baru', (req, res) => {
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Hanya Admin dan Manajer Proyek yang dapat menambah anggota.' });
  res.render('resources/form', { title: 'Tambah Anggota', resource: null, errors: [], old: { rate_unit: 'per hari' } });
});

router.post('/baru', (req, res) => {
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang.' });
  const db = getDb();
  const d = req.body;
  const errors = validateResource(d);
  if (errors.length) return res.status(400).render('resources/form', { title: 'Tambah Anggota', resource: null, errors, old: d });
  db.prepare(`
    INSERT INTO resources (full_name, phone, email, role, rate, rate_unit, is_active, notes)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    d.full_name.trim(), d.phone || '', d.email || '', d.role || '',
    Number(d.rate || 0), d.rate_unit, d.is_active ? 1 : 0, d.notes || '');
  req.session.flash = { type: 'success', text: 'Anggota tim berhasil ditambahkan.' };
  res.redirect('/resources');
});

router.get('/:rid', (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM resources WHERE id = ?').get(Number(req.params.rid));
  if (!r) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Anggota tidak ditemukan.' });
  const assignments = db.prepare(`
    SELECT a.*, t.name AS task_name, t.status AS task_status, t.start_date, t.end_date,
           t.duration, p.name AS project_name, p.id AS project_id
    FROM resource_assignments a JOIN tasks t ON t.id = a.task_id
    JOIN projects p ON p.id = t.project_id
    WHERE a.resource_id = ? ORDER BY p.name, t.name`).all(r.id);
  const absences = db.prepare('SELECT * FROM resource_unavailability WHERE resource_id = ? ORDER BY start_date DESC').all(r.id);

  // ketersediaan 30 hari ke depan (dari seluruh penugasan lintas proyek)
  const today = res.locals.today;
  const horizon = toISODate(new Date(Date.now() + 29 * 86400000));
  const daily = {};
  { const { rangeDates } = require('../utils/date');
    rangeDates(today, horizon).forEach(d => { daily[d] = 0; });
    assignments.forEach(a => {
      const s = a.start_date, e = a.end_date;
      if (!s || !e) return;
      rangeDates(s, e).forEach(d => { if (daily[d] !== undefined) daily[d] += (a.allocation || 0); });
    }); }
  const absenceDates = new Set();
  absences.filter(x => x.status !== 'Ditolak').forEach(x => {
    require('../utils/date').rangeDates(x.start_date, x.end_date)
      .filter(d => daily[d] !== undefined).forEach(d => absenceDates.add(d));
  });
  const overallocatedDates = Object.keys(daily).filter(d => daily[d] > 100);
  const mine = {
    daily, absenceDates: [...absenceDates], overallocatedDates,
    isOverallocated: overallocatedDates.length > 0
  };

  // proyek-proyek yang melibatkan anggota ini (untuk perhitungan beban per proyek)
  const projectIds = [...new Set(assignments.map(a => a.project_id))];
  let cost = null;
  if (projectIds.length) {
    try {
      const end = assignments.reduce((a, x) => (x.end_date && x.end_date > a) ? x.end_date : a, today);
      const start = assignments.reduce((a, x) => (x.start_date && x.start_date < a) ? x.start_date : a, today);
      cost = estimateCost(db, projectIds[0], start || today, end || today);
      cost.items = cost.items.filter(i => i.resource.id === r.id);
    } catch (e) { cost = null; }
  }

  res.render('resources/detail', {
    title: r.full_name, resource: r, assignments, absences,
    availability: mine || null, cost,
    canManage: canManageProject(req.session.user), errors: [], old: {}
  });
});

router.get('/:rid/edit', (req, res) => {
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang.' });
  const db = getDb();
  const r = db.prepare('SELECT * FROM resources WHERE id = ?').get(Number(req.params.rid));
  if (!r) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Anggota tidak ditemukan.' });
  res.render('resources/form', { title: 'Ubah Anggota', resource: r, errors: [], old: {} });
});

router.post('/:rid/edit', (req, res) => {
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang.' });
  const db = getDb();
  const r = db.prepare('SELECT * FROM resources WHERE id = ?').get(Number(req.params.rid));
  if (!r) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Anggota tidak ditemukan.' });
  const d = req.body;
  const errors = validateResource(d);
  if (errors.length) return res.status(400).render('resources/form', { title: 'Ubah Anggota', resource: r, errors, old: d });
  db.prepare(`
    UPDATE resources SET full_name=?, phone=?, email=?, role=?, rate=?, rate_unit=?,
      is_active=?, notes=?, updated_at=datetime('now','localtime') WHERE id=?`).run(
    d.full_name.trim(), d.phone || '', d.email || '', d.role || '',
    Number(d.rate || 0), d.rate_unit, d.is_active ? 1 : 0, d.notes || '', r.id);
  req.session.flash = { type: 'success', text: 'Data anggota diperbarui.' };
  res.redirect(`/resources/${r.id}`);
});

// nonaktifkan/aktifkan cepat
router.post('/:rid/status', (req, res) => {
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang.' });
  const db = getDb();
  const r = db.prepare('SELECT * FROM resources WHERE id = ?').get(Number(req.params.rid));
  if (!r) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Anggota tidak ditemukan.' });
  db.prepare('UPDATE resources SET is_active = ? WHERE id = ?').run(r.is_active ? 0 : 1, r.id);
  req.session.flash = { type: 'success', text: r.is_active ? 'Anggota dinonaktifkan.' : 'Anggota diaktifkan kembali.' };
  res.redirect(req.get('Referer') || `/resources/${r.id}`);
});

// ketidakhadiran pribadi
router.post('/:rid/absen', (req, res) => {
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang.' });
  const db = getDb();
  const r = db.prepare('SELECT * FROM resources WHERE id = ?').get(Number(req.params.rid));
  if (!r) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Anggota tidak ditemukan.' });
  const { start_date, end_date, reason, status } = req.body;
  if (!start_date || !end_date) {
    req.session.flash = { type: 'error', text: 'Tanggal mulai dan selesai ketidakhadiran wajib diisi.' };
    return res.redirect(`/resources/${r.id}`);
  }
  if (end_date < start_date) {
    req.session.flash = { type: 'error', text: 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.' };
    return res.redirect(`/resources/${r.id}`);
  }
  const st = ['Menunggu', 'Disetujui', 'Ditolak'].includes(status) ? status : 'Disetujui';
  db.prepare('INSERT INTO resource_unavailability (resource_id, start_date, end_date, reason, status) VALUES (?,?,?,?,?)')
    .run(r.id, start_date, end_date, reason || '', st);
  req.session.flash = { type: 'success', text: 'Ketidakhadiran ditambahkan dan akan dipertimbangkan pada perhitungan ketersediaan.' };
  res.redirect(`/resources/${r.id}`);
});

router.post('/absen/:aid/delete', (req, res) => {
  if (!canManageProject(req.session.user)) return res.status(403).render('error', { title: 'Akses Ditolak', message: 'Tidak berwenang.' });
  const db = getDb();
  const row = db.prepare('SELECT * FROM resource_unavailability WHERE id = ?').get(Number(req.params.aid));
  if (!row) return res.status(404).render('error', { title: 'Tidak Ditemukan', message: 'Data ketidakhadiran tidak ditemukan.' });
  db.prepare('DELETE FROM resource_unavailability WHERE id = ?').run(row.id);
  req.session.flash = { type: 'success', text: 'Ketidakhadiran dihapus.' };
  res.redirect(`/resources/${row.resource_id}`);
});

module.exports = router;
