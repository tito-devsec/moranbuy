import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.APP_ENV === 'test' ? 'silent' : 'info');

// One pino logger for the whole process; secrets and phone numbers are redacted by path.
export const logger = pino({
  level,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.accessToken', '*.refreshToken', '*.apiKey', '*.password', '*.phone', '*.customerPhone'],
    censor: '[redacted]',
  },
});
