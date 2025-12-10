/**
 * Standalone script to test Binance Futures order placement
 * Run with: bun run src/tests/test-order.ts
 * 
 * Modify the TEST_PARAMS object below to test different order configurations
 */

import { getConfig, getEndpoints } from '../config';
import { buildSignedQueryString } from '../utils/crypto';
import { logger } from '../utils/logger';

const log = logger.child('ORDER_TEST');

// ============================================================
// MODIFY THESE PARAMETERS TO TEST DIFFERENT ORDER TYPES
// ============================================================
const TEST_PARAMS = {
    // Regular order endpoint: /fapi/v1/order
    // Algo order endpoint: /fapi/v1/algoOrder
    endpoint: '/fapi/v1/order',
    // algoType: 'CONDITIONAL',
    // Order parameters
    symbol: 'BTCUSDT',
    side: 'SELL', // BUY or SELL
    type: 'STOP_MARKET', // LIMIT, MARKET, STOP_MARKET, TAKE_PROFIT_MARKET, etc.

    // For LIMIT orders
    // price: 90000,
    // timeInForce: 'GTC',

    // For conditional orders (STOP, TAKE_PROFIT, etc.)
    stopPrice: 89000, // Trigger price
    // triggerPrice: 89000,
    // Common parameters
    // quantity: 0.002,
    // reduceOnly: true,
    // workingType: 'CONTRACT_PRICE', // MARK_PRICE or CONTRACT_PRICE
    // priceProtect: true,
    // Optional
    // positionSide: 'BOTH', // LONG, SHORT, or BOTH (for hedge mode)
    // newClientOrderId: 'test123',
    closePosition: true,
};
// ============================================================

async function testPlaceOrder() {
    const config = getConfig();
    const endpoints = getEndpoints(config.useTestnet);

    log.info('='.repeat(60));
    log.info('Order Placement Test');
    log.info('='.repeat(60));
    log.info('Environment:', {
        testnet: config.useTestnet,
        baseUrl: endpoints.restBaseUrl,
    });
    log.info('Order Parameters:', TEST_PARAMS);
    log.info('='.repeat(60));

    // Build order params (remove undefined values)
    const orderParams: Record<string, string | number | boolean | undefined> = {
        symbol: TEST_PARAMS.symbol,
        side: TEST_PARAMS.side,
        type: TEST_PARAMS.type,
        stopPrice: TEST_PARAMS.stopPrice,
        closePosition: TEST_PARAMS.closePosition,
        // workingType: TEST_PARAMS.workingType,
        // price: TEST_PARAMS.price,
        // timeInForce: TEST_PARAMS.timeInForce,
        // positionSide: TEST_PARAMS.positionSide,
        // newClientOrderId: TEST_PARAMS.newClientOrderId,
    };

    // Remove undefined values
    Object.keys(orderParams).forEach(key => {
        if (orderParams[key] === undefined) {
            delete orderParams[key];
        }
    });

    // Add timestamp
    const allParams = {
        ...orderParams,
        timestamp: Date.now(),
        recvWindow: 5000,
    };

    try {
        // Build signed query string
        const queryString = await buildSignedQueryString(allParams, config.apiSecret);
        const url = `${endpoints.restBaseUrl}${TEST_PARAMS.endpoint}`;

        log.info('Request URL:', url);
        log.info('Request Body (first 200 chars):', queryString.substring(0, 200) + '...');

        // Make the request
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-MBX-APIKEY': config.apiKey,
            },
            body: queryString,
        });

        const data = await response.json();

        log.info('='.repeat(60));
        log.info('Response Status:', response.status);
        log.info('Response Headers:', {
            'X-MBX-USED-WEIGHT-1M': response.headers.get('X-MBX-USED-WEIGHT-1M'),
            'X-MBX-ORDER-COUNT-10S': response.headers.get('X-MBX-ORDER-COUNT-10S'),
        });
        log.info('Response Body:', JSON.stringify(data, null, 2));
        log.info('='.repeat(60));

        if (response.ok) {
            log.info('✅ ORDER PLACED SUCCESSFULLY');
        } else {
            log.error('❌ ORDER FAILED');
            log.error('Error Code:', (data as any).code);
            log.error('Error Message:', (data as any).msg);
        }

        return data;
    } catch (error) {
        log.error('Request Error:', error);
        throw error;
    }
}

// Additional helper: Test regular order endpoint
async function testRegularOrder() {
    const config = getConfig();
    const endpoints = getEndpoints(false);

    const orderParams = {
        symbol: 'ETHUSDC',
        side: 'SELL',
        type: 'LIMIT',
        quantity: 0.007,
        reduceOnly: true,
        price: 3106,
        timeInForce: 'GTC',
        timestamp: Date.now(),
        recvWindow: 5000,
    };

    const queryString = await buildSignedQueryString(orderParams, config.apiSecret);

    log.info('Testing REGULAR order endpoint: /fapi/v1/order');

    const response = await fetch(`${endpoints.restBaseUrl}/fapi/v1/order`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-MBX-APIKEY': config.apiKey,
        },
        body: queryString,
    });

    const data = await response.json();
    log.info('Regular Order Response:', JSON.stringify(data, null, 2));

    return data;
}

// Additional helper: Test algo order endpoint
async function testAlgoOrder() {
    const config = getConfig();
    const endpoints = getEndpoints(false);

    const orderParams = {
        symbol: 'ETHUSDC',
        side: 'SELL',
        type: 'STOP_MARKET',
        algoType: 'CONDITIONAL',
        triggerPrice: 3050,
        stopPrice: 3050,
        closePosition: true,
        timestamp: Date.now(),
        recvWindow: 5000,
    };

    const queryString = await buildSignedQueryString(orderParams, config.apiSecret);

    log.info('Testing ALGO order endpoint: /fapi/v1/algoOrder');

    const response = await fetch(`${endpoints.restBaseUrl}/fapi/v1/algoOrder`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-MBX-APIKEY': config.apiKey,
        },
        body: queryString,
    });

    const data = await response.json();
    log.info('Algo Order Response:', JSON.stringify(data, null, 2));

    return data;
}

// Run the test
log.info('Starting order test...');
testRegularOrder()
    .then(() => log.info('Test completed'))
    .catch(err => log.error('Test failed:', err));
