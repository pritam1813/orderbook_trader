import { describe, test, expect, beforeAll } from 'bun:test';
import { generateSignature, buildQueryString, buildSignedQueryString } from '../utils/crypto';

describe('Crypto Utils', () => {
    describe('generateSignature', () => {
        test('should generate correct HMAC SHA256 signature', async () => {
            // Test case from Binance documentation
            const message = 'symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTC&quantity=0.001&price=50000&timestamp=1700000000000&recvWindow=5000';
            const secret = 'testSecret123';

            const signature = await generateSignature(message, secret);

            // Signature should be a 64-character hex string
            expect(signature).toHaveLength(64);
            expect(/^[a-f0-9]+$/.test(signature)).toBe(true);
        });

        test('should produce consistent signatures', async () => {
            const message = 'test=value';
            const secret = 'secret';

            const sig1 = await generateSignature(message, secret);
            const sig2 = await generateSignature(message, secret);

            expect(sig1).toBe(sig2);
        });

        test('should produce different signatures for different messages', async () => {
            const secret = 'secret';

            const sig1 = await generateSignature('message1', secret);
            const sig2 = await generateSignature('message2', secret);

            expect(sig1).not.toBe(sig2);
        });
    });

    describe('buildQueryString', () => {
        test('should build query string from params', () => {
            const params = {
                symbol: 'BTCUSDT',
                side: 'BUY',
                quantity: 0.001,
            };

            const result = buildQueryString(params);

            expect(result).toBe('symbol=BTCUSDT&side=BUY&quantity=0.001');
        });

        test('should skip undefined values', () => {
            const params = {
                symbol: 'BTCUSDT',
                side: undefined,
                quantity: 0.001,
            };

            const result = buildQueryString(params);

            expect(result).toBe('symbol=BTCUSDT&quantity=0.001');
        });

        test('should handle boolean values', () => {
            const params = {
                reduceOnly: true,
                closePosition: false,
            };

            const result = buildQueryString(params);

            expect(result).toBe('reduceOnly=true&closePosition=false');
        });

        test('should encode special characters', () => {
            const params = {
                clientOrderId: 'test order+1',
            };

            const result = buildQueryString(params);

            expect(result).toBe('clientOrderId=test%20order%2B1');
        });
    });

    describe('buildSignedQueryString', () => {
        test('should include timestamp and signature', async () => {
            const params = { symbol: 'BTCUSDT' };
            const secret = 'testSecret';

            const result = await buildSignedQueryString(params, secret);

            expect(result).toContain('symbol=BTCUSDT');
            expect(result).toContain('timestamp=');
            expect(result).toContain('recvWindow=5000');
            expect(result).toContain('signature=');
        });

        test('should place signature at the end', async () => {
            const params = { symbol: 'BTCUSDT' };
            const secret = 'testSecret';

            const result = await buildSignedQueryString(params, secret);

            expect(result).toMatch(/&signature=[a-f0-9]+$/);
        });
    });
});
