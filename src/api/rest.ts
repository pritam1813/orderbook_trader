import { getConfig, getEndpoints } from '../config';
import { buildSignedQueryString, buildQueryString } from '../utils/crypto';
import { logger } from '../utils/logger';
import {
    BinanceApiError,
    BinanceErrorSchema,
    ExchangeInfoSchema,
    ListenKeySchema,
    OrderbookSnapshotSchema,
    OrderResponseSchema,
    PositionSchema,
    ServerTimeSchema,
    type ExchangeInfo,
    type ListenKey,
    type OrderbookSnapshot,
    type OrderResponse,
    type OrderSide,
    type OrderType,
    type Position,
    type PositionSide,
    type ServerTime,
    type TimeInForce,
    type WorkingType,
} from '../types';

const log = logger.child('REST');

/**
 * REST API client for Binance Futures
 * No SDK dependencies - uses native fetch
 */
export class BinanceRestClient {
    private baseUrl: string;
    private apiKey: string;
    private apiSecret: string;
    private serverTimeOffset: number = 0;

    constructor() {
        const config = getConfig();
        const endpoints = getEndpoints(config.useTestnet);

        this.baseUrl = endpoints.restBaseUrl;
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;

        log.debug('REST client initialized', { baseUrl: this.baseUrl, testnet: config.useTestnet });
    }

    /**
     * Sync local time with server time
     */
    async syncTime(): Promise<void> {
        const localTime = Date.now();
        const serverTime = await this.getServerTime();
        this.serverTimeOffset = serverTime.serverTime - localTime;
        log.debug('Time synced', { offset: this.serverTimeOffset });
    }

    /**
     * Get current timestamp adjusted for server time
     */
    private getTimestamp(): number {
        return Date.now() + this.serverTimeOffset;
    }

