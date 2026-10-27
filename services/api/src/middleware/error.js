import { ApiError } from '@moranbuy/core';
import { logger } from '@moranbuy/observability';

// Answers unknown routes with a JSON 404.
export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'NOT_FOUND', message: 'That route does not exist.' });
}

// Turns thrown errors into JSON; unexpected ones are logged and answered without internals.
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_JSON', message: 'The request body is not valid JSON.' });
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' });
}
