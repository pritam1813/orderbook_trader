import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Direction enum
export const DirectionSchema = z.enum(['LONG', 'SHORT']);
export type Direction = z.infer<typeof DirectionSchema>;

// Strategy enum
export const StrategySchema = z.enum(['orderbook', 'risk_reward', 'micro_grid']);
export type Strategy = z.infer<typeof StrategySchema>;

// Trading config schema (stored in config.json)
export const TradingConfigSchema = z.object({
    symbol: z.string().default('BTCUSDT'),
    quantity: z.number().positive().default(0.001),
    leverage: z.number().int().min(1).max(125).default(10),
    initialDirection: DirectionSchema.default('LONG'),
    directionSwitchLosses: z.number().int().min(1).default(3),
    strategy: StrategySchema.default('orderbook'),
    entryLevel: z.number().int().min(1).max(20).default(2),
    tpLevel: z.number().int().min(1).max(20).default(10),
    slLevel: z.number().int().min(1).max(20).default(8),
    riskRewardRatio: z.number().positive().default(2),
    slDistancePercent: z.number().positive().default(0.1),
    tpslMonitorIntervalSeconds: z.number().int().min(1).max(60).default(5),
    orderTimeoutSeconds: z.number().int().min(5).max(300).default(30),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    // Micro-Grid strategy settings
    spreadGapPercent: z.number().positive().default(0.08), // 0.08% base spread gap
    priceRangePercent: z.number().positive().default(2), // Only operate within ±2% of initial price
    maxPositionMultiplier: z.number().int().min(1).max(50).default(10), // Max position = base qty * multiplier
    dailyLossLimitPercent: z.number().positive().default(5), // Stop trading if daily loss exceeds 5%
    makerFeePercent: z.number().min(0).default(0.02), // Maker fee rate (0.02% default)
    takerFeePercent: z.number().min(0).default(0.05), // Taker fee rate (0.05% default) - for market orders
    // Dynamic spread settings
    minSpreadPercent: z.number().positive().default(0.05), // Minimum spread (0.05%)
    maxSpreadPercent: z.number().positive().default(0.3), // Maximum spread (0.3%)
    volatilityLookbackMinutes: z.number().int().min(1).max(60).default(5), // Lookback for volatility calc
    // Rolling price range settings
    rollingPriceUpdateTrades: z.number().int().min(1).default(20), // Update initial price every N trades
});

export type TradingConfig = z.infer<typeof TradingConfigSchema>;

