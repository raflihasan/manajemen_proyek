'use strict';
// ============================================================================
// MODUL SUMBER DAYA: beban kerja, ketersediaan, dan deteksi konflik penugasan.
// Digunakan oleh Resource Chart, Penugasan, dan Laporan.
// ============================================================================
const { compare, rangeDates, addDays } = require('../utils/date');
const { getCalendar, computeCPM } = require('./scheduler');

// Hitung beban kerja per anggota per tanggal dalam rentang [rangeStart, rangeEnd].
// Beban = total alokasi (%) dari seluruh penugasan aktif pada tanggal tersebut.
function computeWorkload(db, projectId, rangeStart, rangeEnd) {
  const ctx = getCalendar(db, projectId);
  // peta tanggal CPM per tugas (fallback bila tanggal tersimpan masih kosong,
  // mis. tugas yang dijadwalkan sepenuhnya melalui dependensi)
  const cpmDates = {};
  try {
    const cpm = computeCPM(db, projectId);
    if (cpm && cpm.ok) cpm.tasks.forEach(t => { cpmDates[t.id] = { es: t.es, ef: t.ef }; });
  } catch (_) { /* jika CPM gagal, gunakan tanggal tersimpan saja */ }
  const resources = db.prepare(`
    SELECT DISTINCT r.* FROM resources r
    JOIN resource_assignments a ON a.resource_id = r.id
    JOIN tasks t ON t.id = a.task_id
    WHERE t.project_id = ?
    ORDER BY r.full_name
  `).all(projectId);

  const allResources = db.prepare('SELECT * FROM resources ORDER BY full_name').all();
  const assignments = db.prepare(`
    SELECT a.*, t.name AS task_name, t.start_date AS task_start, t.end_date AS task_end,
           t.duration AS task_duration, t.status AS task_status, r.full_name AS resource_name,
           r.is_active AS resource_active
    FROM resource_assignments a
    JOIN tasks t ON t.id = a.task_id
    JOIN resources r ON r.id = a.resource_id
    WHERE t.project_id = ?
    ORDER BY r.full_name, t.name
  `).all(projectId);

  const absences = db.prepare(`
    SELECT u.* FROM resource_unavailability u
    WHERE u.status <> 'Ditolak'
      AND u.start_date <= ? AND u.end_date >= ?
  `).all(rangeEnd, rangeStart);

  // tanggal efektif per penugasan: tanggal tersimpan, atau tanggal hasil CPM bila kosong
  assignments.forEach(a => {
    const cpmT = cpmDates[a.task_id];
    a.eff_start = a.start_date || a.task_start || (cpmT ? cpmT.es : null);
    a.eff_end = a.end_date || a.task_end || (cpmT ? cpmT.ef : null);
  });

  const dates = rangeDates(rangeStart, rangeEnd);
  const rows = [];

  for (const r of resources.length ? resources : allResources) {
    const myAssignments = assignments.filter(a => a.resource_id === r.id);
    const daily = {};
    dates.forEach(d => { daily[d] = 0; });
    for (const a of myAssignments) {
      const s = a.eff_start;
      const e = a.eff_end;
      if (!s || !e) continue;
      for (const d of dates) {
        if (compare(d, s) >= 0 && compare(d, e) <= 0) {
          daily[d] += (a.allocation || 0);
        }
      }
    }
    const myAbsences = absences.filter(x => x.resource_id === r.id);
    const absenceDates = new Set();
    myAbsences.forEach(x => {
      rangeDates(x.start_date, x.end_date).forEach(d => {
        if (dates.includes(d)) absenceDates.add(d);
      });
    });

    const overallocatedDates = dates.filter(d => daily[d] > 100);
    const conflictWithAbsence = dates.filter(d =>
      absenceDates.has(d) && myAssignments.some(a =>
        a.eff_start && a.eff_end && compare(d, a.eff_start) >= 0 && compare(d, a.eff_end) <= 0));

    rows.push({
      resource: r,
      assignments: myAssignments,
      daily,
      totalLoad: Object.values(daily).reduce((a, b) => a + b, 0),
      maxDaily: Math.max(0, ...Object.values(daily)),
      overallocatedDates,
      absenceDates: [...absenceDates],
      conflictWithAbsence,
      isOverallocated: overallocatedDates.length > 0,
      hasAssignment: myAssignments.length > 0
    });
  }

  // konflik global
  const conflicts = [];
  for (const row of rows) {
    if (row.isOverallocated) {
      row.overallocatedDates.forEach(d => {
        conflicts.push({
          type: 'beban', resource_id: row.resource.id, resource_name: row.resource.full_name,
          date: d, message: `${row.resource.full_name} memiliki alokasi ${row.daily[d]}% pada ${d} (melebihi 100%).`
        });
      });
    }
    if (row.conflictWithAbsence.length) {
      row.conflictWithAbsence.forEach(d => {
        conflicts.push({
          type: 'ketidakhadiran', resource_id: row.resource.id,
          resource_name: row.resource.full_name, date: d,
          message: `${row.resource.full_name} ditugaskan pada ${d} tetapi tercatat tidak hadir.`
        });
      });
    }
  }
  // penugasan anggota nonaktif
  assignments.filter(a => a.resource_active !== 1).forEach(a => {
    conflicts.push({
      type: 'nonaktif', resource_id: a.resource_id, resource_name: a.resource_name,
      date: null,
      message: `${a.resource_name} (nonaktif) masih ditugaskan pada tugas "${a.task_name}".`
    });
  });

  return { rows, conflicts, assignments, dates, calendarCtx: ctx };
}

// Estimasi biaya tenaga kerja per anggota berdasarkan tarif & hari kerja penugasan.
function estimateCost(db, projectId, rangeStart, rangeEnd) {
  const { rows, calendarCtx } = computeWorkload(db, projectId, rangeStart, rangeEnd);
  const items = [];
  for (const row of rows) {
    const r = row.resource;
    let workDays = 0;
    for (const a of row.assignments) {
      const s = a.eff_start;
      const e = a.eff_end;
      if (!s || !e) continue;
      const alloc = (a.allocation || 0) / 100;
      for (const d of rangeDates(s, e)) {
        if (compare(d, rangeStart) >= 0 && compare(d, rangeEnd) <= 0) {
          const { isWorkday } = require('./scheduler');
          if (isWorkday(d, calendarCtx)) workDays += alloc;
        }
      }
    }
    const rate = r.rate || 0;
    let cost = 0, assumption = '';
    if (r.rate_unit === 'per hari') {
      cost = rate * workDays;
      assumption = `${rate}/hari × ${workDays.toFixed(1)} hari kerja alokasi`;
    } else if (r.rate_unit === 'per bulan') {
      // asumsi konversi: 22 hari kerja per bulan
      const daily = rate / 22;
      cost = daily * workDays;
      assumption = `${rate}/bulan ÷ 22 hari kerja = ${daily.toFixed(0)}/hari × ${workDays.toFixed(1)} hari alokasi`;
    }
    items.push({ resource: r, workDays, cost, assumption });
  }
  const total = items.reduce((a, b) => a + b.cost, 0);
  return { items, total, assumptions: 'Asumsi: tarif harian × hari kerja efektif penugasan; tarif bulanan dikonversi dengan 22 hari kerja/bulan. Estimasi bersifat informatif, bukan penggajian otomatis.' };
}

module.exports = { computeWorkload, estimateCost };
