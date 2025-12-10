import { getConfig } from '../config';
import { getRestClient } from '../api/rest';
import { logger } from '../utils/logger';
import { BinanceApiError, type OrderResponse, type SymbolInfo } from '../types';
import { OrderbookManager } from './orderbook';

const log = logger.child('ORDERS');

/**
 * Utility functions for order precision and validation
 */

/**
 * Round a number to a specific precision (number of decimal places)
 */
export function roundToPrecision(value: number, precision: number): number {
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
}

/**
 * Round quantity to step size
 */
export function roundToStepSize(quantity: number, stepSize: string): number {
    const step = parseFloat(stepSize);
    if (step === 0) return quantity;

    const precision = stepSize.includes('.')
        ? stepSize.split('.')[1]!.replace(/0+$/, '').length
        : 0;

    const rounded = Math.floor(quantity / step) * step;
    return roundToPrecision(rounded, precision);
}

/**
 * Round price to tick size
 */
export function roundToTickSize(price: number, tickSize: string): number {
    const tick = parseFloat(tickSize);
    if (tick === 0) return price;

    const precision = tickSize.includes('.')
        ? tickSize.split('.')[1]!.replace(/0+$/, '').length
        : 0;

    const rounded = Math.round(price / tick) * tick;
    return roundToPrecision(rounded, precision);
}

/**
 * Order service for placing and managing orders
 */
export class OrderService {
    private symbolInfo: SymbolInfo | null = null;
    private orderbookManager: OrderbookManager;
    private config = getConfig();

    constructor(orderbookManager: OrderbookManager) {
        this.orderbookManager = orderbookManager;
    }

    /**
     * Initialize service by fetching symbol info
     */
    async initialize(): Promise<void> {
        const client = getRestClient();
        const exchangeInfo = await client.getExchangeInfo();

        this.symbolInfo = exchangeInfo.symbols.find(s => s.symbol === this.config.symbol) ?? null;

        if (!this.symbolInfo) {
            throw new Error(`Symbol ${this.config.symbol} not found in exchange info`);
        }

        log.info('Order service initialized', {
            symbol: this.config.symbol,
            pricePrecision: this.symbolInfo.pricePrecision,
            quantityPrecision: this.symbolInfo.quantityPrecision,
        });

        // Set leverage
        try {
            await client.setLeverage(this.config.symbol, this.config.leverage);
        } catch (error) {
            // Leverage might already be set, log and continue
            log.warn('Failed to set leverage (might already be set)', { error });
        }
    }

    /**
     * Get price and quantity precision from symbol info
     */
    getPrecision(): { pricePrecision: number; quantityPrecision: number; tickSize: string; stepSize: string } {
        if (!this.symbolInfo) {
            throw new Error('Symbol info not loaded. Call initialize() first.');
        }

        // Find LOT_SIZE and PRICE_FILTER filters
        let tickSize = '0.01';
        let stepSize = '0.001';

        for (const filter of this.symbolInfo.filters) {
            if (filter.filterType === 'PRICE_FILTER') {
                tickSize = filter.tickSize;
            } else if (filter.filterType === 'LOT_SIZE') {
                stepSize = filter.stepSize;
            }
        }

        return {
            pricePrecision: this.symbolInfo.pricePrecision,
            quantityPrecision: this.symbolInfo.quantityPrecision,
            tickSize,
            stepSize,
        };
    }

    /**
     * Format price according to symbol precision
     */
    formatPrice(price: number): number {
        const { tickSize } = this.getPrecision();
        return roundToTickSize(price, tickSize);
    }

    /**
     * Format quantity according to symbol precision
     */
    formatQuantity(quantity: number): number {
        const { stepSize } = this.getPrecision();
        return roundToStepSize(quantity, stepSize);
    }

    /**
     * Place a limit entry order
     */
    async placeEntryOrder(direction: 'LONG' | 'SHORT'): Promise<OrderResponse> {
        const client = getRestClient();
        const entryPrice = this.orderbookManager.getEntryPrice(direction, this.config.entryLevel);

        if (entryPrice === null) {
            throw new Error('Could not get entry price from orderbook');
        }

        const side = direction === 'LONG' ? 'BUY' : 'SELL';
        const formattedPrice = this.formatPrice(entryPrice);
        const formattedQuantity = this.formatQuantity(this.config.quantity);

        log.trade('ENTRY', {
            direction,
            side,
            price: formattedPrice,
            quantity: formattedQuantity,
        });

        const order = await client.placeOrder({
            symbol: this.config.symbol,
            side,
            type: 'LIMIT',
            price: formattedPrice,
            quantity: formattedQuantity,
            timeInForce: 'GTC',
        });

        return order;
    }

