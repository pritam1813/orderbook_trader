import { logger, Logger } from './utils/logger';
import { getConfig } from './config';
import { getBotManager } from './trading/bot-manager';
import { startDashboard, broadcastLog } from './dashboard/server';

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
            strategy: config.strategy,
            entryLevel: config.entryLevel,
            tpLevel: config.tpLevel,
            slLevel: config.slLevel,
            riskRewardRatio: config.riskRewardRatio,
            slDistancePercent: config.slDistancePercent,
            orderTimeoutSeconds: config.orderTimeoutSeconds,
            directionSwitchLosses: config.directionSwitchLosses,
            testnet: config.useTestnet,
        });
        log.info('='.repeat(50));

        if (!config.apiKey || !config.apiSecret) {
            log.error('API credentials not configured. Please set BINANCE_API_KEY and BINANCE_API_SECRET in .env');
            process.exit(1);
        }

        // Start dashboard server
        const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
        startDashboard(dashboardPort);

        // Set up log broadcasting to dashboard
        Logger.setBroadcastCallback(broadcastLog);

        // Start the bot via bot manager
        const botManager = getBotManager();
        const startResult = await botManager.startBot();

        if (!startResult.success) {
            log.error('Failed to start bot:', startResult.message);
            process.exit(1);
        }

        log.info('Bot is running. Press Ctrl+C to stop.');

        // Keep the process running
        await new Promise(() => { }); // This will never resolve, keeps the process alive

    } catch (error) {
        log.error('Fatal error starting bot', { error });
        process.exit(1);
    }
}

main();

