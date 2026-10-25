'use strict';
// Koneksi database menggunakan node:sqlite (bawaan Node.js 22+, tanpa kompilasi native).
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let db = null;

function getDb() {
  if (db) return db;
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

function closeDb() {
  if (db) { try { db.close(); } catch (_) {} db = null; }
}

module.exports = { getDb, closeDb };
