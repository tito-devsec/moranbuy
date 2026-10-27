import { ApiError } from '@moranbuy/core';

// Validates req.body, req.query or req.params against zod schemas and replaces them with the parsed values.
export function validate({ body, query, params } = {}) {
  return (req, _res, next) => {
    try {
      if (body) req.body = body.parse(req.body ?? {});
      if (query) req.query = query.parse(req.query ?? {});
      if (params) req.params = params.parse(req.params ?? {});
      next();
    } catch (err) {
      const details = {};
      for (const i of err.issues || []) details[i.path.join('.') || 'body'] = i.message;
      next(new ApiError(400, 'VALIDATION_ERROR', 'Some fields are not valid.', details));
    }
  };
}
