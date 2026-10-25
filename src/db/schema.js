'use strict';
// Skema database: pembuatan seluruh tabel yang dibutuhkan sistem.
const { getDb } = require('./connection');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manajer','anggota')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  organization TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_date TEXT NOT NULL,
  target_end_date TEXT NOT NULL,
  actual_end_date TEXT,
  manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Perencanaan'
    CHECK (status IN ('Perencanaan','Berjalan','Ditunda','Selesai','Dibatalkan')),
  progress REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS project_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS work_calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  work_start TEXT NOT NULL DEFAULT '08:00',
  work_end TEXT NOT NULL DEFAULT '17:00',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- hari kerja dalam seminggu: 0=Minggu..6=Sabtu
CREATE TABLE IF NOT EXISTS calendar_workdays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES work_calendars(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_workday INTEGER NOT NULL DEFAULT 1,
  UNIQUE (calendar_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS calendar_holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES work_calendars(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'khusus' CHECK (kind IN ('nasional','khusus')),
  UNIQUE (calendar_id, date)
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  role TEXT,
  rate REAL NOT NULL DEFAULT 0,
  rate_unit TEXT NOT NULL DEFAULT 'per hari' CHECK (rate_unit IN ('per hari','per bulan')),
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  start_date TEXT,
  duration INTEGER NOT NULL DEFAULT 1,
  end_date TEXT,
  priority TEXT NOT NULL DEFAULT 'Sedang'
    CHECK (priority IN ('Rendah','Sedang','Tinggi','Mendesak')),
  status TEXT NOT NULL DEFAULT 'Belum Dimulai'
    CHECK (status IN ('Belum Dimulai','Berjalan','Terhambat','Selesai','Dibatalkan')),
  progress REAL NOT NULL DEFAULT 0,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  predecessor_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  successor_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'FS' CHECK (type IN ('FS','SS')),
  lag INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);

CREATE TABLE IF NOT EXISTS resource_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  role_on_task TEXT,
  allocation REAL NOT NULL DEFAULT 100,
  start_date TEXT,
  end_date TEXT,
  notes TEXT,
  UNIQUE (task_id, resource_id)
);

CREATE TABLE IF NOT EXISTS resource_unavailability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Disetujui'
    CHECK (status IN ('Menunggu','Disetujui','Ditolak'))
);

CREATE TABLE IF NOT EXISTS task_progress_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  old_progress REAL,
  new_progress REAL,
  old_status TEXT,
  new_status TEXT,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

function ensureSchema() {
  const db = getDb();
  db.exec(SCHEMA_SQL);
  return db;
}

module.exports = { ensureSchema };
