'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'app.db'),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-event-kampus-change-in-production',
  sessionName: 'sid',
  defaultWorkStart: '08:00',
  defaultWorkEnd: '17:00'
};
