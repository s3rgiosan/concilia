import { AppError } from '../errors.mjs';

export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, error: err.message });
    return;
  }

  console.error('Unhandled error:', err);

  res.status(500).json({ success: false, error: 'Internal server error' });
}
