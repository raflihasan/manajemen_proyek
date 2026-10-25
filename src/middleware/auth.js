'use strict';
// Autentikasi & otorisasi berbasis peran.
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login?silahkan=login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.redirect('/login');
    if (roles.includes(req.session.user.role)) return next();
    return res.status(403).render('error', {
      title: 'Akses Ditolak',
      message: 'Anda tidak memiliki izin untuk mengakses halaman ini.',
      user: req.session.user
    });
  };
}

// Akses proyek: admin bebas; manajer hanya proyek yang dikelolanya; anggota hanya yang menjadi anggota.
function canAccessProject(db, user, projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!p) return { ok: false, project: null, reason: 'Proyek tidak ditemukan.' };
  if (user.role === 'admin') return { ok: true, project: p };
  if (user.role === 'manajer') {
    if (p.manager_id === user.id) return { ok: true, project: p };
    const mem = db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?')
      .get(projectId, user.id);
    if (mem) return { ok: true, project: p };
    return { ok: false, project: p, reason: 'Anda tidak berwenang mengelola proyek ini.' };
  }
  // anggota
  const mem = db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?')
    .get(projectId, user.id);
  if (mem) return { ok: true, project: p };
  return { ok: false, project: p, reason: 'Anda tidak termasuk anggota proyek ini.' };
}

function canManageProject(user) {
  return user.role === 'admin' || user.role === 'manajer';
}

module.exports = { requireLogin, requireRole, canAccessProject, canManageProject };
