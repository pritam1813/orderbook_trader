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
    private takerFeeRate: number;

    // Daily P&L tracking
    private dailyPnL: number = 0;
    private dailyStartBalance: number = 0;
    private dailyLossLimit: number;
    private tradingDay: string = '';

    // Circuit breaker
    private consecutiveLosses: number = 0;
    private maxConsecutiveLosses: number = 5;
    private isCircuitBroken: boolean = false;

    // === DYNAMIC SPREAD ===
    private priceHistory: { price: number; timestamp: number }[] = [];
    private minSpread: number;
    private maxSpread: number;
    private volatilityLookbackMs: number;
    private currentSpread: number;

    // === ROLLING PRICE RANGE ===
    private tradesSinceRangeUpdate: number = 0;
    private rollingPriceUpdateTrades: number;

    // === POSITION REDUCTION ===
    private isReducingPosition: boolean = false;
    private reductionStartPrice: number = 0;
    private reductionStartPositionSize: number = 0;
    private reduceOnlyOrderId: number | null = null;
    private reduceOnlyOrderPlacedAt: number = 0;
    private reduceOnlyOrderSide: 'BUY' | 'SELL' | null = null;
    private isWaitingForStabilization: boolean = false;
    private stabilizationStartTime: number = 0;

    // Position reduction config (initialized in constructor)
    private emergencyCloseDeviation: number;
    private stabilizationWaitMs: number;
    private reduceOrderTimeoutMs: number;
    private positionResumeThreshold: number;

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
        this.takerFeeRate = this.config.takerFeePercent / 100; // Convert to decimal (for market orders)

        // Initialize dynamic spread parameters
        this.minSpread = this.config.minSpreadPercent / 100;
        this.maxSpread = this.config.maxSpreadPercent / 100;
        this.volatilityLookbackMs = this.config.volatilityLookbackMinutes * 60 * 1000;
        this.currentSpread = this.spreadGapPercent; // Start with base spread

        // Initialize rolling price range
        this.rollingPriceUpdateTrades = this.config.rollingPriceUpdateTrades;

        // Initialize position reduction config
        this.emergencyCloseDeviation = this.config.emergencyCloseDeviationPercent / 100;
        this.stabilizationWaitMs = this.config.stabilizationWaitMinutes * 60 * 1000;
        this.reduceOrderTimeoutMs = this.config.reduceOrderTimeoutSeconds * 1000;
        this.positionResumeThreshold = this.config.positionResumeThresholdPercent / 100;

        log.info('MicroGridStrategy initialized', {
            symbol: this.symbol,
            quantity: this.quantity,
            baseSpread: `${this.config.spreadGapPercent}%`,
            dynamicSpreadRange: `${this.config.minSpreadPercent}% - ${this.config.maxSpreadPercent}%`,
            priceRangePercent: `±${this.config.priceRangePercent}%`,
            maxPositionSize: this.maxPositionSize,
            emergencyCloseDeviation: `${this.config.emergencyCloseDeviationPercent}%`,
            stabilizationWait: `${this.config.stabilizationWaitMinutes} min`,
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
     * Add a price observation for volatility calculation
     */
    private addPriceObservation(price: number): void {
        const now = Date.now();
        this.priceHistory.push({ price, timestamp: now });

        // Remove old observations outside the lookback window
        const cutoff = now - this.volatilityLookbackMs;
        this.priceHistory = this.priceHistory.filter(p => p.timestamp >= cutoff);
    }

    /**
     * Calculate volatility based on recent price movements (standard deviation / mean)
     */
    private calculateVolatility(): number {
        if (this.priceHistory.length < 2) {
            return 0;
        }

        const prices = this.priceHistory.map(p => p.price);
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;

        if (mean === 0) return 0;

        const squaredDiffs = prices.map(p => Math.pow(p - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / prices.length;
        const stdDev = Math.sqrt(variance);

        // Return coefficient of variation (volatility as percentage of mean)
        return stdDev / mean;
    }

    /**
     * Update the dynamic spread based on current volatility
     */
    private updateDynamicSpread(currentPrice: number): void {
        // Add current price to history
        this.addPriceObservation(currentPrice);

        // Calculate volatility
        const volatility = this.calculateVolatility();

        if (volatility === 0) {
            // Not enough data yet, use base spread
            this.currentSpread = this.spreadGapPercent;
            return;
        }

        // Scale spread based on volatility
        // Higher volatility = wider spread to account for faster price movement
        // Volatility multiplier: spread = baseSpread + (volatility * 10)
        // The 10x multiplier converts small volatility values to meaningful spread adjustments
        const volatilityAdjustedSpread = this.spreadGapPercent + (volatility * 10);

        // Clamp to min/max bounds
        this.currentSpread = Math.max(
            this.minSpread,
            Math.min(this.maxSpread, volatilityAdjustedSpread)
        );

        log.debug('Dynamic spread updated', {
            volatility: (volatility * 100).toFixed(4) + '%',
            baseSpread: (this.spreadGapPercent * 100).toFixed(4) + '%',
            currentSpread: (this.currentSpread * 100).toFixed(4) + '%',
        });
    }

    /**
     * Update the rolling price range (reset initial price after N successful trades)
     */
    private async updateRollingPriceRange(): Promise<void> {
        this.tradesSinceRangeUpdate++;

        if (this.tradesSinceRangeUpdate >= this.rollingPriceUpdateTrades) {
            const newInitialPrice = await this.getCurrentPrice();
            const oldInitialPrice = this.initialPrice;

            this.initialPrice = newInitialPrice;
            this.tradesSinceRangeUpdate = 0;

            log.info('Rolling price range updated', {
                oldInitialPrice,
                newInitialPrice,
                newLowerBound: this.formatPrice(newInitialPrice * (1 - this.priceRangePercent)),
                newUpperBound: this.formatPrice(newInitialPrice * (1 + this.priceRangePercent)),
            });
        }
    }

    /**
     * Get the current spread (dynamic or base)
     */
    private getSpread(): number {
        return this.currentSpread;
    }

    // ==========================================
    // === POSITION REDUCTION METHODS ===
    // ==========================================

    /**
     * Get current position direction (LONG/SHORT) and size
     */
    private async getPositionInfo(): Promise<{ side: 'LONG' | 'SHORT' | 'NONE'; size: number; entryPrice: number }> {
        try {
            const position = await this.rest.getPositionRisk(this.symbol);
            if (position) {
                const posAmt = parseFloat(position.positionAmt);
                if (posAmt > 0) {
                    return { side: 'LONG', size: posAmt, entryPrice: parseFloat(position.entryPrice) };
                } else if (posAmt < 0) {
                    return { side: 'SHORT', size: Math.abs(posAmt), entryPrice: parseFloat(position.entryPrice) };
                }
            }
        } catch (error) {
            log.error('Error getting position info:', error);
        }
        return { side: 'NONE', size: 0, entryPrice: 0 };
    }

    /**
     * Enter position reduction mode - cancel all orders and start reducing
     */
    private async startPositionReduction(): Promise<void> {
        if (this.isReducingPosition) return;

        const posInfo = await this.getPositionInfo();
        if (posInfo.side === 'NONE' || posInfo.size === 0) {
            log.info('No position to reduce');
            return;
        }

        log.warn('=== ENTERING POSITION REDUCTION MODE ===', {
            positionSide: posInfo.side,
            positionSize: posInfo.size,
            entryPrice: posInfo.entryPrice,
        });

        // Cancel ALL open orders first
        await this.cancelAllOrders();

        // Record reduction start state
        this.isReducingPosition = true;
        this.reductionStartPrice = await this.getCurrentPrice();
        this.reductionStartPositionSize = posInfo.size;
        this.reduceOnlyOrderSide = posInfo.side === 'LONG' ? 'SELL' : 'BUY';

        log.info('Position reduction started', {
            reductionStartPrice: this.reductionStartPrice,
            reductionStartPositionSize: this.reductionStartPositionSize,
            reduceOnlyOrderSide: this.reduceOnlyOrderSide,
        });

        // Place first reduce-only order
        await this.placeReduceOnlyOrder();
    }

    /**
     * Place a reduce-only LIMIT order for one chunk (base quantity)
     */
    private async placeReduceOnlyOrder(): Promise<void> {
        const prices = await this.getOrderbookPrices();

        // Determine price based on side - we want to close at market
        // For LONG position (SELL to close): place at bid price (to get filled quickly but as maker)
        // For SHORT position (BUY to close): place at ask price
        let price: number;
        if (this.reduceOnlyOrderSide === 'SELL') {
            price = prices.bid; // Sell at bid for faster fill
        } else {
            price = prices.ask; // Buy at ask for faster fill
        }

        const formattedPrice = this.formatPrice(price);
        const formattedQty = this.formatQuantity(this.quantity);

        log.info(`Placing reduce-only ${this.reduceOnlyOrderSide} LIMIT order`, {
            price: formattedPrice,
            quantity: formattedQty,
        });

        try {
            const order = await this.rest.placeOrder({
                symbol: this.symbol,
                side: this.reduceOnlyOrderSide!,
                type: 'LIMIT',
                price: formattedPrice,
                quantity: formattedQty,
                reduceOnly: true,
                timeInForce: 'GTC',
            });

            if (order && order.status !== 'EXPIRED' && order.status !== 'CANCELED') {
                this.reduceOnlyOrderId = order.orderId;
                this.reduceOnlyOrderPlacedAt = Date.now();
                log.info('Reduce-only order placed', { orderId: order.orderId, status: order.status });
            } else {
                log.warn('Reduce-only order rejected', { status: order?.status });
            }
        } catch (error) {
            log.error('Error placing reduce-only order:', error);
        }
    }

    /**
     * Check if reduce-only order filled, handle result, place next chunk if needed
     */
    private async checkReduceOnlyOrderStatus(): Promise<void> {
        if (!this.reduceOnlyOrderId) return;

        try {
            const order = await this.rest.queryOrder(this.symbol, this.reduceOnlyOrderId);

            if (order.status === 'FILLED') {
                const fillPrice = parseFloat(order.avgPrice);
                const fillQty = parseFloat(order.executedQty);

                // Calculate P&L for this reduction chunk (using taker fee since we're closing urgently)
                const direction = this.reduceOnlyOrderSide === 'SELL' ? 'LONG' : 'SHORT';
                const pnl = this.calculateNetPnL(
                    this.lastEntryPrice || fillPrice,
                    fillPrice,
                    fillQty,
                    direction
                );

                // Update daily P&L
                this.dailyPnL += pnl.netPnL;

                log.info('Reduce-only order FILLED', {
                    fillPrice,
                    fillQty,
                    netPnL: pnl.netPnL.toFixed(4),
                    dailyPnL: this.dailyPnL.toFixed(4),
                });

                this.reduceOnlyOrderId = null;

                // Check if we've reduced enough to resume
                const currentPos = await this.getPositionInfo();
                const reductionPercent = 1 - (currentPos.size / this.reductionStartPositionSize);

                log.info('Position reduction progress', {
                    originalSize: this.reductionStartPositionSize,
                    currentSize: currentPos.size,
                    reductionPercent: (reductionPercent * 100).toFixed(1) + '%',
                    targetPercent: (this.positionResumeThreshold * 100) + '%',
                });

                if (currentPos.size === 0) {
                    // Position fully closed
                    log.info('Position fully closed, exiting reduction mode');
                    this.exitReductionMode();
                } else if (reductionPercent >= this.positionResumeThreshold) {
                    // Reached threshold, can resume trading
                    log.info(`Position reduced by ${(reductionPercent * 100).toFixed(1)}%, resuming trading`);
                    this.exitReductionMode();
                } else {
                    // Continue reducing - place next chunk
                    await this.placeReduceOnlyOrder();
                }

            } else if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
                log.warn(`Reduce-only order ${order.status}, will replace`);
                this.reduceOnlyOrderId = null;
                await this.placeReduceOnlyOrder();

            } else {
                // Order still open - check if we need to reprice
                const timeSincePlaced = Date.now() - this.reduceOnlyOrderPlacedAt;
                if (timeSincePlaced > this.reduceOrderTimeoutMs) {
                    log.info('Reduce-only order timeout, repricing...');
                    await this.cancelReduceOnlyOrder();
                    await this.placeReduceOnlyOrder();
                }
            }
        } catch (error) {
            log.error('Error checking reduce-only order:', error);
        }
    }

    /**
     * Cancel current reduce-only order
     */
    private async cancelReduceOnlyOrder(): Promise<void> {
        if (!this.reduceOnlyOrderId) return;

        try {
            await this.rest.cancelOrder(this.symbol, this.reduceOnlyOrderId);
            log.info('Reduce-only order cancelled', { orderId: this.reduceOnlyOrderId });
        } catch {
            // Ignore if already cancelled
        }
        this.reduceOnlyOrderId = null;
    }

    /**
     * Check if price has deviated too far - trigger emergency close
     */
    private async checkEmergencyClose(): Promise<boolean> {
        const currentPrice = await this.getCurrentPrice();
        const priceDeviation = Math.abs(currentPrice - this.reductionStartPrice) / this.reductionStartPrice;

        if (priceDeviation >= this.emergencyCloseDeviation) {
            log.error('EMERGENCY: Price deviation exceeded threshold!', {
                reductionStartPrice: this.reductionStartPrice,
                currentPrice,
                deviation: (priceDeviation * 100).toFixed(2) + '%',
                threshold: (this.emergencyCloseDeviation * 100) + '%',
            });
            return true;
        }
        return false;
    }

    /**
     * Emergency close all positions with MARKET order
     */
    private async emergencyCloseAll(): Promise<void> {
        log.error('=== EMERGENCY MARKET CLOSE ===');

        // Cancel any open orders
        await this.cancelAllOrders();
        await this.cancelReduceOnlyOrder();

        // Close position with market order
        await this.closePosition();

        // Enter stabilization wait
        this.isReducingPosition = false;
        this.isWaitingForStabilization = true;
        this.stabilizationStartTime = Date.now();

        log.warn('Entering stabilization wait period', {
            waitMinutes: this.config.stabilizationWaitMinutes,
        });
    }

    /**
     * Check if stabilization wait period is complete
     */
    private checkStabilizationComplete(): boolean {
        if (!this.isWaitingForStabilization) return true;

        const elapsed = Date.now() - this.stabilizationStartTime;
        if (elapsed >= this.stabilizationWaitMs) {
            log.info('Stabilization wait complete, resuming trading');
            this.isWaitingForStabilization = false;
            this.stabilizationStartTime = 0;
            return true;
        }

        const remaining = Math.ceil((this.stabilizationWaitMs - elapsed) / 1000);
        if (remaining % 30 === 0) { // Log every 30 seconds
            log.info(`Stabilization wait: ${remaining} seconds remaining`);
        }
        return false;
    }

    /**
     * Exit position reduction mode
     */
    private exitReductionMode(): void {
        this.isReducingPosition = false;
        this.reductionStartPrice = 0;
        this.reductionStartPositionSize = 0;
        this.reduceOnlyOrderId = null;
        this.reduceOnlyOrderSide = null;
        log.info('Exited position reduction mode');
    }

    /**
     * Main position reduction handler - called each loop iteration when in reduction mode
     */
    private async handlePositionReduction(): Promise<void> {
        // Check for emergency close condition first
        if (await this.checkEmergencyClose()) {
            await this.emergencyCloseAll();
            return;
        }

        // Handle reduce-only order status
        await this.checkReduceOnlyOrderStatus();

        // If no active order and still reducing, place new one
        if (this.isReducingPosition && !this.reduceOnlyOrderId) {
            const posInfo = await this.getPositionInfo();
            if (posInfo.size > 0) {
                await this.placeReduceOnlyOrder();
            } else {
                this.exitReductionMode();
            }
        }
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
     * Now tracks P&L with taker fees for market orders
     */
    private async closePosition(reason: 'OUT_OF_RANGE' | 'CIRCUIT_BREAKER' | 'MANUAL_STOP' = 'MANUAL_STOP'): Promise<void> {
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
            const entryPrice = parseFloat(position.entryPrice);
            const direction: 'LONG' | 'SHORT' = positionAmt > 0 ? 'LONG' : 'SHORT';

            // Get current market price for exit
            const currentPrice = await this.getCurrentPrice();

            // Place market order to close
            if (positionAmt > 0) {
                // LONG position - close with SELL
                await this.rest.placeOrder({
                    symbol: this.symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    quantity,
                    reduceOnly: true,
                });
            } else {
                // SHORT position - close with BUY
                await this.rest.placeOrder({
                    symbol: this.symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    quantity,
                    reduceOnly: true,
                });
            }

            // Calculate P&L with taker fees (market order = taker)
            let grossPnL: number;
            if (direction === 'LONG') {
                grossPnL = (currentPrice - entryPrice) * quantity;
            } else {
                grossPnL = (entryPrice - currentPrice) * quantity;
            }

            // Calculate taker fees (entry was maker, exit is taker for market close)
            const entryNotional = entryPrice * quantity;
            const exitNotional = currentPrice * quantity;
            const entryFee = entryNotional * this.makerFeeRate; // Original entry was maker
            const exitFee = exitNotional * this.takerFeeRate;   // Force close is taker
            const totalFee = entryFee + exitFee;
            const netPnL = grossPnL - totalFee;

            // Update daily P&L tracking
            this.dailyPnL += netPnL;

            // Update consecutive losses
            if (netPnL < 0) {
                this.consecutiveLosses++;
            } else {
                this.consecutiveLosses = 0;
            }

            // Record in state manager for dashboard
            this.state.addForceClose({
                direction,
                entryPrice,
                exitPrice: currentPrice,
                quantity,
                grossPnL,
                takerFee: exitFee, // Only the exit taker fee
                netPnL,
                reason,
            });

            log.warn(`FORCE CLOSE [${reason}]`, {
                direction,
                entryPrice,
                exitPrice: currentPrice,
                quantity,
                grossPnL: grossPnL.toFixed(4),
                fees: totalFee.toFixed(4),
                netPnL: netPnL.toFixed(4),
                dailyPnL: this.dailyPnL.toFixed(4),
            });

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
        const spread = this.getSpread();
        log.info('Placing initial bracket orders', { bid: prices.bid, ask: prices.ask, spread: (spread * 100).toFixed(4) + '%' });

        const buyPrice = prices.bid * (1 - spread);
        const sellPrice = prices.ask * (1 + spread);

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

            // Update rolling price range on trade completion
            await this.updateRollingPriceRange();
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

        // Check position limits before placing new orders
        const canOpen = await this.canOpenPosition();
        if (!canOpen) {
            log.warn('handleBuyFill: Not placing new orders - position limit reached');
            return;
        }

        // Get fresh orderbook prices for placement
        const prices = await this.getOrderbookPrices();
        const spread = this.getSpread();

        // Place sell order above best ask (to ensure maker)
        const newSellPrice = prices.ask * (1 + spread);
        const sellOrder = await this.placeGTXOrder('SELL', newSellPrice, this.quantity);
        if (sellOrder && sellOrder.status !== 'EXPIRED') {
            this.activeSellOrderId = sellOrder.orderId;
        }

        // Place new buy order below best bid (refill)
        const newBuyPrice = prices.bid * (1 - spread);
        const buyOrder = await this.placeGTXOrder('BUY', newBuyPrice, this.quantity);
        if (buyOrder && buyOrder.status !== 'EXPIRED') {
            this.activeBuyOrderId = buyOrder.orderId;
        }

        log.info('New bracket after BUY fill', {
            spread: (spread * 100).toFixed(4) + '%',
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

            // Update rolling price range on trade completion
            await this.updateRollingPriceRange();
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

        // Check position limits before placing new orders
        const canOpen = await this.canOpenPosition();
        if (!canOpen) {
            log.warn('handleSellFill: Not placing new orders - position limit reached');
            return;
        }

        // Get fresh orderbook prices for placement
        const prices = await this.getOrderbookPrices();
        const spread = this.getSpread();

        // Place buy order below best bid (to ensure maker)
        const newBuyPrice = prices.bid * (1 - spread);
        const buyOrder = await this.placeGTXOrder('BUY', newBuyPrice, this.quantity);
        if (buyOrder && buyOrder.status !== 'EXPIRED') {
            this.activeBuyOrderId = buyOrder.orderId;
        }

        // Place new sell order above best ask (refill)
        const newSellPrice = prices.ask * (1 + spread);
        const sellOrder = await this.placeGTXOrder('SELL', newSellPrice, this.quantity);
        if (sellOrder && sellOrder.status !== 'EXPIRED') {
            this.activeSellOrderId = sellOrder.orderId;
        }

        log.info('New bracket after SELL fill', {
            spread: (spread * 100).toFixed(4) + '%',
            newBuyPrice: this.formatPrice(newBuyPrice),
            newSellPrice: this.formatPrice(newSellPrice),
        });
    }

    /**
     * Ensure bracket orders exist - replace missing ones (with position limit check)
     */
    private async ensureBracketExists(): Promise<void> {
        // Check position limits before placing any new orders
        const canOpen = await this.canOpenPosition();
        if (!canOpen) {
            log.warn('ensureBracketExists: Skipping - position limit reached');
            return;
        }

        const prices = await this.getOrderbookPrices();
        const spread = this.getSpread();

        // If no buy order, place one below best bid
        if (!this.activeBuyOrderId) {
            const buyPrice = prices.bid * (1 - spread);
            const buyOrder = await this.placeGTXOrder('BUY', buyPrice, this.quantity);
            if (buyOrder && buyOrder.status !== 'EXPIRED') {
                this.activeBuyOrderId = buyOrder.orderId;
            }
        }

        // If no sell order, place one above best ask
        if (!this.activeSellOrderId) {
            const sellPrice = prices.ask * (1 + spread);
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
                        await this.closePosition('CIRCUIT_BREAKER');

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
                            await this.closePosition('OUT_OF_RANGE');
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

                    // === POSITION REDUCTION & STABILIZATION HANDLING ===

                    // Check if waiting for stabilization after emergency close
                    if (this.isWaitingForStabilization) {
                        if (!this.checkStabilizationComplete()) {
                            await this.sleep(2000);
                            continue; // Still waiting, skip normal trading
                        }
                        // Stabilization complete, will resume normal trading below
                    }

                    // If in position reduction mode, handle it
                    if (this.isReducingPosition) {
                        await this.handlePositionReduction();
                        await this.sleep(2000);
                        continue; // Don't do normal trading while reducing
                    }

                    // Update dynamic spread based on current volatility
                    this.updateDynamicSpread(currentPrice);

                    // Check for fills and handle them
                    await this.checkOrdersAndHandleFills();

                    // Check position limits - trigger reduction if exceeded
                    const canOpenNew = await this.canOpenPosition();
                    if (canOpenNew) {
                        // Ensure we always have bracket orders
                        await this.ensureBracketExists();
                    } else {
                        // Position limit reached - START POSITION REDUCTION
                        log.warn('Position limit reached, entering position reduction mode');
                        await this.startPositionReduction();
                        continue; // Skip rest of loop, enter reduction mode next iteration
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
