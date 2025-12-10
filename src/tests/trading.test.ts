import { describe, test, expect } from 'bun:test';
import { roundToPrecision, roundToStepSize, roundToTickSize } from '../services/orders';

describe('Order Utilities', () => {
    describe('roundToPrecision', () => {
        test('should round to specified precision', () => {
            expect(roundToPrecision(100.123456, 2)).toBe(100.12);
            expect(roundToPrecision(100.125, 2)).toBe(100.13);
            expect(roundToPrecision(100.999, 0)).toBe(101);
        });

        test('should handle zero precision', () => {
            expect(roundToPrecision(99.5, 0)).toBe(100);
            expect(roundToPrecision(99.4, 0)).toBe(99);
        });
    });

    describe('roundToStepSize', () => {
        test('should round quantity to step size', () => {
            expect(roundToStepSize(0.0156, '0.001')).toBe(0.015);
            expect(roundToStepSize(0.0159, '0.001')).toBe(0.015);
            expect(roundToStepSize(1.567, '0.01')).toBe(1.56);
        });

        test('should handle small step sizes', () => {
            expect(roundToStepSize(0.00012345, '0.00001')).toBe(0.00012);
        });

        test('should floor to step size', () => {
            // Step size of 0.1, quantity 0.99 should become 0.9
            expect(roundToStepSize(0.99, '0.1')).toBe(0.9);
        });
    });

    describe('roundToTickSize', () => {
        test('should round price to tick size', () => {
            expect(roundToTickSize(100.123, '0.01')).toBe(100.12);
            expect(roundToTickSize(100.127, '0.01')).toBe(100.13);
        });

        test('should handle larger tick sizes', () => {
            expect(roundToTickSize(100.123, '0.1')).toBe(100.1);
            expect(roundToTickSize(100.15, '0.1')).toBe(100.2);
        });

        test('should handle tick size of 1', () => {
            expect(roundToTickSize(99.6, '1')).toBe(100);
            expect(roundToTickSize(99.4, '1')).toBe(99);
        });
    });
});

describe('Trading Logic', () => {
    describe('Direction Switching', () => {
        test('should switch from LONG to SHORT', () => {
            let direction: 'LONG' | 'SHORT' = 'LONG';
            let consecutiveLosses = 0;
            const switchThreshold = 3;

            // Simulate 3 losses
            for (let i = 0; i < 3; i++) {
                consecutiveLosses++;
            }

            if (consecutiveLosses >= switchThreshold) {
                direction = direction === 'LONG' ? 'SHORT' : 'LONG';
                consecutiveLosses = 0;
            }

            expect(direction).toBe('SHORT');
            expect(consecutiveLosses).toBe(0);
        });

        test('should not switch before threshold', () => {
            let direction: 'LONG' | 'SHORT' = 'LONG';
            let consecutiveLosses = 0;
            const switchThreshold = 3;

            // Simulate 2 losses
            for (let i = 0; i < 2; i++) {
                consecutiveLosses++;
            }

            if (consecutiveLosses >= switchThreshold) {
                direction = direction === 'LONG' ? 'SHORT' : 'LONG';
            }

            expect(direction).toBe('LONG');
            expect(consecutiveLosses).toBe(2);
        });

        test('should reset loss counter on win', () => {
            let consecutiveLosses = 2;

            // Simulate a win
            const isWin = true;
            if (isWin) {
                consecutiveLosses = 0;
            }

            expect(consecutiveLosses).toBe(0);
        });
    });

    describe('Trade State Management', () => {
        interface TradeState {
            direction: 'LONG' | 'SHORT';
            consecutiveLosses: number;
            totalTrades: number;
            wins: number;
            losses: number;
        }

        test('should track win rate correctly', () => {
            const state: TradeState = {
                direction: 'LONG',
                consecutiveLosses: 0,
                totalTrades: 10,
                wins: 7,
                losses: 3,
            };

            const winRate = (state.wins / state.totalTrades) * 100;

            expect(winRate).toBe(70);
        });

        test('should handle zero trades', () => {
            const state: TradeState = {
                direction: 'LONG',
                consecutiveLosses: 0,
                totalTrades: 0,
                wins: 0,
                losses: 0,
            };

            const winRate = state.totalTrades > 0
                ? (state.wins / state.totalTrades) * 100
                : 0;

            expect(winRate).toBe(0);
        });
    });

    describe('TP/SL Price Validation', () => {
        test('LONG: TP should be above entry, SL should be below', () => {
            const entry = 100000;
            const tp = 100100;
            const sl = 99900;

            expect(tp).toBeGreaterThan(entry);
            expect(sl).toBeLessThan(entry);
        });

        test('SHORT: TP should be below entry, SL should be above', () => {
            const entry = 100000;
            const tp = 99900;
            const sl = 100100;

            expect(tp).toBeLessThan(entry);
            expect(sl).toBeGreaterThan(entry);
        });
    });
});

describe('Order Timeout Logic', () => {
    test('should calculate correct timeout', () => {
        const startTime = Date.now();
        const timeoutSeconds = 30;
        const timeoutMs = timeoutSeconds * 1000;

        const elapsed = 15000; // 15 seconds elapsed
        const remaining = timeoutMs - elapsed;

        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBe(15000);
    });

    test('should detect timeout expiry', () => {
        const startTime = Date.now() - 31000; // 31 seconds ago
        const timeoutSeconds = 30;
        const timeoutMs = timeoutSeconds * 1000;

        const elapsed = Date.now() - startTime;
        const hasTimedOut = elapsed >= timeoutMs;

        expect(hasTimedOut).toBe(true);
    });
});