    /**
     * Place take profit order as a LIMIT order with reduceOnly
     * Uses regular /fapi/v1/order endpoint
     */
    async placeTakeProfitOrder(
        direction: 'LONG' | 'SHORT',
        quantity: number,
        maxRetries: number = 5
    ): Promise<{ orderId: number } | null> {
        const client = getRestClient();
        const side = direction === 'LONG' ? 'SELL' : 'BUY';

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Get TP price from orderbook
                const tpPrice = this.orderbookManager.getTakeProfitPrice(direction, this.config.tpLevel);

                if (tpPrice === null) {
                    log.warn('Could not get TP price, retrying...', { attempt });
                    await this.sleep(500);
                    continue;
                }

                const formattedPrice = this.formatPrice(tpPrice);
                const formattedQuantity = this.formatQuantity(quantity);

                log.trade('TP_ORDER', {
                    direction,
                    side,
                    type: 'LIMIT',
                    price: formattedPrice,
                    quantity: formattedQuantity,
                    attempt,
                });

                // Use regular order endpoint with LIMIT + reduceOnly
                const order = await client.placeOrder({
                    symbol: this.config.symbol,
                    side,
                    type: 'LIMIT',
                    price: formattedPrice,
                    quantity: formattedQuantity,
                    timeInForce: 'GTC',
                    reduceOnly: true,
                });

                return { orderId: order.orderId };
            } catch (error) {
                if (error instanceof BinanceApiError) {
                    log.warn(`TP order failed (attempt ${attempt}): ${error.message}`, { code: error.code });

                    if (attempt < maxRetries) {
                        await this.sleep(500);
                        continue;
                    }
                }

                if (attempt === maxRetries) {
                    log.error('Failed to place TP order after max retries', { error });
                    return null;
                }

                await this.sleep(500);
            }
        }

        return null;
    }

    /**
     * Place stop loss order
     * First tries Algo Order API, falls back to regular order if that fails
     */
    async placeStopLossOrder(
        direction: 'LONG' | 'SHORT',
        quantity: number,
        maxRetries: number = 3
    ): Promise<{ algoOrderId: number } | null> {
        const client = getRestClient();
        const side = direction === 'LONG' ? 'SELL' : 'BUY';

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Get SL price from orderbook
                const slPrice = this.orderbookManager.getStopLossPrice(direction, this.config.slLevel);

                if (slPrice === null) {
                    log.warn('Could not get SL price, retrying...', { attempt });
                    await this.sleep(500);
                    continue;
                }

                const formattedPrice = this.formatPrice(slPrice);
                const formattedQuantity = this.formatQuantity(quantity);

                log.trade('SL_ORDER', {
                    direction,
                    side,
                    type: 'STOP_MARKET',
                    stopPrice: formattedPrice,
                    quantity: formattedQuantity,
                    attempt,
                });

                // Try regular order endpoint first (works on mainnet)
                try {
                    const order = await client.placeOrder({
                        symbol: this.config.symbol,
                        side,
                        type: 'STOP_MARKET',
                        stopPrice: formattedPrice,
                        quantity: formattedQuantity,
                        reduceOnly: true,
                        workingType: 'CONTRACT_PRICE',
                    });
                    log.info('SL order placed via regular endpoint', { orderId: order.orderId });
                    return { algoOrderId: order.orderId };
                } catch (regularError) {
                    // If -4120 error (Order type not supported), try algo order
                    if (regularError instanceof BinanceApiError && regularError.code === -4120) {
                        log.info('Regular SL failed with -4120, trying Algo Order API...');

                        const algoOrder = await client.placeStopLossAlgoOrder({
                            symbol: this.config.symbol,
                            side,
                            triggerPrice: formattedPrice,
                            stopPrice: formattedPrice,
                        });

                        return { algoOrderId: algoOrder.algoOrderId };
                    }
                    throw regularError;
                }
            } catch (error) {
                if (error instanceof BinanceApiError) {
                    log.warn(`SL order failed (attempt ${attempt}): ${error.message}`, { code: error.code });
                } else {
                    log.error(`SL order error (attempt ${attempt})`, { error });
                }

                if (attempt === maxRetries) {
                    log.error('Failed to place SL order after max retries');
                    return null;
                }

                await this.sleep(500);
            }
        }

        return null;
    }

    /**
     * Cancel an order
     */
    async cancelOrder(orderId: number): Promise<OrderResponse | null> {
        try {
            const client = getRestClient();
            return await client.cancelOrder(this.config.symbol, orderId);
        } catch (error) {
            if (error instanceof BinanceApiError) {
                // Order might already be filled or canceled
                if (error.code === -2011) {
                    log.warn('Order already canceled or filled', { orderId });
                    return null;
                }
            }
            throw error;
        }
    }

    /**
     * Cancel all open orders for the symbol
     */
    async cancelAllOrders(): Promise<void> {
        const client = getRestClient();
        await client.cancelAllOrders(this.config.symbol);
    }

    /**
     * Check order status
     */
    async checkOrderStatus(orderId: number): Promise<OrderResponse> {
        const client = getRestClient();
        return await client.queryOrder(this.config.symbol, orderId);
    }

    /**
     * Wait for an order to be filled or timeout
     */
    async waitForFill(orderId: number, timeoutSeconds: number): Promise<OrderResponse | null> {
        const startTime = Date.now();
        const timeoutMs = timeoutSeconds * 1000;
        const checkInterval = 500; // Check every 500ms

        while (Date.now() - startTime < timeoutMs) {
            try {
                const order = await this.checkOrderStatus(orderId);

                if (order.status === 'FILLED') {
                    log.info('Order filled', { orderId, avgPrice: order.avgPrice });
                    return order;
                }

                if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
                    log.warn('Order canceled or expired', { orderId, status: order.status });
                    return null;
                }

                await this.sleep(checkInterval);
            } catch (error) {
                log.error('Error checking order status', { orderId, error });
                await this.sleep(checkInterval);
            }
        }

        // Timeout reached, cancel the order
        log.warn('Order timeout, cancelling', { orderId });
        await this.cancelOrder(orderId);
        return null;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
