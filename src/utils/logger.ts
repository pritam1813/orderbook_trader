import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

// ANSI color codes for terminal output
const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',

    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',

    // Background colors
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
};

// Level-specific colors
const LEVEL_COLORS: Record<string, string> = {
    DEBUG: COLORS.gray,
    INFO: COLORS.cyan,
    WARN: `${COLORS.bright}${COLORS.yellow}`,
    ERROR: `${COLORS.bright}${COLORS.red}`,
    TRADE: `${COLORS.bright}${COLORS.green}`,
};

// Broadcast callback type for dashboard integration
type LogBroadcastCallback = (level: string, context: string, message: string, data?: object) => void;

class Logger {
    private level: LogLevel = 'info';
    private prefix: string;
    private static broadcastCallback: LogBroadcastCallback | null = null;
    private static logFilePath: string | null = null;
    private static logsDir: string = 'logs';
    private static initialized: boolean = false;

    constructor(prefix: string = 'BOT') {
        this.prefix = prefix;
    }

    /**
     * Initialize file logging - creates a new log file with timestamp
     * Call this once at bot startup
     */
    static initFileLogging(logsDir: string = 'logs'): string {
        Logger.logsDir = logsDir;

        // Ensure logs directory exists
        if (!existsSync(logsDir)) {
            mkdirSync(logsDir, { recursive: true });
        }

        // Create a unique log file name with timestamp
        const now = new Date();
        const timestamp = now.toISOString()
            .replace(/[:.]/g, '-')
            .replace('T', '_')
            .slice(0, 19); // YYYY-MM-DD_HH-MM-SS

        const logFileName = `bot_${timestamp}.log`;
        Logger.logFilePath = join(logsDir, logFileName);
        Logger.initialized = true;

        // Write header to log file
        const header = `\n${'='.repeat(60)}\nBot started at: ${now.toISOString()}\n${'='.repeat(60)}\n\n`;
        appendFileSync(Logger.logFilePath, header);

        console.log(`${COLORS.green}✓ Log file initialized: ${Logger.logFilePath}${COLORS.reset}`);
        return Logger.logFilePath;
    }

    /**
     * Get current log file path
     */
    static getLogFilePath(): string | null {
        return Logger.logFilePath;
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

    /**
     * Format message with colors for console output
     */
    private formatColoredMessage(level: LogLevel, message: string, data?: unknown): string {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        const prefix = this.prefix ? `[${this.prefix}]` : '';
        const levelColor = LEVEL_COLORS[levelStr.trim()] || COLORS.white;

        let formatted = `${COLORS.gray}${timestamp}${COLORS.reset} ${levelColor}${levelStr}${COLORS.reset} ${COLORS.blue}${prefix}${COLORS.reset} ${message}`;
        if (data !== undefined) {
            formatted += ` ${COLORS.dim}${JSON.stringify(data)}${COLORS.reset}`;
        }
        return formatted;
    }

    /**
     * Format message without colors for file output
     */
    private formatPlainMessage(level: LogLevel, message: string, data?: unknown): string {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        const prefix = this.prefix ? `[${this.prefix}]` : '';

        let formatted = `${timestamp} ${levelStr} ${prefix} ${message}`;
        if (data !== undefined) {
            formatted += ` ${JSON.stringify(data)}`;
        }
        return formatted;
    }

    /**
     * Write to log file
     */
    private writeToFile(message: string): void {
        if (Logger.logFilePath && Logger.initialized) {
            try {
                appendFileSync(Logger.logFilePath, message + '\n');
            } catch (error) {
                // Silently ignore file write errors to not disrupt logging
            }
        }
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
            console.log(this.formatColoredMessage('debug', message, data));
            this.writeToFile(this.formatPlainMessage('debug', message, data));
            this.broadcast('debug', message, data);
        }
    }

    info(message: string, data?: unknown): void {
        if (this.shouldLog('info')) {
            console.log(this.formatColoredMessage('info', message, data));
            this.writeToFile(this.formatPlainMessage('info', message, data));
            this.broadcast('info', message, data);
        }
    }

    warn(message: string, data?: unknown): void {
        if (this.shouldLog('warn')) {
            console.warn(this.formatColoredMessage('warn', message, data));
            this.writeToFile(this.formatPlainMessage('warn', message, data));
            this.broadcast('warn', message, data);
        }
    }

    error(message: string, data?: unknown): void {
        if (this.shouldLog('error')) {
            console.error(this.formatColoredMessage('error', message, data));
            this.writeToFile(this.formatPlainMessage('error', message, data));
            this.broadcast('error', message, data);
        }
    }

    trade(action: string, details: Record<string, unknown>): void {
        // Trade logs are always shown at info level
        if (this.shouldLog('info')) {
            const timestamp = new Date().toISOString();
            const coloredMsg = `${COLORS.gray}${timestamp}${COLORS.reset} ${LEVEL_COLORS.TRADE}TRADE${COLORS.reset} ${COLORS.blue}[${this.prefix}]${COLORS.reset} ${COLORS.green}${action}${COLORS.reset} ${COLORS.dim}${JSON.stringify(details)}${COLORS.reset}`;
            const plainMsg = `${timestamp} TRADE [${this.prefix}] ${action} ${JSON.stringify(details)}`;

            console.log(coloredMsg);
            this.writeToFile(plainMsg);
            this.broadcast('TRADE', action, details);
        }
    }

    /**
     * Log a success message (green colored)
     */
    success(message: string, data?: unknown): void {
        if (this.shouldLog('info')) {
            const timestamp = new Date().toISOString();
            const prefix = this.prefix ? `[${this.prefix}]` : '';

            let coloredMsg = `${COLORS.gray}${timestamp}${COLORS.reset} ${COLORS.bright}${COLORS.green}✓ OK ${COLORS.reset} ${COLORS.blue}${prefix}${COLORS.reset} ${COLORS.green}${message}${COLORS.reset}`;
            let plainMsg = `${timestamp} OK    ${prefix} ${message}`;

            if (data !== undefined) {
                coloredMsg += ` ${COLORS.dim}${JSON.stringify(data)}${COLORS.reset}`;
                plainMsg += ` ${JSON.stringify(data)}`;
            }

            console.log(coloredMsg);
            this.writeToFile(plainMsg);
            this.broadcast('info', message, data);
        }
    }

    /**
     * Log a separator line for visual clarity
     */
    separator(char: string = '─', length: number = 50): void {
        if (this.shouldLog('info')) {
            const line = char.repeat(length);
            console.log(`${COLORS.dim}${line}${COLORS.reset}`);
            this.writeToFile(line);
        }
    }

    /**
     * Log a header/banner message
     */
    banner(message: string): void {
        if (this.shouldLog('info')) {
            const border = '═'.repeat(message.length + 4);
            const coloredBanner = `\n${COLORS.cyan}╔${border}╗\n║  ${COLORS.bright}${message}${COLORS.reset}${COLORS.cyan}  ║\n╚${border}╝${COLORS.reset}`;
            const plainBanner = `\n╔${border}╗\n║  ${message}  ║\n╚${border}╝`;

            console.log(coloredBanner);
            this.writeToFile(plainBanner);
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
