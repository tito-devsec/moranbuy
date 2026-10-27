// An error with an HTTP status and a stable machine code for API responses.
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Shorthand constructors for the common cases.
export const badRequest = (code, message, details) => new ApiError(400, code, message, details);
export const unauthorized = (code = 'UNAUTHORIZED', message = 'Sign in to continue.') => new ApiError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = 'You are not allowed to do this.') => new ApiError(403, code, message);
export const notFound = (code = 'NOT_FOUND', message = 'Not found.') => new ApiError(404, code, message);
export const conflict = (code, message) => new ApiError(409, code, message);
