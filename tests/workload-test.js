'use strict';
// ============================================================================
// Uji modul beban kerja sumber daya: deteksi kelebihan alokasi (60%+60%=120%),
// konflik dengan ketidakhadiran pribadi, dan penugasan anggota nonaktif.
// Jalankan: node tests/workload-test.js
// ============================================================================
process.env.DB_PATH = ':memory:';
const { getDb } = require('../src/db/connection');
const { ensureSchema } = require('../src/db/schema');
const { computeWorkload, estimateCost } = require('../src/services/resourceWorkload');

let pass = 0, fail = 0;
function expect(label, actual, expected) {
  if (String(actual) === String(expected)) { pass++; console.log(`PASS: ${label} (= ${actual})`); }
  else { fail++; console.log(`FAIL: ${label} — diharapkan ${expected}, didapat ${actual}`); }
}

ensureSchema();
const db = getDb();
db.prepare(`INSERT INTO users (username, full_name, password_hash, role) VALUES ('uji','Uji','-','manajer')`).run();
db.prepare(`INSERT INTO projects (name, organization, start_date, target_end_date, manager_id, status, progress)
  VALUES ('Proyek Uji','Lab','2026-06-01','2026-06-30',1,'Berjalan',0)`).run();
const PID = 1;
db.prepare('INSERT INTO work_calendars (project_id, work_start, work_end) VALUES (?,?,?)').run(PID, '08:00', '17:00');
const CAL = db.prepare('SELECT id FROM work_calendars WHERE project_id = ?').get(PID).id;
for (let d = 0; d <= 6; d++) db.prepare('INSERT INTO calendar_workdays (calendar_id, day_of_week, is_workday) VALUES (?,?,?)').run(CAL, d, (d === 0 || d === 6) ? 0 : 1);

// sumber daya
const insR = db.prepare("INSERT INTO resources (full_name, role, rate, rate_unit, is_active) VALUES (?,?,?,?,?)");
const r1 = insR.run('Andi', 'Koordinator', 150000, 'per hari', 1).lastInsertRowid;
const r2 = insR.run('Sari', 'Publikasi', 120000, 'per hari', 1).lastInsertRowid;
const r3 = insR.run('Budi', 'Teknis', 100000, 'per hari', 0).lastInsertRowid; // nonaktif

// tugas pada rentang sama (06-08..06-09 = Senin-Selasa)
const insT = db.prepare(`INSERT INTO tasks (project_id, name, start_date, duration, end_date, priority, status, progress)
  VALUES (?, ?, ?, ?, ?, 'Sedang', 'Berjalan', 0)`);
const t1 = insT.run(PID, 'Tugas Alpha', '2026-06-08', 2, '2026-06-09').lastInsertRowid;
const t2 = insT.run(PID, 'Tugas Beta', '2026-06-08', 2, '2026-06-09').lastInsertRowid;

// penugasan: Andi 60% di dua tugas bersamaan → 120% = konflik
const insA = db.prepare('INSERT INTO resource_assignments (task_id, resource_id, role_on_task, allocation, start_date, end_date) VALUES (?,?,?,?,?,?)');
insA.run(t1, r1, 'Koordinator', 60, '2026-06-08', '2026-06-09');
insA.run(t2, r1, 'Reviewer', 60, '2026-06-08', '2026-06-09');
// Sari 50% satu tugas saja → aman
insA.run(t1, r2, 'Desain', 50, '2026-06-08', '2026-06-09');
// Budi nonaktif tapi masih ditugaskan
insA.run(t2, r3, 'Teknisi', 100, '2026-06-08', '2026-06-09');

// ketidakhadiran Sari pada 06-09
db.prepare("INSERT INTO resource_unavailability (resource_id, start_date, end_date, reason, status) VALUES (?,?,?,?, 'Disetujui')")
  .run(r2, '2026-06-09', '2026-06-09', 'Acara keluarga');

const { rows, conflicts } = computeWorkload(db, PID, '2026-06-08', '2026-06-12');
const byId = {};
rows.forEach(x => { byId[x.resource.id] = x; });

// --- beban harian ---
expect('Andi beban 06-08 = 120%', byId[r1].daily['2026-06-08'], 120);
expect('Andi terdeteksi overallocated', byId[r1].isOverallocated, true);
expect('Andi overallocatedDates (2 hari)', byId[r1].overallocatedDates.length, 2);
expect('Sari beban 06-08 = 50%', byId[r2].daily['2026-06-08'], 50);
expect('Sari tidak overallocated', byId[r2].isOverallocated, false);
expect('Sari konflik ketidakhadiran 06-09', byId[r2].conflictWithAbsence.includes('2026-06-09'), true);

// --- konflik global ---
const beban = conflicts.filter(c => c.type === 'beban');
const absent = conflicts.filter(c => c.type === 'ketidakhadiran');
const inactive = conflicts.filter(c => c.type === 'nonaktif');
expect('konflik beban jumlah (2 tanggal x Andi)', beban.length, 2);
expect('konflik ketidakhadiran jumlah', absent.length, 1);
expect('konflik nonaktif jumlah (Budi)', inactive.length, 1);
expect('pesan konflik beban menyebut persen', beban[0].message.includes('120%'), true);
expect('pesan konflik nonaktif menyebut nama', inactive[0].message.includes('Budi'), true);

// --- nonaktif tidak dihitung tersedia tapi tetap muncul di daftar beban ---
const budiRow = byId[r3];
expect('Budi tetap punya penugasan tercatat', budiRow.hasAssignment, true);

// --- estimasi biaya ---
const cost = estimateCost(db, PID, '2026-06-08', '2026-06-12');
const costAndi = cost.items.find(x => x.resource.id === r1);
// Andi: 60%+60% = 120% per hari × 2 hari kerja (08,09) = 2.4 hari efektif × 150000 = 360000
expect('biaya Andi (2.4 hari × 150000)', costAndi.cost, 360000);
expect('asumsi biaya ditampilkan', costAndi.assumption.includes('hari'), true);

// --- ubah alokasi menjadi aman: total 100% ---
db.prepare('UPDATE resource_assignments SET allocation = 40 WHERE resource_id = ? AND task_id = ?').run(r1, t1);
db.prepare('UPDATE resource_assignments SET allocation = 50 WHERE resource_id = ? AND task_id = ?').run(r1, t2);
const recheck = computeWorkload(db, PID, '2026-06-08', '2026-06-12');
const andi2 = recheck.rows.find(x => x.resource.id === r1);
expect('setelah diperbaiki: Andi beban 90%', andi2.daily['2026-06-08'], 90);
expect('setelah diperbaiki: tidak overallocated', andi2.isOverallocated, false);

console.log(`\n=== BEBAN KERJA: ${pass} lulus, ${fail} gagal ===`);
process.exit(fail > 0 ? 1 : 0);
