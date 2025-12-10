import { describe, test, expect, beforeEach } from 'bun:test';
import { OrderbookManager } from '../services/orderbook';
import type { OrderbookUpdate } from '../types';

describe('OrderbookManager', () => {
    let manager: OrderbookManager;

    beforeEach(() => {
        manager = new OrderbookManager('BTCUSDT');
    });

    describe('initFromSnapshot', () => {
        test('should initialize from snapshot', () => {
            const bids = [
                ['100000', '1.0'],
                ['99999', '2.0'],
                ['99998', '1.5'],
            ] as [string, string][];

            const asks = [
                ['100001', '1.0'],
                ['100002', '2.0'],
                ['100003', '1.5'],
            ] as [string, string][];

            manager.initFromSnapshot(bids, asks, 12345);

            expect(manager.hasData()).toBe(true);
            expect(manager.getBestBid()).toBe(100000);
            expect(manager.getBestAsk()).toBe(100001);
        });
    });

    describe('update', () => {
        test('should update orderbook from WebSocket message', () => {
            // First initialize
            manager.initFromSnapshot(
                [['100000', '1.0']],
                [['100001', '1.0']],
                100
            );

            // Then update
            const update: OrderbookUpdate = {
                e: 'depthUpdate',
                E: Date.now(),
                T: Date.now(),
                s: 'BTCUSDT',
                U: 101,
                u: 102,
                pu: 100,
                b: [['99999', '2.0'], ['99998', '1.5']],
                a: [['100002', '2.0'], ['100003', '1.5']],
            };

            manager.update(update);

            expect(manager.getBestBid()).toBe(99999);
            expect(manager.getBestAsk()).toBe(100002);
        });

        test('should ignore stale updates', () => {
            manager.initFromSnapshot(
                [['100000', '1.0']],
                [['100001', '1.0']],
                100
            );

            const staleUpdate: OrderbookUpdate = {
                e: 'depthUpdate',
                E: Date.now(),
                T: Date.now(),
                s: 'BTCUSDT',
                U: 50,
                u: 60, // Older than current lastUpdateId
                pu: 49,
                b: [['99000', '2.0']],
                a: [['101000', '2.0']],
            };

            manager.update(staleUpdate);

            // Should still have original prices
            expect(manager.getBestBid()).toBe(100000);
            expect(manager.getBestAsk()).toBe(100001);
        });
    });

    describe('getEntryPrice', () => {
        beforeEach(() => {
            manager.initFromSnapshot(
                [
                    ['100000', '1.0'], // Best bid
                    ['99999', '2.0'],  // 2nd bid
                    ['99998', '1.5'],  // 3rd bid
                ],
                [
                    ['100001', '1.0'], // Best ask
                    ['100002', '2.0'], // 2nd ask
                    ['100003', '1.5'], // 3rd ask
                ],
                12345
            );
        });

        test('should return 2nd bid for LONG entry', () => {
            const price = manager.getEntryPrice('LONG', 2);
            expect(price).toBe(99999);
        });

        test('should return 2nd ask for SHORT entry', () => {
            const price = manager.getEntryPrice('SHORT', 2);
            expect(price).toBe(100002);
        });
    });

    describe('getTakeProfitPrice', () => {
        beforeEach(() => {
            // Initialize with 10 levels each
            const bids = Array.from({ length: 10 }, (_, i) =>
                [(100000 - i).toString(), '1.0'] as [string, string]
            );
            const asks = Array.from({ length: 10 }, (_, i) =>
                [(100001 + i).toString(), '1.0'] as [string, string]
            );

            manager.initFromSnapshot(bids, asks, 12345);
        });

        test('should return ask level for LONG TP', () => {
            // For LONG, TP is at asks (higher prices)
            const price = manager.getTakeProfitPrice('LONG', 10);
            expect(price).toBe(100010); // 10th ask
        });

        test('should return bid level for SHORT TP', () => {
            // For SHORT, TP is at bids (lower prices)
            const price = manager.getTakeProfitPrice('SHORT', 10);
            expect(price).toBe(99991); // 10th bid
        });
    });

    describe('getStopLossPrice', () => {
        beforeEach(() => {
            const bids = Array.from({ length: 10 }, (_, i) =>
                [(100000 - i).toString(), '1.0'] as [string, string]
            );
            const asks = Array.from({ length: 10 }, (_, i) =>
                [(100001 + i).toString(), '1.0'] as [string, string]
            );

            manager.initFromSnapshot(bids, asks, 12345);
        });

        test('should return bid level for LONG SL', () => {
            // For LONG, SL is at bids (lower prices)
            const price = manager.getStopLossPrice('LONG', 8);
            expect(price).toBe(99993); // 8th bid
        });

        test('should return ask level for SHORT SL', () => {
            // For SHORT, SL is at asks (higher prices)
            const price = manager.getStopLossPrice('SHORT', 8);
            expect(price).toBe(100008); // 8th ask
        });
    });

    describe('validateTPSLPrices', () => {
        test('should validate LONG TP/SL correctly', () => {
            const result = manager.validateTPSLPrices('LONG', 100000, 100100, 99900);
            expect(result.tpValid).toBe(true);
            expect(result.slValid).toBe(true);
        });

        test('should detect invalid LONG TP (below entry)', () => {
            const result = manager.validateTPSLPrices('LONG', 100000, 99900, 99800);
            expect(result.tpValid).toBe(false);
        });

        test('should detect invalid LONG SL (above entry)', () => {
            const result = manager.validateTPSLPrices('LONG', 100000, 100100, 100050);
            expect(result.slValid).toBe(false);
        });

        test('should validate SHORT TP/SL correctly', () => {
            const result = manager.validateTPSLPrices('SHORT', 100000, 99900, 100100);
            expect(result.tpValid).toBe(true);
            expect(result.slValid).toBe(true);
        });
    });

    describe('getSpread', () => {
        test('should calculate spread correctly', () => {
            manager.initFromSnapshot(
                [['99900', '1.0']],
                [['100100', '1.0']],
                12345
            );

            expect(manager.getSpread()).toBe(200);
        });

        test('should return null when no data', () => {
            expect(manager.getSpread()).toBeNull();
        });
    });

    describe('getMidPrice', () => {
        test('should calculate mid price correctly', () => {
            manager.initFromSnapshot(
                [['99900', '1.0']],
                [['100100', '1.0']],
                12345
            );

            expect(manager.getMidPrice()).toBe(100000);
        });
    });
});
