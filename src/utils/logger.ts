type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

// Broadcast callback type for dashboard integration
type LogBroadcastCallback = (level: string, context: string, message: string, data?: object) => void;

class Logger {
    private level: LogLevel = 'info';
    private prefix: string;
    private static broadcastCallback: LogBroadcastCallback | null = null;

    constructor(prefix: string = 'BOT') {
        this.prefix = prefix;
    }

    /**
     * Set broadcast callback for dashboard log streaming
     */
    static setBroadcastCallback(callback: LogBroadcastCallback | null): void {
        Logger.broadcastCallback = callback;
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
    }

    private formatMessage(level: LogLevel, message: string, data?: unknown): string {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        const prefix = this.prefix ? `[${this.prefix}]` : '';

        let formatted = `${timestamp} ${levelStr} ${prefix} ${message}`;
        if (data !== undefined) {
            formatted += ` ${JSON.stringify(data)}`;
        }
        return formatted;
    }

    private broadcast(level: string, message: string, data?: unknown): void {
        if (Logger.broadcastCallback) {
            Logger.broadcastCallback(
                level.toUpperCase(),
                this.prefix,
                message,
                data as object | undefined
            );
        }
    }

    debug(message: string, data?: unknown): void {
        if (this.shouldLog('debug')) {
            console.log(this.formatMessage('debug', message, data));
            this.broadcast('debug', message, data);
        }
    }

    info(message: string, data?: unknown): void {
        if (this.shouldLog('info')) {
            console.log(this.formatMessage('info', message, data));
            this.broadcast('info', message, data);
        }
    }

    warn(message: string, data?: unknown): void {
        if (this.shouldLog('warn')) {
            console.warn(this.formatMessage('warn', message, data));
            this.broadcast('warn', message, data);
        }
    }

    error(message: string, data?: unknown): void {
        if (this.shouldLog('error')) {
            console.error(this.formatMessage('error', message, data));
            this.broadcast('error', message, data);
        }
    }

    trade(action: string, details: Record<string, unknown>): void {
        // Trade logs are always shown at info level
        if (this.shouldLog('info')) {
            const timestamp = new Date().toISOString();
            console.log(`${timestamp} TRADE [${this.prefix}] ${action}`, JSON.stringify(details));
            this.broadcast('TRADE', action, details);
        }
    }

    child(prefix: string): Logger {
        const child = new Logger(`${this.prefix}:${prefix}`);
        child.setLevel(this.level);
        return child;
    }
}

// Global logger instance
export const logger = new Logger('BOT');

// Export the class for creating child loggers
export { Logger };

