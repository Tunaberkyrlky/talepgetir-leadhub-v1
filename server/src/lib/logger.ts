import pino from 'pino';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
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
