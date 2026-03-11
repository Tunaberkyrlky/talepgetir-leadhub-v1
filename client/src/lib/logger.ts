const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const configuredLevel: Level =
    (import.meta.env.VITE_LOG_LEVEL as Level) ||
    (import.meta.env.DEV ? 'debug' : 'warn');

const levelIndex = (l: Level) => LEVELS.indexOf(l);

export function createLogger(module: string) {
    const log = (level: Level, message: string, data?: unknown) => {
        if (levelIndex(level) < levelIndex(configuredLevel)) return;
        const entry = {
            time: new Date().toISOString(),
            level,
            module,
            message,
            ...(data !== undefined ? { data } : {}),
        };
        if (level === 'error') console.error(entry);
        else if (level === 'warn') console.warn(entry);
        else console.log(entry);
    };

    return {
        debug: (msg: string, data?: unknown) => log('debug', msg, data),
        info: (msg: string, data?: unknown) => log('info', msg, data),
        warn: (msg: string, data?: unknown) => log('warn', msg, data),
        error: (msg: string, data?: unknown) => log('error', msg, data),
    };
}
