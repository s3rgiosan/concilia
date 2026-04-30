import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import db from '../db.mjs';
import { AppError } from '../errors.mjs';

export const SESSION_DURATION_DAYS = 30;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const verify = pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
  } catch {
    return false;
  }
}

function generateSessionId() {
  return randomBytes(32).toString('hex');
}

function createSession(userId) {
  const id = generateSessionId();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt.toISOString());
  return id;
}

function userResponse(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email ?? null,
    displayName: user.display_name ?? null,
    locale: user.locale ?? 'en',
    createdAt: user.created_at,
  };
}

export function registerUser({ username, password, email, displayName, locale }) {
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    throw AppError.conflict('Username already taken');
  }
  if (email && db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    throw AppError.conflict('Email already registered');
  }
  const passwordHash = hashPassword(password);
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, email, display_name, locale) VALUES (?, ?, ?, ?, ?)'
  ).run(username, passwordHash, email ?? null, displayName ?? null, locale ?? 'en');
  const userId = Number(result.lastInsertRowid);
  const sessionId = createSession(userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return { user: userResponse(user), sessionId };
}

// Constant-time dummy hash to mask "user not found" timing differences.
// Generated once at module load; verifyPassword on this always returns false in roughly
// the same time as a real verification, so an attacker can't tell from latency whether
// the username exists.
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('hex'));

export function loginUser({ username, password }) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const storedHash = user ? user.password_hash : DUMMY_PASSWORD_HASH;
  const valid = verifyPassword(password, storedHash);
  if (!user || !valid) {
    throw AppError.unauthorized('Invalid username or password');
  }
  const sessionId = createSession(user.id);
  return { user: userResponse(user), sessionId };
}

export function logoutUser(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function updateProfile(userId, { displayName, email, locale }) {
  const updates = [];
  const params = [];
  if (displayName !== undefined) {
    updates.push('display_name = ?');
    params.push(displayName ?? null);
  }
  if (email !== undefined) {
    if (email) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
      if (existing) throw AppError.conflict('Email already registered');
    }
    updates.push('email = ?');
    params.push(email ?? null);
  }
  if (locale !== undefined) {
    updates.push('locale = ?');
    params.push(locale);
  }
  if (updates.length === 0) throw AppError.badRequest('No fields to update');
  params.push(userId);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return userResponse(user);
}

export function changePassword(userId, currentPassword, newPassword) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user) throw AppError.notFound('User not found');
  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw AppError.unauthorized('Current password is incorrect');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
}

export function invalidateUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function cleanExpiredSessions() {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  return result.changes;
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
