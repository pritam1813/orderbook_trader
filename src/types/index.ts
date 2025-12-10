import { z } from 'zod';

// ===== Orderbook Types =====

export const OrderbookLevelSchema = z.tuple([
    z.string(), // Price
    z.string(), // Quantity
]);

export type OrderbookLevel = z.infer<typeof OrderbookLevelSchema>;

export const OrderbookUpdateSchema = z.object({
    e: z.literal('depthUpdate'),
    E: z.number(), // Event time
    T: z.number(), // Transaction time
    s: z.string(), // Symbol
    U: z.number(), // First update ID
    u: z.number(), // Final update ID
    pu: z.number(), // Previous final update ID
    b: z.array(OrderbookLevelSchema), // Bids
    a: z.array(OrderbookLevelSchema), // Asks
});

export type OrderbookUpdate = z.infer<typeof OrderbookUpdateSchema>;

export const OrderbookSnapshotSchema = z.object({
    lastUpdateId: z.number(),
    E: z.number(), // Message output time
    T: z.number(), // Transaction time
    bids: z.array(OrderbookLevelSchema),
    asks: z.array(OrderbookLevelSchema),
});

export type OrderbookSnapshot = z.infer<typeof OrderbookSnapshotSchema>;

// ===== Order Types =====

export const OrderSideSchema = z.enum(['BUY', 'SELL']);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum([
    'LIMIT',
    'MARKET',
    'STOP',
    'STOP_MARKET',
    'TAKE_PROFIT',
    'TAKE_PROFIT_MARKET',
    'TRAILING_STOP_MARKET',
]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const OrderStatusSchema = z.enum([
    'NEW',
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCELED',
    'EXPIRED',
    'EXPIRED_IN_MATCH',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const TimeInForceSchema = z.enum(['GTC', 'IOC', 'FOK', 'GTX', 'GTD']);
export type TimeInForce = z.infer<typeof TimeInForceSchema>;

export const PositionSideSchema = z.enum(['BOTH', 'LONG', 'SHORT']);
export type PositionSide = z.infer<typeof PositionSideSchema>;

export const WorkingTypeSchema = z.enum(['MARK_PRICE', 'CONTRACT_PRICE']);
export type WorkingType = z.infer<typeof WorkingTypeSchema>;

// Order response schema
export const OrderResponseSchema = z.object({
    orderId: z.number(),
    symbol: z.string(),
    status: OrderStatusSchema,
    clientOrderId: z.string(),
    price: z.string(),
    avgPrice: z.string(),
    origQty: z.string(),
    executedQty: z.string(),
    cumQty: z.string().optional(),
    cumQuote: z.string(),
    timeInForce: TimeInForceSchema,
    type: OrderTypeSchema,
    reduceOnly: z.boolean(),
    closePosition: z.boolean().optional(),
    side: OrderSideSchema,
    positionSide: PositionSideSchema,
    stopPrice: z.string().optional(),
    workingType: WorkingTypeSchema.optional(),
    priceProtect: z.boolean().optional(),
    origType: OrderTypeSchema.optional(),
    updateTime: z.number(),
});

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

// ===== User Data Stream Types =====

export const ExecutionTypeSchema = z.enum([
    'NEW',
    'CANCELED',
    'CALCULATED',
    'EXPIRED',
    'TRADE',
    'AMENDMENT',
]);
export type ExecutionType = z.infer<typeof ExecutionTypeSchema>;

export const OrderUpdateEventSchema = z.object({
    e: z.literal('ORDER_TRADE_UPDATE'),
    E: z.number(), // Event time
    T: z.number(), // Transaction time
    o: z.object({
        s: z.string(), // Symbol
        c: z.string(), // Client order ID
        S: OrderSideSchema, // Side
        o: OrderTypeSchema, // Order type
        f: TimeInForceSchema, // Time in force
        q: z.string(), // Original quantity
        p: z.string(), // Original price
        ap: z.string(), // Average price
        sp: z.string().optional(), // Stop price
        x: ExecutionTypeSchema, // Execution type
        X: OrderStatusSchema, // Order status
        i: z.number(), // Order ID
        l: z.string(), // Last filled quantity
        z: z.string(), // Filled accumulated quantity
        L: z.string(), // Last filled price
        N: z.string().nullable().optional(), // Commission asset
        n: z.string().optional(), // Commission
        T: z.number(), // Order trade time
        t: z.number(), // Trade ID
        b: z.string().optional(), // Bids notional
        a: z.string().optional(), // Ask notional
        m: z.boolean(), // Is maker
        R: z.boolean(), // Is reduce only
        wt: WorkingTypeSchema.optional(), // Working type
        ot: OrderTypeSchema.optional(), // Original order type
        ps: PositionSideSchema, // Position side
        cp: z.boolean().optional(), // Close position
        rp: z.string().optional(), // Realized profit
    }),
});

export type OrderUpdateEvent = z.infer<typeof OrderUpdateEventSchema>;

// ===== Exchange Info Types =====

export const SymbolFilterSchema = z.discriminatedUnion('filterType', [
    z.object({
        filterType: z.literal('PRICE_FILTER'),
        minPrice: z.string(),
        maxPrice: z.string(),
        tickSize: z.string(),
    }),
    z.object({
        filterType: z.literal('LOT_SIZE'),
        minQty: z.string(),
        maxQty: z.string(),
        stepSize: z.string(),
    }),
    z.object({
        filterType: z.literal('MIN_NOTIONAL'),
        notional: z.string(),
    }),
    z.object({
        filterType: z.literal('MARKET_LOT_SIZE'),
        minQty: z.string(),
        maxQty: z.string(),
        stepSize: z.string(),
    }),
    z.object({
        filterType: z.literal('MAX_NUM_ORDERS'),
        limit: z.number(),
    }),
    z.object({
        filterType: z.literal('MAX_NUM_ALGO_ORDERS'),
        limit: z.number(),
    }),
    z.object({
        filterType: z.literal('PERCENT_PRICE'),
        multiplierUp: z.string(),
        multiplierDown: z.string(),
        multiplierDecimal: z.string(),
    }),
]);

export type SymbolFilter = z.infer<typeof SymbolFilterSchema>;

export const SymbolInfoSchema = z.object({
    symbol: z.string(),
    pair: z.string(),
    contractType: z.string(),
    deliveryDate: z.number(),
    onboardDate: z.number(),
    status: z.string(),
    maintMarginPercent: z.string(),
    requiredMarginPercent: z.string(),
    baseAsset: z.string(),
    quoteAsset: z.string(),
    marginAsset: z.string(),
    pricePrecision: z.number(),
    quantityPrecision: z.number(),
    baseAssetPrecision: z.number(),
    quotePrecision: z.number(),
    underlyingType: z.string(),
    underlyingSubType: z.array(z.string()),
    settlePlan: z.number().optional(),
    triggerProtect: z.string(),
    filters: z.array(z.any()), // Use any to avoid complex discriminated union issues
    orderTypes: z.array(OrderTypeSchema.or(z.string())),
    timeInForce: z.array(TimeInForceSchema.or(z.string())),
    liquidationFee: z.string().optional(),
    marketTakeBound: z.string().optional(),
});

export type SymbolInfo = z.infer<typeof SymbolInfoSchema>;

export const ExchangeInfoSchema = z.object({
    timezone: z.string(),
    serverTime: z.number(),
    futuresType: z.string().optional(),
    rateLimits: z.array(z.any()),
    exchangeFilters: z.array(z.any()),
    assets: z.array(z.any()).optional(),
    symbols: z.array(SymbolInfoSchema),
});

export type ExchangeInfo = z.infer<typeof ExchangeInfoSchema>;

// ===== Listen Key Types =====

export const ListenKeySchema = z.object({
    listenKey: z.string(),
});

export type ListenKey = z.infer<typeof ListenKeySchema>;

// ===== Server Time Types =====

export const ServerTimeSchema = z.object({
    serverTime: z.number(),
});

export type ServerTime = z.infer<typeof ServerTimeSchema>;

// ===== Account Types =====

export const PositionSchema = z.object({
    symbol: z.string(),
    positionAmt: z.string(),
    entryPrice: z.string(),
    breakEvenPrice: z.string().optional(),
    markPrice: z.string(),
    unRealizedProfit: z.string(),
    liquidationPrice: z.string(),
    leverage: z.string(),
    maxNotionalValue: z.string(),
    marginType: z.string(),
    isolatedMargin: z.string(),
    isAutoAddMargin: z.string(),
    positionSide: PositionSideSchema,
    notional: z.string(),
    isolatedWallet: z.string(),
    updateTime: z.number(),
    isolated: z.boolean().optional(),
    adlQuantile: z.number().optional(),
});

export type Position = z.infer<typeof PositionSchema>;

// ===== Error Types =====

export const BinanceErrorSchema = z.object({
    code: z.number(),
    msg: z.string(),
});

export type BinanceError = z.infer<typeof BinanceErrorSchema>;

export class BinanceApiError extends Error {
    code: number;

    constructor(code: number, message: string) {
        super(message);
        this.code = code;
        this.name = 'BinanceApiError';
    }
}

// ===== Trade State Types =====

export interface TradeState {
    direction: 'LONG' | 'SHORT';
    consecutiveLosses: number;
    currentOrderId: number | null;
    currentTpOrderId: number | null;
    currentSlOrderId: number | null;
    entryPrice: number | null;
    isInTrade: boolean;
    totalTrades: number;
    wins: number;
    losses: number;
}

export interface OrderbookState {
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
    lastUpdateId: number;
    timestamp: number;
}
