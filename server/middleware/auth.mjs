import db from '../db.mjs';
import { AppError } from '../errors.mjs';

export function authMiddleware(req, res, next) {
  try {
    let sessionId = req.cookies?.session_id;
    if (!sessionId) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) sessionId = authHeader.slice(7);
    }
    if (!sessionId) throw AppError.unauthorized('Authentication required');

    const session = db.prepare(
      "SELECT id, user_id, expires_at FROM sessions WHERE id = ? AND expires_at > datetime('now')"
    ).get(sessionId);
    if (!session) throw AppError.unauthorized('Session invalid or expired');

    const user = db.prepare(
      'SELECT id, username, email, display_name, locale, created_at FROM users WHERE id = ?'
    ).get(session.user_id);
    if (!user) throw AppError.unauthorized('User not found');

    req.user = {
      id: user.id,
      username: user.username,
      email: user.email ?? null,
      displayName: user.display_name ?? null,
      locale: user.locale ?? 'en',
      createdAt: user.created_at,
    };
    req.sessionId = sessionId;
    next();
  } catch (err) {
    next(err);
  }
}