// Full config schema (includes secrets from .env)
export const ConfigSchema = TradingConfigSchema.extend({
    apiKey: z.string().min(1, 'API key is required'),
    apiSecret: z.string().min(1, 'API secret is required'),
    useTestnet: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;

// Path to config files
const CONFIG_FILE_PATH = join(process.cwd(), 'config.json');
const LOCAL_CONFIG_FILE_PATH = join(process.cwd(), 'config.local.json');

// Default trading config
const DEFAULT_TRADING_CONFIG: TradingConfig = {
    symbol: 'BTCUSDT',
    quantity: 0.001,
    leverage: 10,
    initialDirection: 'LONG',
    directionSwitchLosses: 3,
    strategy: 'orderbook',
    entryLevel: 2,
    tpLevel: 10,
    slLevel: 8,
    riskRewardRatio: 2,
    slDistancePercent: 0.1,
    tpslMonitorIntervalSeconds: 5,
    orderTimeoutSeconds: 30,
    logLevel: 'info',
    spreadGapPercent: 0.08,
    priceRangePercent: 2,
    maxPositionMultiplier: 10,
    dailyLossLimitPercent: 5,
    makerFeePercent: 0.02,
    takerFeePercent: 0.05,
    minSpreadPercent: 0.05,
    maxSpreadPercent: 0.3,
    volatilityLookbackMinutes: 5,
    rollingPriceUpdateTrades: 20,
};

/**
 * Load trading config from config.json + config.local.json
 * config.local.json overrides config.json (for deployment-specific settings)
 */
function loadTradingConfig(): TradingConfig {
    let baseConfig = { ...DEFAULT_TRADING_CONFIG };

    // 1. Load base config from config.json
    try {
        if (existsSync(CONFIG_FILE_PATH)) {
            const fileContent = readFileSync(CONFIG_FILE_PATH, 'utf-8');
            const parsed = JSON.parse(fileContent);
            baseConfig = { ...baseConfig, ...parsed };
        }
    } catch (error) {
        console.warn('Failed to load config.json:', error);
    }

    // 2. Load local overrides from config.local.json (if exists)
    try {
        if (existsSync(LOCAL_CONFIG_FILE_PATH)) {
            const localContent = readFileSync(LOCAL_CONFIG_FILE_PATH, 'utf-8');
            const localParsed = JSON.parse(localContent);
            baseConfig = { ...baseConfig, ...localParsed };
            console.log('✓ Loaded local config overrides from config.local.json');
        }
    } catch (error) {
        console.warn('Failed to load config.local.json:', error);
    }

    // Validate merged config
    return TradingConfigSchema.parse(baseConfig);
}

/**
 * Save trading config to config.local.json (deployment-specific overrides)
 * This file is gitignored, so it won't conflict with git pulls
 */
export function saveTradingConfig(config: Partial<TradingConfig>): { success: boolean; message: string } {
    try {
        // Load existing local config if it exists, otherwise start fresh
        let existingLocalConfig: Partial<TradingConfig> = {};
        if (existsSync(LOCAL_CONFIG_FILE_PATH)) {
            try {
                const fileContent = readFileSync(LOCAL_CONFIG_FILE_PATH, 'utf-8');
                existingLocalConfig = JSON.parse(fileContent);
            } catch {
                // Ignore parse errors, start fresh
            }
        }

        // Merge with new values
        const mergedConfig = { ...existingLocalConfig, ...config };

        // Validate the full merged config (base + local) before saving
        const baseConfig = loadBaseConfig();
        const fullMerged = { ...baseConfig, ...mergedConfig };
        TradingConfigSchema.parse(fullMerged); // Validate

        // Write only to config.local.json
        writeFileSync(LOCAL_CONFIG_FILE_PATH, JSON.stringify(mergedConfig, null, 4), 'utf-8');

        // Reset cached config so next getConfig() picks up changes
        resetConfig();

        return { success: true, message: 'Config saved to config.local.json. Restart bot to apply changes.' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Failed to save config'
        };
    }
}

/**
 * Load base config from config.json (without local overrides)
 */
function loadBaseConfig(): TradingConfig {
    let baseConfig = { ...DEFAULT_TRADING_CONFIG };
    try {
        if (existsSync(CONFIG_FILE_PATH)) {
            const fileContent = readFileSync(CONFIG_FILE_PATH, 'utf-8');
            const parsed = JSON.parse(fileContent);
            baseConfig = { ...baseConfig, ...parsed };
        }
    } catch {
        // Use defaults
    }
    return TradingConfigSchema.parse(baseConfig);
}

/**
 * Load full configuration (secrets from .env + trading params from config.json)
 */
export function loadConfig(): Config {
    // Load secrets from environment
    const secrets = {
        apiKey: process.env.BINANCE_API_KEY || '',
        apiSecret: process.env.BINANCE_API_SECRET || '',
        useTestnet: process.env.USE_TESTNET !== 'false',
    };

    // Load trading config from config.json
    const tradingConfig = loadTradingConfig();

    // Merge and validate
    return ConfigSchema.parse({ ...secrets, ...tradingConfig });
}

// API endpoints
export function getEndpoints(useTestnet: boolean) {
    return {
        restBaseUrl: useTestnet
            ? 'https://demo-fapi.binance.com'
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
