import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.mjs';
import { asyncHandler } from '../middleware/asyncHandler.mjs';
import { validate } from '../middleware/validate.mjs';
import { registerSchema, loginSchema, updateProfileSchema, changePasswordSchema } from '../schemas/auth.mjs';
import { registerUser, loginUser, logoutUser, updateProfile, changePassword, SESSION_DURATION_DAYS } from '../services/auth.mjs';

const router = Router();

function setSessionCookie(res, sessionId) {
  res.cookie('session_id', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000,
  });
}

// POST /api/auth/register
router.post('/register', validate({ body: registerSchema }), asyncHandler((req, res) => {
  const { username, password, email, displayName, locale } = req.body;
  const result = registerUser({ username, password, email, displayName, locale });
  setSessionCookie(res, result.sessionId);
  res.status(201).json({ success: true, data: { user: result.user, sessionId: result.sessionId } });
}));

// POST /api/auth/login
router.post('/login', validate({ body: loginSchema }), asyncHandler((req, res) => {
  const { username, password } = req.body;
  const result = loginUser({ username, password });
  setSessionCookie(res, result.sessionId);
  res.json({ success: true, data: { user: result.user, sessionId: result.sessionId } });
}));

// POST /api/auth/logout
router.post('/logout', authMiddleware, asyncHandler((req, res) => {
  if (req.sessionId) logoutUser(req.sessionId);
  res.clearCookie('session_id');
  res.json({ success: true });
}));

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  res.json({ success: true, data: req.user });
});

// PUT /api/auth/profile
router.put('/profile', authMiddleware, validate({ body: updateProfileSchema }), asyncHandler((req, res) => {
  const { displayName, email, locale } = req.body;
  const user = updateProfile(req.user.id, { displayName, email, locale });
  res.json({ success: true, data: user });
}));

// PUT /api/auth/password
router.put('/password', authMiddleware, validate({ body: changePasswordSchema }), asyncHandler((req, res) => {
  const { currentPassword, newPassword } = req.body;
  changePassword(req.user.id, currentPassword, newPassword);
  res.json({ success: true });
}));

export default router;
