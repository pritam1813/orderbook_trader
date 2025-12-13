import { getConfig, type Config } from '../config';
import { getRestClient, BinanceRestClient } from '../api/rest';
import { getBotState } from './state';
import { logger } from '../utils/logger';
import type { OrderResponse, OrderSide } from '../types';

const log = logger.child('MICRO_GRID');

/**
 * Micro-Grid / Market Making Strategy
 * 
 * Places simultaneous buy/sell limit orders around current price to capture spread.
 * Uses GTX (Good Till Crossing) orders to ensure maker-only execution.
 */
export class MicroGridStrategy {
    private config: Config;
    private rest: BinanceRestClient;
    private state: ReturnType<typeof getBotState>;

    private isRunning: boolean = false;
    private symbol: string;
    private quantity: number;
    private spreadGapPercent: number;
    private priceRangePercent: number;

    // Symbol precision
    private pricePrecision: number = 2;
    private quantityPrecision: number = 3;
    private tickSize: number = 0.01;

    // Active orders
    private activeBuyOrderId: number | null = null;
    private activeSellOrderId: number | null = null;
    private lastFillPrice: number = 0;

    // Trade tracking for P&L
    private lastEntrySide: 'BUY' | 'SELL' | null = null;
    private lastEntryPrice: number = 0;
    private lastEntryQty: number = 0;

    // Price range bounds
    private initialPrice: number = 0;
    private isPaused: boolean = false;

    // Stats
    private tradesCompleted: number = 0;

    // === CRITICAL SAFETY FEATURES ===
    // Position limits
    private maxPositionSize: number;
    private makerFeeRate: number;

    // Daily P&L tracking
    private dailyPnL: number = 0;
    private dailyStartBalance: number = 0;
    private dailyLossLimit: number;
    private tradingDay: string = '';

    // Circuit breaker
    private consecutiveLosses: number = 0;
    private maxConsecutiveLosses: number = 5;
    private isCircuitBroken: boolean = false;

    constructor() {
        this.config = getConfig();
        this.rest = getRestClient();
        this.state = getBotState();

        this.symbol = this.config.symbol;
        this.quantity = this.config.quantity;
        this.spreadGapPercent = this.config.spreadGapPercent / 100; // Convert to decimal
        this.priceRangePercent = this.config.priceRangePercent / 100; // Convert to decimal

        // Initialize safety parameters
        this.maxPositionSize = this.quantity * this.config.maxPositionMultiplier;
        this.dailyLossLimit = this.config.dailyLossLimitPercent / 100; // Convert to decimal
        this.makerFeeRate = this.config.makerFeePercent / 100; // Convert to decimal

        log.info('MicroGridStrategy initialized', {
            symbol: this.symbol,
            quantity: this.quantity,
            spreadGapPercent: `${this.config.spreadGapPercent}%`,
            priceRangePercent: `±${this.config.priceRangePercent}%`,
            maxPositionSize: this.maxPositionSize,
            dailyLossLimit: `${this.config.dailyLossLimitPercent}%`,
            makerFeePercent: `${this.config.makerFeePercent}%`,
        });
    }

    /**
     * Initialize strategy - load symbol info and set leverage
     */
    async initialize(): Promise<void> {
        log.info('Initializing MicroGridStrategy...');

        await this.rest.syncTime();

        // Get symbol info for precision
        const exchangeInfo = await this.rest.getExchangeInfo();
        const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === this.symbol);

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

