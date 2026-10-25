'use strict';
// Seeder: membuat akun demo, proyek contoh "Seminar Teknologi Digital Kampus",
// tugas, dependensi, sumber daya, dan penugasan agar aplikasi langsung dapat diuji.
const bcrypt = require('bcryptjs');
const { ensureSchema } = require('./schema');
const { getDb } = require('./connection');
const { addDays } = require('../utils/date');

function seed(force = false) {
  const db = getDb();
  ensureSchema(db);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0 && !force) {
    console.log('Database sudah berisi data. Gunakan --force untuk menanam ulang.');
    return;
  }

  // ---- users ----
  const hash = p => bcrypt.hashSync(p, 10);
  const insertUser = db.prepare(`
    INSERT INTO users (username, email, full_name, password_hash, role)
    VALUES (?,?,?,?,?)`);
  const adminId = insertUser.run('admin', 'admin@kampus.ac.id', 'Administrator Sistem', hash('admin123'), 'admin').lastInsertRowid;
  const mgrId = insertUser.run('manajer', 'manajer@kampus.ac.id', 'Rina Wulandari', hash('manajer123'), 'manajer').lastInsertRowid;
  const anggotaIds = [
    insertUser.run('andi', 'andi@kampus.ac.id', 'Andi Pratama', hash('anggota123'), 'anggota').lastInsertRowid,
    insertUser.run('sari', 'sari@kampus.ac.id', 'Sari Dewi', hash('anggota123'), 'anggota').lastInsertRowid,
    insertUser.run('budi', 'budi@kampus.ac.id', 'Budi Santoso', hash('anggota123'), 'anggota').lastInsertRowid,
    insertUser.run('citra', 'citra@kampus.ac.id', 'Citra Lestari', hash('anggota123'), 'anggota').lastInsertRowid
  ];

  // ---- proyek ----
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const { toISODate } = require('../utils/date');
  const iso = d => toISODate(d);
  const projStart = iso(startDate);
  const projTarget = iso(new Date(startDate.getTime() + 35 * 86400000));

  const projId = db.prepare(`
    INSERT INTO projects (name, organization, description, location, start_date, target_end_date, manager_id, status, progress)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'Seminar Teknologi Digital Kampus',
    'Panitia Seminar Teknologi Digital',
    'Penyelenggaraan seminar kampus mulai dari perencanaan hingga pelaksanaan, evaluasi, dan laporan akhir.',
    'Aula Utama Kampus',
    projStart, projTarget, mgrId, 'Berjalan', 0
  ).lastInsertRowid;

  // anggota proyek
  const addMember = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?,?)');
  [mgrId, ...anggotaIds].forEach(uid => addMember.run(projId, uid));

  // kalender kerja (Senin-Jumat kerja, Sabtu-Minggu libur)
  const calId = db.prepare('INSERT INTO work_calendars (project_id, work_start, work_end) VALUES (?,?,?)')
    .run(projId, '08:00', '17:00').lastInsertRowid;
  const insWd = db.prepare('INSERT INTO calendar_workdays (calendar_id, day_of_week, is_workday) VALUES (?,?,?)');
  [0,1,2,3,4,5,6].forEach(d => insWd.run(calId, d, (d === 0 || d === 6) ? 0 : 1));
  const insHol = db.prepare('INSERT OR IGNORE INTO calendar_holidays (calendar_id, date, name, kind) VALUES (?,?,?,?)');
  const h1 = iso(new Date(startDate.getTime() + 10 * 86400000));
  const h2 = iso(new Date(startDate.getTime() + 17 * 86400000));
  insHol.run(calId, h1, 'Hari Libur Nasional (contoh)', 'nasional');
  insHol.run(calId, h2, 'Libur Khusus Kampus (contoh)', 'khusus');

  // ---- sumber daya (tim) ----
  const insRes = db.prepare(`
    INSERT INTO resources (full_name, phone, email, role, rate, rate_unit, is_active, notes)
    VALUES (?,?,?,?,?,?,?,?)`);
  const resIds = {
    andi: insRes.run('Andi Pratama', '081234567890', 'andi@kampus.ac.id', 'Manajer Proyek', 350000, 'per hari', 1, 'Koordinasi umum').lastInsertRowid,
    sari: insRes.run('Sari Dewi', '081234567891', 'sari@kampus.ac.id', 'Koordinator Logistik', 300000, 'per hari', 1, 'Logistik dan venue').lastInsertRowid,
    budi: insRes.run('Budi Santoso', '081234567892', 'budi@kampus.ac.id', 'Tim Perlengkapan dan Teknis', 250000, 'per hari', 1, 'Perlengkapan teknis').lastInsertRowid,
    citra: insRes.run('Citra Lestari', '081234567893', 'citra@kampus.ac.id', 'Koordinator Perlengkapan', 275000, 'per hari', 1, 'Perlengkapan acara').lastInsertRowid,
    dian: insRes.run('Dian Permata', '081234567894', 'dian@kampus.ac.id', 'Koordinator Quality Control Acara', 260000, 'per hari', 1, 'QC rundown dan pelaksanaan').lastInsertRowid
  };

  // ketidakhadiran contoh
  db.prepare('INSERT INTO resource_unavailability (resource_id, start_date, end_date, reason, status) VALUES (?,?,?,?,?)')
    .run(resIds.budi, iso(new Date(startDate.getTime() + 6 * 86400000)), iso(new Date(startDate.getTime() + 7 * 86400000)), 'Cuti pribadi', 'Disetujui');

  // ---- tugas ----
  // Mulai dari hari kerja pertama
  const { addWorkdays, getCalendar } = require('../services/scheduler');
  const ctx = getCalendar(db, projId);
  let firstWorkday = projStart;
  { let g = 0; const { isWorkday } = require('../services/scheduler');
    const { addDays: ad } = require('../utils/date');
    while (!isWorkday(firstWorkday, ctx) && g < 30) { firstWorkday = ad(firstWorkday, 1); g++; } }

  const insTask = db.prepare(`
    INSERT INTO tasks (project_id, parent_id, name, description, start_date, duration, end_date,
                       priority, status, progress, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const taskDefs = [
    ['Menentukan konsep seminar', 'Menentukan tema, tujuan, dan format seminar', 2, 'Tinggi', 'Selesai', 100],
    ['Menyusun anggaran dan target peserta', 'Menyusun RAB dan target jumlah peserta', 2, 'Tinggi', 'Selesai', 100],
    ['Menetapkan tanggal dan lokasi', 'Menentukan tanggal pelaksanaan dan venue', 2, 'Sedang', 'Berjalan', 50],
    ['Membentuk panitia dan divisi', 'Pembagian tugas tiap divisi', 2, 'Sedang', 'Berjalan', 50],
    ['Menghubungi calon pembicara', 'Mengundang dan konfirmasi pembicara', 4, 'Mendesak', 'Berjalan', 25],
    ['Memesan lokasi acara', 'Pemesanan dan pengecekan fasilitas venue', 2, 'Sedang', 'Belum Dimulai', 0],
    ['Membuat materi publikasi', 'Desain poster, banner, dan konten media sosial', 3, 'Sedang', 'Berjalan', 40],
    ['Membuka pendaftaran peserta', 'Setup formulir dan kanal pendaftaran', 1, 'Sedang', 'Belum Dimulai', 0],
    ['Menyiapkan rundown acara', 'Menyusun rundown detail seminar', 3, 'Tinggi', 'Belum Dimulai', 0],
    ['Menyiapkan perlengkapan dan kebutuhan teknis', 'Audio, proyektor, dan kebutuhan teknis lain', 3, 'Tinggi', 'Belum Dimulai', 0],
    ['Melaksanakan gladi bersih', 'Gladi bersih bersama panitia dan pembicara', 1, 'Tinggi', 'Belum Dimulai', 0],
    ['Melaksanakan seminar', 'Pelaksanaan acara seminar sesuai rundown', 1, 'Mendesak', 'Belum Dimulai', 0],
    ['Menyusun evaluasi dan laporan akhir', 'Mengumpulkan evaluasi dan menyusun laporan', 2, 'Sedang', 'Belum Dimulai', 0]
  ];

  const tid = {};
  taskDefs.forEach((t, i) => {
    tid[t[0]] = insTask.run(projId, null, t[0], t[1], null, t[2], null, t[3], t[4], t[5], i).lastInsertRowid;
  });

  // subtugas contoh di bawah "Menyusun anggaran dan target peserta" dan "Menyiapkan perlengkapan"
  const sub1 = insTask.run(projId, tid['Menyusun anggaran dan target peserta'], 'Menyusun Rincian Anggaran Biaya', 'Rincian kebutuhan dan biaya', null, 1, null, 'Tinggi', 'Selesai', 100, 0).lastInsertRowid;
  const sub2 = insTask.run(projId, tid['Menyusun anggaran dan target peserta'], 'Menetapkan Target Jumlah Peserta', 'Target peserta seminar', null, 1, null, 'Sedang', 'Selesai', 100, 1).lastInsertRowid;
  const sub3 = insTask.run(projId, tid['Menyiapkan perlengkapan dan kebutuhan teknis'], 'Menyiapkan Audio dan Proyektor', 'Sewa dan pengecekan alat', null, 1, null, 'Tinggi', 'Belum Dimulai', 0, 0).lastInsertRowid;
  const sub4 = insTask.run(projId, tid['Menyiapkan perlengkapan dan kebutuhan teknis'], 'Menyiapkan Rundown dan Sertifikat', 'Cetak sertifikat peserta', null, 1, null, 'Sedang', 'Belum Dimulai', 0, 1).lastInsertRowid;

  // ---- dependensi (FS/SS dengan lag) ----
  const insDep = db.prepare(`
    INSERT INTO task_dependencies (predecessor_id, successor_id, type, lag, notes)
    VALUES (?,?,?,?,?)`);
  const D = [
    ['Menentukan konsep seminar', 'Menyusun anggaran dan target peserta', 'FS', 0],
    ['Menentukan konsep seminar', 'Menetapkan tanggal dan lokasi', 'FS', 0],
    ['Menentukan konsep seminar', 'Membentuk panitia dan divisi', 'FS', 0],
    ['Menentukan konsep seminar', 'Menghubungi calon pembicara', 'FS', 0],
    ['Menentukan konsep seminar', 'Membuat materi publikasi', 'FS', 0],
    ['Menetapkan tanggal dan lokasi', 'Memesan lokasi acara', 'FS', 0],
    ['Membuat materi publikasi', 'Membuka pendaftaran peserta', 'FS', 0],
    ['Membentuk panitia dan divisi', 'Menyiapkan rundown acara', 'FS', 0],
    ['Memesan lokasi acara', 'Menyiapkan perlengkapan dan kebutuhan teknis', 'FS', 0],
    ['Menyiapkan rundown acara', 'Melaksanakan gladi bersih', 'FS', 0],
    ['Menyiapkan perlengkapan dan kebutuhan teknis', 'Melaksanakan gladi bersih', 'FS', 0],
    ['Melaksanakan gladi bersih', 'Melaksanakan seminar', 'FS', 0],
    ['Menghubungi calon pembicara', 'Melaksanakan seminar', 'FS', 0],
    ['Melaksanakan seminar', 'Menyusun evaluasi dan laporan akhir', 'FS', 0],
    // contoh SS
    ['Menyusun anggaran dan target peserta', 'Menghubungi calon pembicara', 'SS', 2]
  ];
  D.forEach(d => insDep.run(tid[d[0]], tid[d[1]], d[2], d[3], null));

  // ---- penugasan ----
  const insAsg = db.prepare(`
    INSERT INTO resource_assignments (task_id, resource_id, role_on_task, allocation, start_date, end_date, notes)
    VALUES (?,?,?,?,?,?,?)`);
  const A = [
    ['Menentukan konsep seminar', 'andi', 'Pemimpin', 100],
    ['Menyusun anggaran dan target peserta', 'andi', 'Penanggung jawab', 60],
    ['Menyusun anggaran dan target peserta', 'sari', 'Eksekutor', 50],
    ['Menetapkan tanggal dan lokasi', 'sari', 'Koordinator', 100],
    ['Membentuk panitia dan divisi', 'andi', 'Pemimpin', 100],
    ['Menghubungi calon pembicara', 'andi', 'Narasumber', 100],
    ['Memesan lokasi acara', 'sari', 'Koordinator', 100],
    ['Membuat materi publikasi', 'citra', 'Desainer', 100],
    ['Membuka pendaftaran peserta', 'citra', 'Operator', 80],
    ['Menyiapkan rundown acara', 'dian', 'Perancang rundown', 100],
    ['Menyiapkan perlengkapan dan kebutuhan teknis', 'budi', 'Teknisi', 100],
    ['Melaksanakan gladi bersih', 'budi', 'Teknisi', 60],
    ['Melaksanakan gladi bersih', 'dian', 'QC', 60],
    ['Melaksanakan seminar', 'andi', 'Ketua panitia', 50],
    ['Melaksanakan seminar', 'budi', 'Teknisi', 50],
    ['Melaksanakan seminar', 'dian', 'QC', 50],
    ['Menyusun evaluasi dan laporan akhir', 'andi', 'Pelapor', 100]
  ];
  A.forEach(a => {
    const taskId = tid[a[0]];
    const resId = resIds[a[1]];
    insAsg.run(taskId, resId, a[2], a[3], null, null, null);
  });

  console.log('Seed selesai.');
  console.log('Akun demo:');
  console.log('  admin  / admin123   (Admin)');
  console.log('  manajer / manajer123 (Manajer Proyek)');
  console.log('  andi, sari, budi, citra / anggota123 (Anggota Tim)');
}

if (require.main === module) {
  seed(process.argv.includes('--force'));
}

module.exports = { seed };
