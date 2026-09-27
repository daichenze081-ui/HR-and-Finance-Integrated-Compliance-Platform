'use strict';

class AppError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const badRequest = (message, detail) => new AppError(400, 'invalid_request', message, detail);
const unauthorized = (message = 'Sign in required') => new AppError(401, 'unauthenticated', message);
const forbidden = (message = 'Your role is not permitted to perform this action', detail) => new AppError(403, 'forbidden', message, detail);
const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
const conflict = (message, detail) => new AppError(409, 'conflict', message, detail);
const tooLarge = (message = 'Payload too large') => new AppError(413, 'payload_too_large', message);
const unprocessable = (message, detail) => new AppError(422, 'unprocessable', message, detail);
const failedDependency = (message, detail) => new AppError(424, 'upstream_failure', message, detail);
const timeout = (message, detail) => new AppError(504, 'timeout', message, detail);

module.exports = {
  AppError, badRequest, unauthorized, forbidden, notFound,
  conflict, tooLarge, unprocessable, failedDependency, timeout
};