            log.info('Symbol info loaded', {
                pricePrecision: this.pricePrecision,
                quantityPrecision: this.quantityPrecision,
                tickSize: this.tickSize,
            });
        }

        // Set leverage
        await this.rest.setLeverage(this.symbol, this.config.leverage);

        // Cancel any existing open orders
        await this.cancelAllOrders();

        log.info('MicroGridStrategy initialization complete');
    }

    /**
     * Format price to symbol precision and tick size
     */
    private formatPrice(price: number): number {
        const rounded = Math.round(price / this.tickSize) * this.tickSize;
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
     * Get current orderbook prices
     */
    private async getOrderbookPrices(): Promise<{ bid: number; ask: number; mid: number }> {
        const orderbook = await this.rest.getOrderbook(this.symbol, 5);
        const bid = parseFloat(orderbook.bids[0]?.[0] ?? '0');
        const ask = parseFloat(orderbook.asks[0]?.[0] ?? '0');
        return { bid, ask, mid: (bid + ask) / 2 };
    }

    /**
     * Get current market price from orderbook
     */
    private async getCurrentPrice(): Promise<number> {
        const prices = await this.getOrderbookPrices();
        return prices.mid;
    }

    /**
     * Cancel all open orders for this symbol
     */
    private async cancelAllOrders(): Promise<void> {
        try {
            await this.rest.cancelAllOrders(this.symbol);
            this.activeBuyOrderId = null;
            this.activeSellOrderId = null;
            log.info('All orders cancelled');
        } catch (error) {
            // Ignore if no orders to cancel
        }
    }

    /**
     * Check if current price is within the allowed range from initial price
     */
    private isPriceInRange(currentPrice: number): boolean {
        if (this.initialPrice === 0) return true; // Not set yet

        const lowerBound = this.initialPrice * (1 - this.priceRangePercent);
        const upperBound = this.initialPrice * (1 + this.priceRangePercent);

        return currentPrice >= lowerBound && currentPrice <= upperBound;
    }

    /**
     * Get current position size from exchange
     */
    private async getCurrentPositionSize(): Promise<number> {
        try {
            const position = await this.rest.getPositionRisk(this.symbol);
            if (position) {
                return Math.abs(parseFloat(position.positionAmt));
            }
        } catch (error) {
            log.error('Error getting position size:', error);
        }
        return 0;
    }

    /**
     * Check if we can open a new position (within limits)
     */
    private async canOpenPosition(): Promise<boolean> {
        const currentSize = await this.getCurrentPositionSize();
        const canOpen = currentSize < this.maxPositionSize;

        if (!canOpen) {
            log.warn('Position limit reached', {
                currentSize,
                maxSize: this.maxPositionSize,
            });
        }

        return canOpen;
    }

    /**
     * Calculate net P&L including fees (fee-aware profit calculation)
     */
    private calculateNetPnL(entryPrice: number, exitPrice: number, quantity: number, direction: 'LONG' | 'SHORT'): {
        grossPnL: number;
        fees: number;
        netPnL: number;
        isProfit: boolean;
    } {
        // Calculate gross P&L
        let grossPnL: number;
        if (direction === 'LONG') {
            grossPnL = (exitPrice - entryPrice) * quantity;
        } else {
            grossPnL = (entryPrice - exitPrice) * quantity;
        }

        // Calculate fees (maker fee on both entry and exit)
        const entryNotional = entryPrice * quantity;
        const exitNotional = exitPrice * quantity;
        const fees = (entryNotional + exitNotional) * this.makerFeeRate;

        // Net P&L after fees
        const netPnL = grossPnL - fees;

        return {
            grossPnL,
            fees,
            netPnL,
            isProfit: netPnL > 0,
        };
    }

    /**
     * Check and reset daily P&L tracking if new trading day
     */
    private checkDailyReset(): void {
        const today = new Date().toISOString().split('T')[0] ?? '';
        if (this.tradingDay !== today) {
            log.info('New trading day, resetting daily P&L', {
                previousDay: this.tradingDay,
                previousPnL: this.dailyPnL,
                newDay: today
            });
            this.tradingDay = today;
            this.dailyPnL = 0;
            this.consecutiveLosses = 0;
            this.isCircuitBroken = false;
        }
    }

    /**
     * Check if circuit breaker should be triggered
     */
    private checkCircuitBreaker(): boolean {
        // Check daily loss limit
        const estimatedBalance = this.dailyStartBalance > 0 ? this.dailyStartBalance : 1000; // Fallback
        const lossPercent = Math.abs(this.dailyPnL) / estimatedBalance;

        if (this.dailyPnL < 0 && lossPercent >= this.dailyLossLimit) {
            log.error('CIRCUIT BREAKER: Daily loss limit reached!', {
                dailyPnL: this.dailyPnL,
                lossPercent: `${(lossPercent * 100).toFixed(2)}%`,
                limit: `${(this.dailyLossLimit * 100).toFixed(2)}%`,
            });
            this.isCircuitBroken = true;
            return true;
        }

        // Check consecutive losses
        if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
            log.error('CIRCUIT BREAKER: Max consecutive losses reached!', {
                consecutiveLosses: this.consecutiveLosses,
                maxAllowed: this.maxConsecutiveLosses,
            });
            this.isCircuitBroken = true;
            return true;
        }

        return false;
    }

    /**
     * Close any open position (used when out of range or circuit breaker)
     */
    private async closePosition(): Promise<void> {
        try {
            // Cancel all open orders first
            await this.cancelAllOrders();

            // Get actual position from exchange
            const position = await this.rest.getPositionRisk(this.symbol);
            if (!position) {
                log.info('No position data available');
                return;
            }

            const positionAmt = parseFloat(position.positionAmt);
            if (positionAmt === 0) {
                log.info('No position to close');
                return;
            }

            const quantity = this.formatQuantity(Math.abs(positionAmt));

            if (positionAmt > 0) {
                // LONG position - close with SELL
                await this.rest.placeOrder({
                    symbol: this.symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    quantity,
                    reduceOnly: true,
                });
                log.info('Closed LONG position', { quantity, entryPrice: position.entryPrice });
            } else {
                // SHORT position - close with BUY
                await this.rest.placeOrder({
                    symbol: this.symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    quantity,
                    reduceOnly: true,
                });
                log.info('Closed SHORT position', { quantity, entryPrice: position.entryPrice });
            }

            // Reset entry tracking
            this.lastEntrySide = null;
            this.lastEntryPrice = 0;
            this.lastEntryQty = 0;
        } catch (error) {
            log.error('Error closing position:', error);
        }
    }

    /**
     * Place a GTX (maker-only) limit order
     */
    private async placeGTXOrder(
        side: OrderSide,
        price: number,
        quantity: number
    ): Promise<OrderResponse | null> {
        try {
            const formattedPrice = this.formatPrice(price);
            const formattedQuantity = this.formatQuantity(quantity);

            log.info(`Placing GTX ${side} order`, { price: formattedPrice, quantity: formattedQuantity });

            const order = await this.rest.placeOrder({
                symbol: this.symbol,
                side,
                type: 'LIMIT',
                price: formattedPrice,
                quantity: formattedQuantity,
                timeInForce: 'GTX', // Maker-only
            });

            log.info(`GTX ${side} order placed`, { orderId: order.orderId, status: order.status });
            return order;

        } catch (error) {
            log.error(`Failed to place GTX ${side} order:`, error);
            return null;
        }
    }

    /**
     * Place initial bracket orders (buy below bid + sell above ask)
     */
    private async placeInitialBracket(): Promise<boolean> {
        const prices = await this.getOrderbookPrices();
        log.info('Placing initial bracket orders', { bid: prices.bid, ask: prices.ask });

        const buyPrice = prices.bid * (1 - this.spreadGapPercent);
        const sellPrice = prices.ask * (1 + this.spreadGapPercent);

        // Place buy order below best bid
        const buyOrder = await this.placeGTXOrder('BUY', buyPrice, this.quantity);
        if (buyOrder && buyOrder.status !== 'EXPIRED') {
            this.activeBuyOrderId = buyOrder.orderId;
        } else {
            log.warn('Buy order rejected or failed');
        }

        // Place sell order above best ask
        const sellOrder = await this.placeGTXOrder('SELL', sellPrice, this.quantity);
        if (sellOrder && sellOrder.status !== 'EXPIRED') {
            this.activeSellOrderId = sellOrder.orderId;
        } else {
            log.warn('Sell order rejected or failed');
        }

        log.info('Bracket placed', {
            buyOrderId: this.activeBuyOrderId,
            sellOrderId: this.activeSellOrderId,
            buyPrice: this.formatPrice(buyPrice),
            sellPrice: this.formatPrice(sellPrice),
        });

        return this.activeBuyOrderId !== null || this.activeSellOrderId !== null;
    }

    /**
     * Check order status and handle fills
     */
    private async checkOrdersAndHandleFills(): Promise<void> {
        // Check buy order
        if (this.activeBuyOrderId) {
            try {
                const order = await this.rest.queryOrder(this.symbol, this.activeBuyOrderId);

                if (order.status === 'FILLED') {
                    const fillPrice = parseFloat(order.avgPrice);
                    const fillQty = parseFloat(order.executedQty);
                    log.info(`BUY order FILLED @ ${fillPrice}`);
                    this.lastFillPrice = fillPrice;
                    this.tradesCompleted++;

                    await this.handleBuyFill(fillPrice, fillQty);
                } else if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
                    log.info(`Buy order ${order.status}, will replace`);
                    this.activeBuyOrderId = null;
                }
            } catch (error) {
                log.error('Error checking buy order:', error);
            }
        }

        // Check sell order
        if (this.activeSellOrderId) {
            try {
                const order = await this.rest.queryOrder(this.symbol, this.activeSellOrderId);

                if (order.status === 'FILLED') {
                    const fillPrice = parseFloat(order.avgPrice);
                    const fillQty = parseFloat(order.executedQty);
                    log.info(`SELL order FILLED @ ${fillPrice}`);
                    this.lastFillPrice = fillPrice;
                    this.tradesCompleted++;

                    await this.handleSellFill(fillPrice, fillQty);
                } else if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
                    log.info(`Sell order ${order.status}, will replace`);
                    this.activeSellOrderId = null;
                }
            } catch (error) {
                log.error('Error checking sell order:', error);
            }
        }
    }

    /**
     * Handle buy order fill - complete SHORT trade (if any) + place new bracket
     */
    private async handleBuyFill(fillPrice: number, qty: number): Promise<void> {
        // If we had a previous SHORT entry (sell), this buy completes the trade
        if (this.lastEntrySide === 'SELL' && this.lastEntryPrice > 0) {
            // Calculate fee-aware P&L
            const pnl = this.calculateNetPnL(
                this.lastEntryPrice,
                fillPrice,
                this.lastEntryQty,
                'SHORT'
            );

            // Update daily P&L tracking
            this.dailyPnL += pnl.netPnL;

            // Update consecutive losses tracking
            if (pnl.isProfit) {
                this.consecutiveLosses = 0;
            } else {
                this.consecutiveLosses++;
            }

            const result = pnl.isProfit ? 'WIN' : 'LOSS';

            // Start and immediately complete the trade
            this.state.startTrade({
                entryTime: Date.now() - 1000, // Slightly in past
                direction: 'SHORT',
                entryPrice: this.lastEntryPrice,
                quantity: this.lastEntryQty,
                tpPrice: this.lastEntryPrice * (1 - this.spreadGapPercent),
                slPrice: this.lastEntryPrice * (1 + this.spreadGapPercent * 2),
            });
            this.state.completeTrade(fillPrice, result);

            log.info(`SHORT trade completed`, {
                entry: this.lastEntryPrice,
                exit: fillPrice,
                result,
                grossPnL: pnl.grossPnL.toFixed(4),
                fees: pnl.fees.toFixed(4),
                netPnL: pnl.netPnL.toFixed(4),
                dailyPnL: this.dailyPnL.toFixed(4),
                consecutiveLosses: this.consecutiveLosses,
            });
        }

        // Record this buy as new entry for next trade
        this.lastEntrySide = 'BUY';
        this.lastEntryPrice = fillPrice;
        this.lastEntryQty = qty;

        // Cancel old sell order
        if (this.activeSellOrderId) {
            try {
                await this.rest.cancelOrder(this.symbol, this.activeSellOrderId);
            } catch {
                // Ignore if already cancelled
            }
            this.activeSellOrderId = null;
        }

        // Get fresh orderbook prices for placement
        const prices = await this.getOrderbookPrices();

        // Place sell order above best ask (to ensure maker)
        const newSellPrice = prices.ask * (1 + this.spreadGapPercent);
        const sellOrder = await this.placeGTXOrder('SELL', newSellPrice, this.quantity);
        if (sellOrder && sellOrder.status !== 'EXPIRED') {
            this.activeSellOrderId = sellOrder.orderId;
        }

        // Place new buy order below best bid (refill)
        const newBuyPrice = prices.bid * (1 - this.spreadGapPercent);
        const buyOrder = await this.placeGTXOrder('BUY', newBuyPrice, this.quantity);
        if (buyOrder && buyOrder.status !== 'EXPIRED') {
            this.activeBuyOrderId = buyOrder.orderId;
        }

        log.info('New bracket after BUY fill', {
            newSellPrice: this.formatPrice(newSellPrice),
            newBuyPrice: this.formatPrice(newBuyPrice),
        });
    }

    /**
     * Handle sell order fill - complete LONG trade (if any) + place new bracket
     */
    private async handleSellFill(fillPrice: number, qty: number): Promise<void> {
        // If we had a previous LONG entry (buy), this sell completes the trade
        if (this.lastEntrySide === 'BUY' && this.lastEntryPrice > 0) {
            // Calculate fee-aware P&L
            const pnl = this.calculateNetPnL(
                this.lastEntryPrice,
                fillPrice,
                this.lastEntryQty,
                'LONG'
            );

            // Update daily P&L tracking
            this.dailyPnL += pnl.netPnL;

            // Update consecutive losses tracking
            if (pnl.isProfit) {
                this.consecutiveLosses = 0;
            } else {
                this.consecutiveLosses++;
            }

            const result = pnl.isProfit ? 'WIN' : 'LOSS';

            // Start and immediately complete the trade
            this.state.startTrade({
                entryTime: Date.now() - 1000, // Slightly in past
                direction: 'LONG',
                entryPrice: this.lastEntryPrice,
                quantity: this.lastEntryQty,
                tpPrice: this.lastEntryPrice * (1 + this.spreadGapPercent),
                slPrice: this.lastEntryPrice * (1 - this.spreadGapPercent * 2),
            });
            this.state.completeTrade(fillPrice, result);

            log.info(`LONG trade completed`, {
                entry: this.lastEntryPrice,
                exit: fillPrice,
                result,
                grossPnL: pnl.grossPnL.toFixed(4),
                fees: pnl.fees.toFixed(4),
                netPnL: pnl.netPnL.toFixed(4),
                dailyPnL: this.dailyPnL.toFixed(4),
                consecutiveLosses: this.consecutiveLosses,
            });
        }

        // Record this sell as new entry for next trade
        this.lastEntrySide = 'SELL';
        this.lastEntryPrice = fillPrice;
        this.lastEntryQty = qty;

        // Cancel old buy order
        if (this.activeBuyOrderId) {
            try {
                await this.rest.cancelOrder(this.symbol, this.activeBuyOrderId);
            } catch {
                // Ignore if already cancelled
            }
            this.activeBuyOrderId = null;
        }

        // Get fresh orderbook prices for placement
        const prices = await this.getOrderbookPrices();

        // Place buy order below best bid (to ensure maker)
        const newBuyPrice = prices.bid * (1 - this.spreadGapPercent);
        const buyOrder = await this.placeGTXOrder('BUY', newBuyPrice, this.quantity);
        if (buyOrder && buyOrder.status !== 'EXPIRED') {
            this.activeBuyOrderId = buyOrder.orderId;
        }

        // Place new sell order above best ask (refill)
        const newSellPrice = prices.ask * (1 + this.spreadGapPercent);
        const sellOrder = await this.placeGTXOrder('SELL', newSellPrice, this.quantity);
        if (sellOrder && sellOrder.status !== 'EXPIRED') {
            this.activeSellOrderId = sellOrder.orderId;
        }

        log.info('New bracket after SELL fill', {
            newBuyPrice: this.formatPrice(newBuyPrice),
            newSellPrice: this.formatPrice(newSellPrice),
        });
    }

    /**
     * Ensure bracket orders exist - replace missing ones
     */
    private async ensureBracketExists(): Promise<void> {
        const prices = await this.getOrderbookPrices();

        // If no buy order, place one below best bid
        if (!this.activeBuyOrderId) {
            const buyPrice = prices.bid * (1 - this.spreadGapPercent);
            const buyOrder = await this.placeGTXOrder('BUY', buyPrice, this.quantity);
            if (buyOrder && buyOrder.status !== 'EXPIRED') {
                this.activeBuyOrderId = buyOrder.orderId;
            }
        }

        // If no sell order, place one above best ask
        if (!this.activeSellOrderId) {
            const sellPrice = prices.ask * (1 + this.spreadGapPercent);
            const sellOrder = await this.placeGTXOrder('SELL', sellPrice, this.quantity);
            if (sellOrder && sellOrder.status !== 'EXPIRED') {
                this.activeSellOrderId = sellOrder.orderId;
            }
        }
    }

    /**
     * Main run loop
     */
    async run(): Promise<void> {
        this.isRunning = true;
        this.state.setRunning(true);
        this.state.setDirection('LONG'); // Neutral for market making

        log.info('=== STARTING MICRO-GRID STRATEGY ===');
        log.info(`Spread gap: ${this.config.spreadGapPercent}%, Price range: ±${this.config.priceRangePercent}%`);
        log.info(`Safety: Max position ${this.maxPositionSize}, Daily loss limit ${this.config.dailyLossLimitPercent}%, Maker fee ${this.config.makerFeePercent}%`);

        try {
            // Initialize daily tracking
            this.checkDailyReset();

            // Record initial price for range checking
            this.initialPrice = await this.getCurrentPrice();
            log.info(`Initial price: ${this.initialPrice}, Range: ${this.formatPrice(this.initialPrice * (1 - this.priceRangePercent))} - ${this.formatPrice(this.initialPrice * (1 + this.priceRangePercent))}`);

            // Place first bracket orders
            await this.placeInitialBracket();

            // Main polling loop (check orders every 2 seconds)
            while (this.isRunning && this.state.isRunning) {
                try {
                    // Check for new trading day
                    this.checkDailyReset();

                    // Check circuit breaker
                    if (this.checkCircuitBreaker()) {
                        log.error('Circuit breaker triggered! Closing positions and stopping...');
                        await this.closePosition();

                        // Wait longer while circuit breaker is active
                        await this.sleep(60000); // 1 minute
                        continue;
                    }

                    const currentPrice = await this.getCurrentPrice();

                    // Check if price is within allowed range
                    if (!this.isPriceInRange(currentPrice)) {
                        if (!this.isPaused) {
                            log.warn(`PRICE OUT OF RANGE! Current: ${currentPrice}, Initial: ${this.initialPrice}`);
                            log.warn('Pausing strategy, cancelling orders, closing position...');
                            this.isPaused = true;
                            await this.closePosition();
                        }

                        // Wait longer while paused
                        await this.sleep(5000);
                        continue;
                    }

                    // If we were paused and price is back in range, resume
                    if (this.isPaused) {
                        log.info('Price back in range, resuming trading...');
                        this.isPaused = false;
                        await this.placeInitialBracket();
                    }

                    // Check for fills and handle them
                    await this.checkOrdersAndHandleFills();

                    // Check position limits before ensuring bracket exists
                    const canOpenNew = await this.canOpenPosition();
                    if (canOpenNew) {
                        // Ensure we always have bracket orders
                        await this.ensureBracketExists();
                    } else {
                        // Position limit reached - only allow closing orders
                        log.warn('Position limit reached, not placing new orders until position reduced');
                    }

                    // Log status periodically (every 5 completed trades)
                    if (this.tradesCompleted > 0 && this.tradesCompleted % 5 === 0) {
                        const currentPositionSize = await this.getCurrentPositionSize();
                        log.info('Micro-grid stats', {
                            tradesCompleted: this.tradesCompleted,
                            dailyPnL: this.dailyPnL.toFixed(4),
                            consecutiveLosses: this.consecutiveLosses,
                            currentPositionSize,
                            maxPositionSize: this.maxPositionSize,
                            activeBuyOrderId: this.activeBuyOrderId,
                            activeSellOrderId: this.activeSellOrderId,
                        });
                    }

                    // Wait before next check
                    await this.sleep(2000);

                } catch (error) {
                    log.error('Error in micro-grid loop:', error);
                    await this.sleep(5000);
                }
            }
        } catch (error) {
            log.error('Fatal error in micro-grid strategy:', error);
        }

        // Cleanup on stop
        await this.stop();
    }

    /**
     * Stop the strategy and cancel all orders
     */
    async stop(): Promise<void> {
        log.info('Stopping MicroGridStrategy...');
        this.isRunning = false;

        // Cancel all open orders
        await this.cancelAllOrders();

        this.state.setRunning(false);
        log.info('=== MICRO-GRID STRATEGY STOPPED ===');
        log.info('Final stats', { tradesCompleted: this.tradesCompleted });
    }
}
