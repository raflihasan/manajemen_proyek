'use strict';
// ============================================================================
// Uji logika perhitungan: kalender kerja, CPM/jalur kritis, lag FS/SS.
// Menjalankan skenario ber nilai yang diketahui dan memverifikasi hasil.
// Jalankan: node tests/calc-test.js
// ============================================================================
process.env.DB_PATH = ':memory:';
const { getDb } = require('../src/db/connection');
const { ensureSchema } = require('../src/db/schema');
const sched = require('../src/services/scheduler');

let pass = 0, fail = 0;
function expect(label, actual, expected) {
  if (String(actual) === String(expected)) { pass++; console.log(`PASS: ${label} (= ${actual})`); }
  else { fail++; console.log(`FAIL: ${label} — diharapkan ${expected}, didapat ${actual}`); }
}

// ---- setup in-memory DB ----
ensureSchema();
const db = getDb();
db.prepare(`INSERT INTO users (username, email, full_name, password_hash, role)
  VALUES ('uji','','Uji','-','manajer')`).run();
const UID = db.prepare('SELECT id FROM users WHERE username = ?').get('uji').id;
db.prepare(`INSERT INTO projects (name, organization, description, location, start_date, target_end_date, manager_id, status, progress)
  VALUES ('Uji Kalkulasi','Lab','uji','-','2026-06-01','2026-06-30',?,'Berjalan',0)`).run(UID);
const PID = 1;

// kalender: Senin-Jumat kerja, Sabtu-Minggu libur
db.prepare('INSERT INTO work_calendars (project_id, work_start, work_end) VALUES (?,?,?)').run(PID, '08:00', '17:00');
const CAL = db.prepare('SELECT id FROM work_calendars WHERE project_id = ?').get(PID).id;
for (let d = 0; d <= 6; d++) db.prepare('INSERT INTO calendar_workdays (calendar_id, day_of_week, is_workday) VALUES (?,?,?)').run(CAL, d, (d === 0 || d === 6) ? 0 : 1);
// hari libur: 2026-06-03 (Rabu)
db.prepare('INSERT INTO calendar_holidays (calendar_id, date, name, kind) VALUES (?,?,?,?)').run(CAL, '2026-06-03', 'Libur Uji', 'nasional');

const ctx = sched.getCalendar(db, PID);

// ---- 1. kalender kerja ----
// 2026-06-01 = Senin, 02 = Selasa, 03 = Rabu(LIBUR), 04 = Kamis, 05 = Jumat, 06 = Sabtu, 07 = Minggu
expect('isWorkday Senin 2026-06-01', sched.isWorkday('2026-06-01', ctx), true);
expect('isWorkday Rabu libur 2026-06-03', sched.isWorkday('2026-06-03', ctx), false);
expect('isWorkday Sabtu 2026-06-06', sched.isWorkday('2026-06-06', ctx), false);
// durasi 5 hari kerja dari 2026-06-01: 01,02,04,05,08 → selesai 2026-06-08 (Senin)
expect('addWorkdays(2026-06-01, 5)', sched.addWorkdays('2026-06-01', 5, ctx), '2026-06-08');
// durasi 3 dari 2026-06-02 (Selasa): 02,04,05 → 2026-06-05
expect('addWorkdays(2026-06-02, 3)', sched.addWorkdays('2026-06-02', 3, ctx), '2026-06-05');
// mulai dari hari libur (06-03) durasi 2: maju ke 04,05 → 2026-06-05
expect('addWorkdays(2026-06-03 libur, 2)', sched.addWorkdays('2026-06-03', 2, ctx), '2026-06-05');
expect('workdaysBetween 01..05 (ada libur 03)', sched.workdaysBetween('2026-06-01', '2026-06-05', ctx), 4);
expect('addWorkdayOffset(01, +2)', sched.addWorkdayOffset('2026-06-01', 2, ctx), '2026-06-04'); // 01→02→04
expect('subtractWorkdays(06-12, 4)', sched.subtractWorkdays('2026-06-12', 4, ctx), '2026-06-09');

// ---- 2. CPM skenario kecil dengan nilai yang diketahui ----
//  A "Mulai"        d=2  mulai 06-01 → EF=06-02
//  B "Analisis"     d=3  FS A      → ES=06-04 (03 libur) EF=06-08
//  C "Desain"       d=2  SS A lag1 → ES=06-02 EF=06-04
//  D "Implementasi" d=4  FS B, FS C → ES=max(06-09, 06-05)=06-09 EF=06-12
//  E "Finalisasi"   d=2  FS D      → ES=06-15 EF=06-16
// Jalur kritis: A→B→D→E (slack 0); C slack 2.
const insT = db.prepare(`INSERT INTO tasks (project_id, name, start_date, duration, end_date, priority, status, progress, sort_order)
  VALUES (?,?,?,?,?,?,?,0,?)`);
