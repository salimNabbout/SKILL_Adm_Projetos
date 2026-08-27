// Camada de dados: SQLite nativo do Node. Helpers retornam linhas cruas;
// as regras de negócio ficam nas procedures (api.js).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const PROJECT_STATUSES = ['planning', 'on_track', 'attention', 'delayed', 'paused', 'completed'];
export const MILESTONE_STATUSES = ['pending', 'in_progress', 'completed'];
export const DELIVERABLE_STATUSES = ['not_started', 'in_progress', 'review', 'completed'];
export const ACCESS_ROLES = ['client', 'viewer', 'manager'];
// Tipos de atividade automáticos (auditoria) são somente leitura; 'update' é publicação manual editável.
export const AUTOMATED_ACTIVITY_TYPES = [
  'project_created', 'project_updated', 'status_changed',
  'client_linked', 'client_unlinked', 'member_assigned', 'member_removed',
  'milestone', 'deliverable', 'document', 'feedback'
];
export const MANUAL_ACTIVITY_TYPE = 'update';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'client',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expiresAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planning',
      progress INTEGER NOT NULL DEFAULT 0,
      startDate TEXT,
      endDate TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS projectMembers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      accessRole TEXT NOT NULL DEFAULT 'client',
      assignedAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (projectId, userId)
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      legalName TEXT NOT NULL DEFAULT '',
      contactName TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS projectClients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      clientId INTEGER NOT NULL REFERENCES clients(id),
      relationship TEXT NOT NULL DEFAULT 'primary',
      UNIQUE (projectId, clientId)
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      dueDate TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      completedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS deliverables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      ownerName TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'not_started',
      progress INTEGER NOT NULL DEFAULT 0,
      dueDate TEXT,
      needsAttention INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS projectContacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      isPrimary INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS projectDocuments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      deliverableId INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      fileKey TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      sizeBytes INTEGER NOT NULL,
      uploadedBy TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS projectActivities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      actorName TEXT NOT NULL DEFAULT '',
      activityType TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS projectFeedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id),
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ---- helpers (linhas cruas) ----
export function one(db, sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}
export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
