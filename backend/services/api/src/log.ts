import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { colorize: true } },
  redact: ['req.headers.authorization', '*.privateKey', '*.OPERATOR_PRIVATE_KEY_*'],
});
