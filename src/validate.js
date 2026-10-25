'use strict';
// Validasi input sisi server (bahasa Indonesia).
function isEmpty(v) { return v === undefined || v === null || String(v).trim() === ''; }

function validateProject(d) {
  const errors = [];
  if (isEmpty(d.name)) errors.push('Nama proyek wajib diisi.');
  if (isEmpty(d.organization)) errors.push('Organisasi wajib diisi.');
  if (isEmpty(d.start_date)) errors.push('Tanggal mulai wajib diisi.');
  if (isEmpty(d.target_end_date)) errors.push('Target tanggal selesai wajib diisi.');
  if (d.start_date && d.target_end_date && d.target_end_date < d.start_date)
    errors.push('Target tanggal selesai tidak boleh lebih awal dari tanggal mulai.');
  const statuses = ['Perencanaan', 'Berjalan', 'Ditunda', 'Selesai', 'Dibatalkan'];
  if (!statuses.includes(d.status)) errors.push('Status proyek tidak valid.');
  return errors;
}

function validateTask(d) {
  const errors = [];
  if (isEmpty(d.name)) errors.push('Nama tugas wajib diisi.');
  if (isEmpty(d.project_id)) errors.push('Proyek harus dipilih.');
  const dur = Number(d.duration);
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isInteger(dur))
    errors.push('Durasi harus berupa bilangan bulat positif (hari kerja).');
  const prog = Number(d.progress);
  if (!Number.isFinite(prog) || prog < 0 || prog > 100)
    errors.push('Persentase progres harus berada antara 0 dan 100.');
  const priorities = ['Rendah', 'Sedang', 'Tinggi', 'Mendesak'];
  if (!priorities.includes(d.priority)) errors.push('Prioritas tidak valid.');
  const statuses = ['Belum Dimulai', 'Berjalan', 'Terhambat', 'Selesai', 'Dibatalkan'];
  if (!statuses.includes(d.status)) errors.push('Status tugas tidak valid.');
  if (d.start_date && d.end_date && d.end_date < d.start_date)
    errors.push('Tanggal selesai tidak boleh lebih awal dari tanggal mulai.');
  if (d.status === 'Selesai' && prog < 100)
    errors.push('Status Selesai harus disertai progres 100%.');
  return errors;
}

function validateResource(d) {
  const errors = [];
  if (isEmpty(d.full_name)) errors.push('Nama anggota wajib diisi.');
  if (!isEmpty(d.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email))
    errors.push('Format email tidak valid.');
  if (!isEmpty(d.rate) && (!Number.isFinite(Number(d.rate)) || Number(d.rate) < 0))
    errors.push('Tarif harus berupa angka yang valid.');
  const units = ['per hari', 'per bulan'];
  if (!units.includes(d.rate_unit)) errors.push('Satuan tarif tidak valid.');
  return errors;
}

function validateAssignment(d) {
  const errors = [];
  if (isEmpty(d.resource_id)) errors.push('Sumber daya harus dipilih.');
  const alloc = Number(d.allocation);
  if (!Number.isFinite(alloc) || alloc <= 0 || alloc > 200)
    errors.push('Alokasi kerja harus berada dalam rentang 1–200 persen.');
  if (d.start_date && d.end_date && d.end_date < d.start_date)
    errors.push('Tanggal selesai penugasan tidak boleh lebih awal dari tanggal mulai.');
  return errors;
}

function validateDependency(d) {
  const errors = [];
  if (isEmpty(d.predecessor_id)) errors.push('Tugas pendahulu harus dipilih.');
  if (isEmpty(d.successor_id)) errors.push('Tugas penerus harus dipilih.');
  if (!['FS', 'SS'].includes(d.type)) errors.push('Jenis dependensi harus FS atau SS.');
  const lag = Number(d.lag);
  if (!Number.isInteger(lag) || lag < 0) errors.push('Lag harus berupa angka bulat tidak negatif (hari kerja).');
  return errors;
}

module.exports = { isEmpty, validateProject, validateTask, validateResource, validateAssignment, validateDependency };
