import { getConfig } from '../config';
import { getRestClient } from '../api/rest';
import { OrderbookWebSocket } from '../api/websocket';
import { OrderbookManager } from '../services/orderbook';
import { logger } from '../utils/logger';
import { getBotState } from './state';

const log = logger.child('BOT');

/**
 * Simple, linear trading bot
 * Flow: Entry → Monitor → TP/SL → Monitor → Repeat
 */
export class TradingBot {
    private config = getConfig();
    private client = getRestClient();
    private orderbookManager: OrderbookManager;
    private orderbookWs: OrderbookWebSocket | null = null;
    private state = getBotState();

    // Symbol precision info
    private pricePrecision: number = 2;
    private quantityPrecision: number = 3;
    private tickSize: number = 0.01;

    private isRunning = false;

    // Direction and trade tracking
    private direction: 'LONG' | 'SHORT' = 'LONG';
    private consecutiveLosses: number = 0;
    private totalWins: number = 0;
    private totalLosses: number = 0;

    constructor() {
        this.orderbookManager = new OrderbookManager(this.config.symbol);
        this.direction = this.config.initialDirection;
    }


    /**
     * Initialize the bot
     */
    async initialize(): Promise<void> {
        log.info('=== INITIALIZING BOT ===');
        log.info('Config:', {
            symbol: this.config.symbol,
            quantity: this.config.quantity,
            leverage: this.config.leverage,
            testnet: this.config.useTestnet,
        });

        // Sync time
        await this.client.syncTime();
        log.info('Time synced with server');

        // Get symbol precision
        const exchangeInfo = await this.client.getExchangeInfo();
        const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === this.config.symbol);
        if (symbolInfo) {
            this.pricePrecision = symbolInfo.pricePrecision;
            this.quantityPrecision = symbolInfo.quantityPrecision;

            // Extract tick size from PRICE_FILTER
            for (const filter of symbolInfo.filters) {
                if (filter.filterType === 'PRICE_FILTER' && filter.tickSize) {
                    this.tickSize = parseFloat(filter.tickSize);
                    break;
                }
            }

            log.info('Symbol info loaded', { pricePrecision: this.pricePrecision, quantityPrecision: this.quantityPrecision, tickSize: this.tickSize });
        }

        // Set leverage
        await this.client.setLeverage(this.config.symbol, this.config.leverage);
        log.info('Leverage set:', this.config.leverage);

        // Get orderbook snapshot
        const snapshot = await this.client.getOrderbook(this.config.symbol, 20);
        this.orderbookManager.initFromSnapshot(snapshot.bids, snapshot.asks, snapshot.lastUpdateId);
        log.info('Orderbook initialized');

        // Connect to orderbook WebSocket
        this.orderbookWs = new OrderbookWebSocket(
            this.config.symbol,
            (update) => this.orderbookManager.update(update)
        );
        await this.orderbookWs.connect();
        log.info('Orderbook WebSocket connected');