const a = insT.run(PID, 'A Mulai', '2026-06-01', 2, '2026-06-02', 'Tinggi', 'Selesai', 0).lastInsertRowid;
const b = insT.run(PID, 'B Analisis', '2026-06-04', 3, '2026-06-08', 'Tinggi', 'Berjalan', 0).lastInsertRowid;
const c = insT.run(PID, 'C Desain', '2026-06-02', 2, '2026-06-04', 'Sedang', 'Belum Dimulai', 0).lastInsertRowid;
const d = insT.run(PID, 'D Implementasi', '2026-06-09', 4, '2026-06-12', 'Tinggi', 'Belum Dimulai', 0).lastInsertRowid;
const e = insT.run(PID, 'E Finalisasi', '2026-06-15', 2, '2026-06-16', 'Mendesak', 'Belum Dimulai', 0).lastInsertRowid;
const insD = db.prepare('INSERT INTO task_dependencies (predecessor_id, successor_id, type, lag, notes) VALUES (?,?,?,?,?)');
insD.run(a, b, 'FS', 0, '');
insD.run(a, c, 'SS', 1, '');
insD.run(b, d, 'FS', 0, '');
insD.run(c, d, 'FS', 0, '');
insD.run(d, e, 'FS', 0, '');

const cpm = sched.computeCPM(db, PID);
expect('CPM ok', cpm.ok, 'true');
const m = {};
cpm.tasks.forEach(x => { m[x.id] = x; });

expect('CPM A: ES', m[a].es, '2026-06-01');
expect('CPM A: EF', m[a].ef, '2026-06-02');
expect('CPM B: ES (FS A, 03 libur)', m[b].es, '2026-06-04');
expect('CPM B: EF', m[b].ef, '2026-06-08');
expect('CPM C: ES (SS A lag 1)', m[c].es, '2026-06-02');
expect('CPM C: EF', m[c].ef, '2026-06-04');
expect('CPM D: ES = max(B EF+1, C EF+1)', m[d].es, '2026-06-09');
expect('CPM D: EF', m[d].ef, '2026-06-12');
expect('CPM E: ES', m[e].es, '2026-06-15');
expect('CPM E: EF', m[e].ef, '2026-06-16');
expect('CPM A kritis', m[a].isCritical, 'true');
expect('CPM B kritis', m[b].isCritical, 'true');
expect('CPM D kritis', m[d].isCritical, 'true');
expect('CPM E kritis', m[e].isCritical, 'true');
expect('CPM C non-kritis', m[c].isCritical, 'false');
expect('CPM C slack', m[c].slack, 2);
expect('CPM estimatedEnd', cpm.estimatedEnd, '2026-06-16');
// durasi jaringan = hari kerja dari ES min sampai EF akhir:
// 01,02,04,05,08,09,10,11,12,15,16 = 11 hari kerja
expect('CPM projectDuration (hari kerja)', cpm.projectDuration, 11);
expect('CPM lateThanTarget (target 06-30)', cpm.lateThanTarget, 'false');
expect('CPM criticalCount', cpm.criticalCount, 4);

// ---- 3. penolakan siklus ----
const cyc = sched.detectCycle(
  [{ id: a }, { id: b }], [{ predecessor_id: a, successor_id: b }, { predecessor_id: b, successor_id: a }]);
expect('siklus A↔B terdeteksi', cyc.hasCycle, 'true');
const noCyc = sched.detectCycle([{ id: a }, { id: b }], [{ predecessor_id: a, successor_id: b }]);
expect('tanpa siklus', noCyc.hasCycle, 'false');

// ---- 4. lag FS > 0 mempengaruhi jadwal ----
// F "Pasca" d=1 FS E lag 2 → ES = 3 hari kerja setelah EF E (06-16) = 06-19, EF=06-19
const f = insT.run(PID, 'F Pasca', '2026-06-19', 1, '2026-06-19', 'Rendah', 'Belum Dimulai', 0).lastInsertRowid;
insD.run(e, f, 'FS', 2, '');
const cpm2 = sched.computeCPM(db, PID);
const m2 = {};
cpm2.tasks.forEach(x => { m2[x.id] = x; });
expect('FS lag 2: ES F', m2[f].es, '2026-06-19');
expect('FS lag 2: EF F', m2[f].ef, '2026-06-19');
expect('FS lag 2: F kritis', m2[f].isCritical, 'true');
db.prepare('DELETE FROM task_dependencies WHERE successor_id = ?').run(f);
db.prepare('DELETE FROM tasks WHERE id = ?').run(f);

// ---- 5. durasi tanpa dependensi dimulai dari hari libur dimajukan ----
const g = insT.run(PID, 'G Libur Start', '2026-06-03', 2, '2026-06-05', 'Sedang', 'Belum Dimulai', 0).lastInsertRowid;
const cpm3 = sched.computeCPM(db, PID);
const m3 = {};
cpm3.tasks.forEach(x => { m3[x.id] = x; });
expect('mulai dari hari libur dimajukan ke hari kerja', m3[g].es, '2026-06-04');
expect('EF G', m3[g].ef, '2026-06-05');
db.prepare('DELETE FROM tasks WHERE id = ?').run(g);

console.log(`\n=== KALKULASI: ${pass} lulus, ${fail} gagal ===`);
process.exit(fail > 0 ? 1 : 0);
