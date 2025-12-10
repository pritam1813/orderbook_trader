import { z } from 'zod';

// Direction enum
export const DirectionSchema = z.enum(['LONG', 'SHORT']);
export type Direction = z.infer<typeof DirectionSchema>;

// Strategy enum
export const StrategySchema = z.enum(['orderbook', 'risk_reward']);
export type Strategy = z.infer<typeof StrategySchema>;

// Configuration schema
export const ConfigSchema = z.object({
    // API credentials
    apiKey: z.string().min(1, 'API key is required'),
    apiSecret: z.string().min(1, 'API secret is required'),

    // Environment
    useTestnet: z.boolean().default(true),

    // Trading configuration
    symbol: z.string().default('BTCUSDT'),
    quantity: z.number().positive().default(0.001),
    leverage: z.number().int().min(1).max(125).default(10),

    // Direction settings
    initialDirection: DirectionSchema.default('LONG'),
    directionSwitchLosses: z.number().int().min(1).default(3),

    // Strategy selection
    strategy: StrategySchema.default('orderbook'),

    // Orderbook strategy levels (used when strategy = 'orderbook')
    entryLevel: z.number().int().min(1).max(20).default(2),
    tpLevel: z.number().int().min(1).max(20).default(10),
    slLevel: z.number().int().min(1).max(20).default(8),

    // Risk-reward strategy settings (used when strategy = 'risk_reward')
    riskRewardRatio: z.number().positive().default(2), // TP distance = SL distance * ratio
    slDistancePercent: z.number().positive().default(0.1), // SL distance as % of entry price

    // TPSL monitor interval
    tpslMonitorIntervalSeconds: z.number().int().min(1).max(60).default(2),

    // Order timeout
    orderTimeoutSeconds: z.number().int().min(5).max(300).default(30),

    // Logging
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

// Load configuration from environment
export function loadConfig(): Config {
    const rawConfig = {
        apiKey: process.env.BINANCE_API_KEY || '',
        apiSecret: process.env.BINANCE_API_SECRET || '',
        useTestnet: process.env.USE_TESTNET !== 'false',
        symbol: process.env.SYMBOL || 'BTCUSDT',
        quantity: parseFloat(process.env.QUANTITY || '0.001'),
        leverage: parseInt(process.env.LEVERAGE || '10', 10),
        initialDirection: (process.env.INITIAL_DIRECTION || 'LONG') as Direction,
        directionSwitchLosses: parseInt(process.env.DIRECTION_SWITCH_LOSSES || '3', 10),
        strategy: (process.env.STRATEGY || 'orderbook') as Strategy,
        entryLevel: parseInt(process.env.ENTRY_LEVEL || '2', 10),
        tpLevel: parseInt(process.env.TP_LEVEL || '10', 10),
        slLevel: parseInt(process.env.SL_LEVEL || '8', 10),
        tpslMonitorIntervalSeconds: parseInt(process.env.TPSL_MONITOR_INTERVAL_SECONDS || '2', 10),
        riskRewardRatio: parseFloat(process.env.RISK_REWARD_RATIO || '2'),
        slDistancePercent: parseFloat(process.env.SL_DISTANCE_PERCENT || '0.1'),
        orderTimeoutSeconds: parseInt(process.env.ORDER_TIMEOUT_SECONDS || '30', 10),
        logLevel: (process.env.LOG_LEVEL || 'info') as Config['logLevel'],
    };

    return ConfigSchema.parse(rawConfig);
}

// API endpoints
export function getEndpoints(useTestnet: boolean) {
    return {
        restBaseUrl: useTestnet
            ? 'https://testnet.binancefuture.com'
            : 'https://fapi.binance.com',
        wsBaseUrl: useTestnet
            ? 'wss://fstream.binancefuture.com'
            : 'wss://fstream.binance.com',
    };
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}

export function resetConfig(): void {
    configInstance = null;
}