        log.info('=== BOT INITIALIZED ===');
    }

    /**
     * Format price to symbol precision and tick size
     */
    private formatPrice(price: number): number {
        // Round to tick size
        const rounded = Math.round(price / this.tickSize) * this.tickSize;
        // Then round to precision to avoid floating point issues
        const factor = Math.pow(10, this.pricePrecision);
        return Math.round(rounded * factor) / factor;
    }

    /**
     * Format quantity to symbol precision
     */
    private formatQuantity(quantity: number): number {
        const factor = Math.pow(10, this.quantityPrecision);
        return Math.floor(quantity * factor) / factor;
    }

    /**
     * Sleep for specified milliseconds
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Main trading loop - runs forever
     */
    async run(): Promise<void> {
        this.isRunning = true;
        this.state.setRunning(true);
        this.state.setDirection(this.direction);
        log.info('=== STARTING TRADING LOOP ===');

        while (this.isRunning && this.state.isRunning) {
            try {
                await this.executeTradeCycle();
            } catch (error) {
                log.error('Error in trade cycle:', error);
                await this.sleep(5000);
            }
        }
        this.isRunning = false;
        this.state.setRunning(false);
        log.info('=== TRADING LOOP STOPPED ===');
    }

    /**
     * Execute one complete trade cycle
     */
    private async executeTradeCycle(): Promise<void> {
        log.info('');
        log.info('========== NEW TRADE CYCLE ==========');

        // Step 1: Place entry order
        const entryOrder = await this.placeEntryOrder();
        if (!entryOrder) {
            log.error('Failed to place entry order, retrying in 5s');
            await this.sleep(5000);
            return;
        }

        // Step 2: Monitor entry order
        const entryFilled = await this.monitorEntryOrder(entryOrder.orderId);
        if (!entryFilled) {
            log.info('Entry order not filled, starting new cycle');
            return;
        }

        // Step 3: Place TP and SL orders
        const { tpOrderId, slOrderId, tpPrice, slPrice } = await this.placeTpSlOrders(entryFilled.avgPrice, entryFilled.quantity);
        if (!tpOrderId) {
            log.error('Failed to place TP/SL, closing position');
            await this.closePosition();
            return;
        }

        // Track trade in dashboard state
        this.state.startTrade({
            entryTime: Date.now(),
            direction: this.direction,
            entryPrice: entryFilled.avgPrice,
            quantity: entryFilled.quantity,
            tpPrice,
            slPrice,
        });

        // Step 4: Monitor TP/SL orders
        await this.monitorTpSlOrders(tpOrderId, slOrderId, slPrice);

        log.info('========== TRADE CYCLE COMPLETE ==========');
        log.info('');
    }

    /**
     * Step 1: Place entry order
     */
    private async placeEntryOrder(): Promise<{ orderId: number; price: number } | null> {
        log.info('[STEP 1] Placing ENTRY order...', { direction: this.direction });

        const entryPrice = this.orderbookManager.getEntryPrice(this.direction, this.config.entryLevel);
        if (!entryPrice) {
            log.error('Could not get entry price from orderbook');
            return null;
        }

        const price = this.formatPrice(entryPrice);
        const quantity = this.formatQuantity(this.config.quantity);
        const side = this.direction === 'LONG' ? 'BUY' : 'SELL';

        log.info('[STEP 1] Entry order params:', { side, type: 'LIMIT', price, quantity });

        try {
            const order = await this.client.placeOrder({
                symbol: this.config.symbol,
                side,
                type: 'LIMIT',
                price,
                quantity,
                timeInForce: 'GTC',
            });

            log.info('[STEP 1] Entry order placed:', { orderId: order.orderId, status: order.status });
            return { orderId: order.orderId, price };
        } catch (error) {
            log.error('[STEP 1] Failed to place entry order:', error);
            return null;
        }
    }

    /**
     * Step 2: Monitor entry order until filled or timeout
     */
    private async monitorEntryOrder(orderId: number): Promise<{ avgPrice: number; quantity: number } | null> {
        log.info('[STEP 2] Monitoring ENTRY order:', orderId);

        const timeoutMs = this.config.orderTimeoutSeconds * 1000;
        const startTime = Date.now();
        const pollInterval = 1000; // Check every 1 second

        while (Date.now() - startTime < timeoutMs) {
            try {
                const order = await this.client.queryOrder(this.config.symbol, orderId);
                log.info('[STEP 2] Entry order status:', { orderId, status: order.status, elapsed: `${Math.round((Date.now() - startTime) / 1000)}s` });

                if (order.status === 'FILLED') {
                    const avgPrice = parseFloat(order.avgPrice);
                    const quantity = parseFloat(order.executedQty);
                    log.info('[STEP 2] ✅ Entry FILLED:', { avgPrice, quantity });
                    return { avgPrice, quantity };
                }

                if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
                    log.warn('[STEP 2] Entry order was canceled/expired');
                    return null;
                }

                await this.sleep(pollInterval);
            } catch (error) {
                log.error('[STEP 2] Error checking entry order:', error);
                await this.sleep(pollInterval);
            }
        }

        // Timeout - cancel the order
        log.warn('[STEP 2] Entry order TIMEOUT, canceling...');
        try {
            await this.client.cancelOrder(this.config.symbol, orderId);
            log.info('[STEP 2] Entry order canceled');
        } catch (error) {
            log.warn('[STEP 2] Could not cancel entry order:', error);
        }

        return null;
    }

    /**
     * Step 3: Place TP and SL orders
     */
    private async placeTpSlOrders(entryPrice: number, quantity: number): Promise<{ tpOrderId: number | null; slOrderId: number | null; tpPrice: number; slPrice: number }> {
        log.info('[STEP 3] Placing TP and SL orders...');
        log.info('[STEP 3] Entry details:', { entryPrice, quantity, direction: this.direction, strategy: this.config.strategy });

        // Exit side is opposite of entry
        const exitSide = this.direction === 'LONG' ? 'SELL' : 'BUY';

        let tpPrice: number;
        let slPrice: number;

        if (this.config.strategy === 'risk_reward') {
            // Risk-Reward Strategy: Calculate TP/SL based on entry price and ratio
            const slDistance = entryPrice * (this.config.slDistancePercent / 100);
            const tpDistance = slDistance * this.config.riskRewardRatio;

            if (this.direction === 'LONG') {
                tpPrice = entryPrice + tpDistance;
                slPrice = entryPrice - slDistance;
            } else {
                tpPrice = entryPrice - tpDistance;
                slPrice = entryPrice + slDistance;
            }

            log.info('[STEP 3] Risk-Reward calculation:', {
                slDistancePercent: this.config.slDistancePercent,
                riskRewardRatio: this.config.riskRewardRatio,
                slDistance: this.formatPrice(slDistance),
                tpDistance: this.formatPrice(tpDistance),
            });
        } else {
            // Orderbook Strategy: Get TP/SL from orderbook levels
            const orderbookTp = this.orderbookManager.getTakeProfitPrice(this.direction, this.config.tpLevel);
            if (!orderbookTp) {
                log.error('[STEP 3] Could not get TP price from orderbook');
                return { tpOrderId: null, slOrderId: null, tpPrice: 0, slPrice: 0 };
            }

            const orderbookSl = this.orderbookManager.getStopLossPrice(this.direction, this.config.slLevel);
            if (!orderbookSl) {
                log.error('[STEP 3] Could not get SL price from orderbook');
                return { tpOrderId: null, slOrderId: null, tpPrice: 0, slPrice: 0 };
            }

            tpPrice = orderbookTp;
            slPrice = orderbookSl;
        }

        const formattedTpPrice = this.formatPrice(tpPrice);
        const formattedSlPrice = this.formatPrice(slPrice);
        const formattedQuantity = this.formatQuantity(quantity);

        log.info('[STEP 3] Calculated prices:', { tpPrice: formattedTpPrice, slPrice: formattedSlPrice, exitSide });

        // Place TP order (LIMIT with reduceOnly)
        let tpOrderId: number | null = null;
        try {
            log.info('[STEP 3] Placing TP LIMIT order...');
            const tpOrder = await this.client.placeOrder({
                symbol: this.config.symbol,
                side: exitSide,
                type: 'LIMIT',
                price: formattedTpPrice,
                quantity: formattedQuantity,
                timeInForce: 'GTC',
                reduceOnly: true,
            });
            tpOrderId = tpOrder.orderId;
            log.info('[STEP 3] ✅ TP order placed:', { orderId: tpOrderId });
        } catch (error) {
            log.error('[STEP 3] Failed to place TP order:', error);
            return { tpOrderId: null, slOrderId: null, tpPrice: 0, slPrice: 0 };
        }

        // Place SL order (STOP_MARKET via algo API)
        let slOrderId: number | null = null;
        try {
            log.info('[STEP 3] Placing SL STOP_MARKET order via algo API...');
            const slOrder = await this.client.placeStopLossAlgoOrder({
                symbol: this.config.symbol,
                side: exitSide,
                triggerPrice: formattedSlPrice,
                stopPrice: formattedSlPrice,
            });
            slOrderId = slOrder.algoOrderId;
            log.info('[STEP 3] ✅ SL algo order placed:', { algoOrderId: slOrderId });
        } catch (error) {
            log.error('[STEP 3] Failed to place SL order:', error);
            // Cancel TP order since SL failed
            try {
                await this.client.cancelOrder(this.config.symbol, tpOrderId);
            } catch (e) {
                log.warn('[STEP 3] Could not cancel TP order:', e);
            }
            return { tpOrderId: null, slOrderId: null, tpPrice: 0, slPrice: 0 };
        }

        return { tpOrderId, slOrderId, tpPrice, slPrice };
    }

    /**
     * Step 4: Monitor TP/SL orders until one fills
     */
    private async monitorTpSlOrders(tpOrderId: number, slOrderId: number | null, slPrice: number): Promise<void> {
        log.info('[STEP 4] Monitoring TP/SL orders...');
        log.info('[STEP 4] Order IDs:', { tpOrderId, slAlgoId: slOrderId });

        const pollInterval = this.config.tpslMonitorIntervalSeconds * 1000;
        const maxWaitTime = 60 * 60 * 1000; // 1 hour max
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            try {
                // Check TP order status
                const tpOrder = await this.client.queryOrder(this.config.symbol, tpOrderId);
                log.info('[STEP 4] TP order status:', { orderId: tpOrderId, status: tpOrder.status, elapsed: `${Math.round((Date.now() - startTime) / 1000)}s` });

                if (tpOrder.status === 'FILLED') {
                    log.info('[STEP 4] ✅ TP FILLED - WIN!');
                    this.totalWins++;
                    this.consecutiveLosses = 0;

                    // Update dashboard state
                    const exitPrice = parseFloat(tpOrder.avgPrice || tpOrder.price || '0');
                    this.state.completeTrade(exitPrice, 'WIN');

                    log.info('[STEP 4] Stats:', { wins: this.totalWins, losses: this.totalLosses, consecutiveLosses: 0 });
                    log.debug('[STEP 4] SL order auto-expired (position closed)');
                    return;
                }

                if (tpOrder.status === 'CANCELED' || tpOrder.status === 'EXPIRED') {
                    log.info('[STEP 4] ❌ TP CANCELED - SL hit (LOSS)');
                    this.totalLosses++;
                    this.consecutiveLosses++;

                    // Update dashboard state - use SL price as exit
                    this.state.completeTrade(slPrice, 'LOSS');

                    log.info('[STEP 4] Stats:', { wins: this.totalWins, losses: this.totalLosses, consecutiveLosses: this.consecutiveLosses });

                    // Check if should switch direction
                    if (this.consecutiveLosses >= this.config.directionSwitchLosses) {
                        const oldDirection = this.direction;
                        this.direction = this.direction === 'LONG' ? 'SHORT' : 'LONG';
                        this.consecutiveLosses = 0;
                        this.state.setDirection(this.direction);
                        this.state.resetConsecutiveLosses();
                        log.info('[STEP 4] 🔄 SWITCHING DIRECTION:', { from: oldDirection, to: this.direction });
                    }
                    return;
                }

                await this.sleep(pollInterval);
            } catch (error) {
                log.error('[STEP 4] Error checking TP order:', error);
                await this.sleep(pollInterval);
            }
        }

        // Timeout - close position manually
        log.warn('[STEP 4] Monitoring TIMEOUT, closing position...');
        await this.closePosition();
    }

    /**
     * Emergency close position with market order
     */
    private async closePosition(): Promise<void> {
        log.warn('[CLOSE] Emergency closing position...');
        let side: 'BUY' | 'SELL' = this.direction === 'LONG' ? 'SELL' : 'BUY';
        try {
            await this.client.placeOrder({
                symbol: this.config.symbol,
                side,
                type: 'MARKET',
                quantity: this.formatQuantity(this.config.quantity),
                reduceOnly: true,
            });
            log.info('[CLOSE] Position closed');
        } catch (error) {
            log.error('[CLOSE] Failed to close position:', error);
        }
    }

    /**
     * Stop the bot
     */
    async stop(): Promise<void> {
        log.info('Stopping bot...');
        this.isRunning = false;
        this.orderbookWs?.close();
    }
}

/**
 * Create and run the bot
 */
export async function runBot(): Promise<TradingBot> {
    const bot = new TradingBot();

    process.on('SIGINT', async () => {
        await bot.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await bot.stop();
        process.exit(0);
    });

    await bot.initialize();

    // Run in background
    bot.run().catch(error => {
        log.error('Fatal error:', error);
        process.exit(1);
    });

    return bot;
}
