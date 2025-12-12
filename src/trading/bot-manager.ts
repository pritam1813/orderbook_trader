import { TradingBot } from './bot';
import { loadConfig } from '../config';
import { getBotState } from './state';
import { logger } from '../utils/logger';

const log = logger.child('BOT_MANAGER');

/**
 * Singleton bot manager that handles starting/stopping the trading bot
 * Allows restart with fresh config
 */
class BotManager {
    private currentBot: TradingBot | null = null;
    private isStarting: boolean = false;

    /**
     * Start the trading bot
     * If already running, returns false
     * Reloads config from .env before starting
     */
    async startBot(): Promise<{ success: boolean; message: string }> {
        const state = getBotState();

        // Prevent double-start
        if (state.isRunning || this.isStarting) {
            return { success: false, message: 'Bot is already running' };
        }

        try {
            this.isStarting = true;
            log.info('Starting bot...');

            // Reload config from .env to pick up any changes
            loadConfig();
            log.info('Config reloaded');

            // Create new bot instance
            this.currentBot = new TradingBot();

            // Initialize and start
            await this.currentBot.initialize();

            // Run in background (don't await)
            this.currentBot.run().catch(error => {
                log.error('Bot error:', error);
                state.setRunning(false);
            });

            this.isStarting = false;
            return { success: true, message: 'Bot started successfully' };

        } catch (error) {
            this.isStarting = false;
            log.error('Failed to start bot:', error);
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Failed to start bot'
            };
        }
    }

    /**
     * Stop the trading bot
     * Signals the bot to stop after current trade cycle completes
     */
    async stopBot(): Promise<{ success: boolean; message: string }> {
        const state = getBotState();

        if (!state.isRunning) {
            return { success: false, message: 'Bot is not running' };
        }

        try {
            log.info('Stopping bot...');

            if (this.currentBot) {
                await this.currentBot.stop();
            }

            // Also set state directly to ensure it stops
            state.setRunning(false);

            return {
                success: true,
                message: 'Bot stop signal sent. The bot will stop after current trade cycle completes.'
            };

        } catch (error) {
            log.error('Failed to stop bot:', error);
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Failed to stop bot'
            };
        }
    }

    /**
     * Get current bot instance
     */
    getBot(): TradingBot | null {
        return this.currentBot;
    }
}

// Singleton instance
let instance: BotManager | null = null;

export function getBotManager(): BotManager {
    if (!instance) {
        instance = new BotManager();
    }
    return instance;
}
