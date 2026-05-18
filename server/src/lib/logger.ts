import pino from 'pino';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    // Redact sensitive fields anywhere they appear in log payloads (errorHandler, etc.)
    redact: {
        paths: [
            'body.password', 'body.token', 'body.refresh_token', 'body.access_token',
            'body.apiKey', 'body.api_key', 'body.secret', 'body.authorization',
            'req.headers.authorization', 'req.headers.cookie',
            '*.password', '*.token', '*.refresh_token', '*.access_token',
        ],
        censor: '[REDACTED]',
    },
    transport: !process.env.VERCEL && process.env.NODE_ENV !== 'production'
        ? {
              target: 'pino-pretty',
              options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname,req,res,responseTime',
                  messageFormat: '{module} {msg}',
                  singleLine: true,
              },
          }
        : undefined,
});

export function createLogger(module: string) {
    return logger.child({ module });
}

export default logger;
