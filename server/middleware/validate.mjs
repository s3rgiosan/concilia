import { ZodError } from 'zod';
import { AppError } from '../errors.mjs';

function formatZodError(error) {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'value';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function validate(schemas) {
  return (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(AppError.badRequest(formatZodError(err)));
        return;
      }
      next(err);
    }
  };
}
