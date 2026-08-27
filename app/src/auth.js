// Autenticação: senhas com scrypt + sal; sessão por token opaco persistido no banco.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { one, run } from './db.js';

const SESSION_DAYS = 7;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  run(db, 'INSERT INTO sessions (token, userId, expiresAt) VALUES (?, ?, ?)', token, userId, expiresAt);
  return { token, expiresAt };
}

export function destroySession(db, token) {
  if (token) run(db, 'DELETE FROM sessions WHERE token = ?', token);
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = one(
    db,
    `SELECT u.id, u.name, u.email, u.role, s.expiresAt
       FROM sessions s JOIN users u ON u.id = s.userId
      WHERE s.token = ?`,
    token
  );
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    destroySession(db, token);
    return null;
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

export function parseCookies(header) {
  const jar = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) jar[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return jar;
}

export function sessionCookie(token, expiresAt) {
  const expires = token ? new Date(expiresAt).toUTCString() : new Date(0).toUTCString();
  return `sid=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}`;
}
