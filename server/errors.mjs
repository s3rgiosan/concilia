export class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }

  static badRequest(message) { return new AppError(message, 400); }
  static unauthorized(message) { return new AppError(message, 401); }
  static notFound(message) { return new AppError(message, 404); }
  static conflict(message) { return new AppError(message, 409); }
}
