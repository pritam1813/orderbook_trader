import { logger } from './utils/logger';
import { getConfig } from './config';
import { runBot } from './trading';

const log = logger;

async function main() {
    try {
        // Load and validate configuration
        const config = getConfig();

        // Set log level from config
        log.setLevel(config.logLevel);

        log.info('='.repeat(50));
        log.info('Binance Orderbook Scalping Bot');
        log.info('='.repeat(50));
        log.info('Configuration:', {
            symbol: config.symbol,
            quantity: config.quantity,
            leverage: config.leverage,
            direction: config.initialDirection,
            entryLevel: config.entryLevel,
            tpLevel: config.tpLevel,
            slLevel: config.slLevel,
            orderTimeoutSeconds: config.orderTimeoutSeconds,
            directionSwitchLosses: config.directionSwitchLosses,
            testnet: config.useTestnet,
        });
        log.info('='.repeat(50));

        if (!config.apiKey || !config.apiSecret) {
            log.error('API credentials not configured. Please set BINANCE_API_KEY and BINANCE_API_SECRET in .env');
            process.exit(1);
        }

        // Start the bot
        await runBot();

        log.info('Bot is running. Press Ctrl+C to stop.');

        // Keep the process running
        await new Promise(() => { }); // This will never resolve, keeps the process alive

    } catch (error) {
        log.error('Fatal error starting bot', { error });
        process.exit(1);
    }
}

main();