    /**
     * Make a public (unsigned) request
     */
    private async publicRequest<T>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        endpoint: string,
        params?: Record<string, string | number | boolean | undefined>
    ): Promise<T> {
        let url = `${this.baseUrl}${endpoint}`;

        if (params && method === 'GET') {
            const queryString = buildQueryString(params);
            if (queryString) {
                url += `?${queryString}`;
            }
        }

        log.debug(`${method} ${endpoint}`, params);

        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        const data = await response.json();

        if (!response.ok) {
            const error = BinanceErrorSchema.safeParse(data);
            if (error.success) {
                throw new BinanceApiError(error.data.code, error.data.msg);
            }
            throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
        }

        return data as T;
    }

    /**
     * Make a signed (authenticated) request with timeout
     */
    private async signedRequest<T>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        endpoint: string,
        params?: Record<string, string | number | boolean | undefined>
    ): Promise<T> {
        const allParams = {
            ...params,
            timestamp: this.getTimestamp(),
            recvWindow: 5000,
        };

        const queryString = await buildSignedQueryString(allParams, this.apiSecret);
        let url = `${this.baseUrl}${endpoint}`;

        if (method === 'GET' || method === 'DELETE') {
            url += `?${queryString}`;
        }

        log.debug(`${method} ${endpoint}`, { ...params, timestamp: allParams.timestamp });

        // Add timeout using AbortController
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        const options: RequestInit = {
            method,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-MBX-APIKEY': this.apiKey,
            },
            signal: controller.signal,
        };

        if (method === 'POST' || method === 'PUT') {
            options.body = queryString;
        }

        try {
            const response = await fetch(url, options);
            clearTimeout(timeoutId);

            const data = await response.json();

            if (!response.ok) {
                const error = BinanceErrorSchema.safeParse(data);
                if (error.success) {
                    log.error(`API Error: ${error.data.code} - ${error.data.msg}`);
                    throw new BinanceApiError(error.data.code, error.data.msg);
                }
                throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
            }

            return data as T;
        } catch (error) {
            clearTimeout(timeoutId);
            if ((error as Error).name === 'AbortError') {
                throw new Error(`Request timeout: ${endpoint}`);
            }
            throw error;
        }
    }

    // ===== Public Endpoints =====

    /**
     * Get server time
     */
    async getServerTime(): Promise<ServerTime> {
        const data = await this.publicRequest<unknown>('GET', '/fapi/v1/time');
        return ServerTimeSchema.parse(data);
    }

    /**
     * Get exchange info
     */
    async getExchangeInfo(): Promise<ExchangeInfo> {
        const data = await this.publicRequest<unknown>('GET', '/fapi/v1/exchangeInfo');
        return ExchangeInfoSchema.parse(data);
    }

    /**
     * Get orderbook snapshot
     */
    async getOrderbook(symbol: string, limit: number = 20): Promise<OrderbookSnapshot> {
        const data = await this.publicRequest<unknown>('GET', '/fapi/v1/depth', {
            symbol,
            limit,
        });
        return OrderbookSnapshotSchema.parse(data);
    }
    /**
     * Get user's trade history for a symbol (single page)
     * Supports time-based pagination with startTime/endTime
     */
    async getUserTrades(symbol: string, limit: number = 500, options?: {
        fromId?: number;
        startTime?: number;
        endTime?: number;
    }): Promise<Array<{
        symbol: string;
        id: number;
        orderId: number;
        side: string;
        price: string;
        qty: string;
        quoteQty: string;
        realizedPnl: string;
        commission: string;
        commissionAsset: string;
        time: number;
        buyer: boolean;
        maker: boolean;
    }>> {
        const params: Record<string, string | number | boolean | undefined> = {
            symbol,
            limit,
        };
        if (options?.fromId !== undefined) {
            params.fromId = options.fromId;
        }
        if (options?.startTime !== undefined) {
            params.startTime = options.startTime;
        }
        if (options?.endTime !== undefined) {
            params.endTime = options.endTime;
        }

        const data = await this.signedRequest<Array<Record<string, unknown>>>('GET', '/fapi/v1/userTrades', params);
        return data.map(trade => ({
            symbol: String(trade.symbol),
            id: Number(trade.id),
            orderId: Number(trade.orderId),
            side: String(trade.side),
            price: String(trade.price),
            qty: String(trade.qty),
            quoteQty: String(trade.quoteQty),
            realizedPnl: String(trade.realizedPnl),
            commission: String(trade.commission),
            commissionAsset: String(trade.commissionAsset),
            time: Number(trade.time),
            buyer: Boolean(trade.buyer),
            maker: Boolean(trade.maker),
        }));
    }

    /**
     * Get ALL user's trades for a symbol (paginated - fetches all pages)
     * Returns trades in ascending order by ID (oldest first)
     */
    async getAllUserTrades(symbol: string): Promise<Array<{
        symbol: string;
        id: number;
        orderId: number;
        side: string;
        price: string;
        qty: string;
        quoteQty: string;
        realizedPnl: string;
        commission: string;
        commissionAsset: string;
        time: number;
        buyer: boolean;
        maker: boolean;
    }>> {
        const allTrades: Array<{
            symbol: string;
            id: number;
            orderId: number;
            side: string;
            price: string;
            qty: string;
            quoteQty: string;
            realizedPnl: string;
            commission: string;
            commissionAsset: string;
            time: number;
            buyer: boolean;
            maker: boolean;
        }> = [];

        const limit = 1000; // Max allowed by API
        let hasMore = true;
        let iteration = 0;
        let endTime: number | undefined = undefined; // Will be set to oldest trade time - 1

        log.info(`Starting to fetch all trades for ${symbol}...`);

        while (hasMore) {
            iteration++;
            log.info(`Pagination iteration ${iteration}: fetching with endTime=${endTime ?? 'undefined'}`);

            const trades = await this.getUserTrades(symbol, limit, endTime ? { endTime } : undefined);
            log.info(`Iteration ${iteration}: received ${trades.length} trades`);

            if (trades.length === 0) {
                log.info(`Iteration ${iteration}: no trades returned, stopping`);
                hasMore = false;
            } else {
                // Find oldest trade time in this batch
                let oldestTime = Number.MAX_SAFE_INTEGER;
                let newestTime = 0;
                for (const trade of trades) {
                    if (trade.time < oldestTime) oldestTime = trade.time;
                    if (trade.time > newestTime) newestTime = trade.time;
                }
                log.info(`Iteration ${iteration}: time range ${new Date(oldestTime).toISOString()} - ${new Date(newestTime).toISOString()}`);

                allTrades.push(...trades);

                // If we got less than the limit, we've reached the end
                if (trades.length < limit) {
                    log.info(`Iteration ${iteration}: got ${trades.length} < ${limit}, stopping`);
                    hasMore = false;
                } else {
                    // Set endTime to oldest trade time - 1ms to get older trades
                    endTime = oldestTime - 1;
                    log.info(`Iteration ${iteration}: setting next endTime to ${new Date(endTime).toISOString()}`);
                }
            }

            // Safety limit to prevent infinite loops
            if (allTrades.length > 50000) {
                log.warn('Trade history limit reached (50,000 trades)');
                hasMore = false;
            }

            // Safety: max 100 iterations
            if (iteration >= 100) {
                log.warn('Max pagination iterations reached');
                hasMore = false;
            }
        }

        log.info(`Fetched total ${allTrades.length} trades for ${symbol} in ${iteration} iterations`);

        return allTrades;
    }

    // ===== User Data Stream Endpoints =====

    /**
     * Create a new listen key for user data stream
     */
    async createListenKey(): Promise<ListenKey> {
        const data = await this.signedRequest<unknown>('POST', '/fapi/v1/listenKey');
        return ListenKeySchema.parse(data);
    }

    /**
     * Keep alive a listen key
     */
    async keepAliveListenKey(): Promise<void> {
        await this.signedRequest<unknown>('PUT', '/fapi/v1/listenKey');
    }

    /**
     * Close a listen key
     */
    async closeListenKey(): Promise<void> {
        await this.signedRequest<unknown>('DELETE', '/fapi/v1/listenKey');
    }

    // ===== Trading Endpoints =====

    /**
     * Place a new order
     */
    async placeOrder(params: {
        symbol: string;
        side: OrderSide;
        type: OrderType;
        quantity?: number;
        price?: number;
        stopPrice?: number;
        timeInForce?: TimeInForce;
        reduceOnly?: boolean;
        positionSide?: PositionSide;
        workingType?: WorkingType;
        newClientOrderId?: string;
    }): Promise<OrderResponse> {
        const orderParams: Record<string, string | number | boolean | undefined> = {
            symbol: params.symbol,
            side: params.side,
            type: params.type,
            quantity: params.quantity,
            price: params.price,
            stopPrice: params.stopPrice,
            timeInForce: params.timeInForce,
            reduceOnly: params.reduceOnly,
            positionSide: params.positionSide,
            workingType: params.workingType,
            newClientOrderId: params.newClientOrderId,
        };

        // Remove undefined values
        Object.keys(orderParams).forEach(key => {
            if (orderParams[key] === undefined) {
                delete orderParams[key];
            }
        });

        log.info('Placing order', orderParams);
        const data = await this.signedRequest<unknown>('POST', '/fapi/v1/order', orderParams);
        const order = OrderResponseSchema.parse(data);
        log.info('Order placed', { orderId: order.orderId, status: order.status });
        return order;
    }

    /**
     * Cancel an order
     */
    async cancelOrder(symbol: string, orderId: number): Promise<OrderResponse> {
        log.info('Cancelling order', { symbol, orderId });
        const data = await this.signedRequest<unknown>('DELETE', '/fapi/v1/order', {
            symbol,
            orderId,
        });
        const order = OrderResponseSchema.parse(data);
        log.info('Order cancelled', { orderId: order.orderId, status: order.status });
        return order;
    }

    /**
     * Cancel all open orders for a symbol
     */
    async cancelAllOrders(symbol: string): Promise<void> {
        log.info('Cancelling all orders', { symbol });
        await this.signedRequest<unknown>('DELETE', '/fapi/v1/allOpenOrders', { symbol });
        log.info('All orders cancelled');
    }

    /**
     * Set leverage for a symbol
     */
    async setLeverage(symbol: string, leverage: number): Promise<void> {
        log.info('Setting leverage', { symbol, leverage });
        await this.signedRequest<unknown>('POST', '/fapi/v1/leverage', {
            symbol,
            leverage,
        });
        log.info('Leverage set');
    }

    /**
     * Query order status
     */
    async queryOrder(symbol: string, orderId: number): Promise<OrderResponse> {
        const data = await this.signedRequest<unknown>('GET', '/fapi/v1/order', {
            symbol,
            orderId,
        });
        return OrderResponseSchema.parse(data);
    }

    /**
     * Get all open orders
     */
    async getOpenOrders(symbol?: string): Promise<OrderResponse[]> {
        const params: Record<string, string | number | boolean | undefined> = {};
        if (symbol) {
            params.symbol = symbol;
        }

        const data = await this.signedRequest<unknown[]>('GET', '/fapi/v1/openOrders', params);
        return data.map(order => OrderResponseSchema.parse(order));
    }

    // ===== Algo Order Endpoints (for conditional orders) =====

    /**
     * Place a stop loss order using the Algo Order API
     * Required params: algoType, triggerPrice, stopPrice, closePosition
     */
    async placeStopLossAlgoOrder(params: {
        symbol: string;
        side: OrderSide;
        triggerPrice: number;
        stopPrice: number;
        newClientOrderId?: string;
    }): Promise<{ algoOrderId: number; clientAlgoId: string; status: string }> {
        const orderParams: Record<string, string | number | boolean | undefined> = {
            symbol: params.symbol,
            side: params.side,
            type: 'STOP_MARKET',
            algoType: 'CONDITIONAL',
            triggerPrice: params.triggerPrice,
            stopPrice: params.stopPrice,
            closePosition: true,
            newClientOrderId: params.newClientOrderId,
        };

        // Remove undefined values
        Object.keys(orderParams).forEach(key => {
            if (orderParams[key] === undefined) {
                delete orderParams[key];
            }
        });

        log.info('Placing SL algo order', orderParams);
        const data = await this.signedRequest<Record<string, unknown>>(
            'POST',
            '/fapi/v1/algoOrder',
            orderParams
        );
        // Log raw response for debugging
        log.info('SL algo order raw response', data);

        // Extract algoId - Binance uses 'algoId' not 'algoOrderId'
        const algoOrderId = data.algoId ?? data.algoOrderId ?? data.orderId ?? 0;
        const clientAlgoId = data.clientAlgoId ?? '';
        const status = data.algoStatus ?? data.status ?? 'NEW';

        log.info('SL algo order placed', { algoOrderId, clientAlgoId, status });
        return {
            algoOrderId: Number(algoOrderId),
            clientAlgoId: String(clientAlgoId),
            status: String(status)
        };
    }

    /**
     * Cancel an algo order
     */
    async cancelAlgoOrder(symbol: string, algoId: number): Promise<void> {
        log.info('Cancelling algo order', { symbol, algoId });
        await this.signedRequest<unknown>('DELETE', '/fapi/v1/algoOrder', {
            symbol,
            algoId,  // Binance requires 'algoId' not 'algoOrderId'
        });
        log.info('Algo order cancelled', { algoId });
    }

    /**
     * Get position risk (current position details) for a symbol
     */
    async getPositionRisk(symbol: string): Promise<Position | null> {
        const data = await this.signedRequest<unknown[]>('GET', '/fapi/v2/positionRisk', {
            symbol,
        });

        if (Array.isArray(data) && data.length > 0) {
            // Find the BOTH position (for one-way mode) or the one with non-zero positionAmt
            for (const pos of data) {
                const parsed = PositionSchema.safeParse(pos);
                if (parsed.success) {
                    const posAmt = parseFloat(parsed.data.positionAmt);
                    if (posAmt !== 0 || parsed.data.positionSide === 'BOTH') {
                        return parsed.data;
                    }
                }
            }
            // If no active position, return the first one
            const first = PositionSchema.safeParse(data[0]);
            return first.success ? first.data : null;
        }
        return null;
    }
}

// Singleton instance
let clientInstance: BinanceRestClient | null = null;

export function getRestClient(): BinanceRestClient {
    if (!clientInstance) {
        clientInstance = new BinanceRestClient();
    }
    return clientInstance;
}

export function resetRestClient(): void {
    clientInstance = null;
}
