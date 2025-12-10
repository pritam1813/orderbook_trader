import { logger } from '../utils/logger';
import type { OrderbookLevel, OrderbookState, OrderbookUpdate } from '../types';

const log = logger.child('ORDERBOOK');

/**
 * Orderbook manager that maintains the current state of the orderbook
 * and provides methods to get specific price levels for entry/TP/SL
 */
export class OrderbookManager {
    private state: OrderbookState = {
        bids: [],
        asks: [],
        lastUpdateId: 0,
        timestamp: 0,
    };

    private symbol: string;

    constructor(symbol: string) {
        this.symbol = symbol;
    }

    /**
     * Update orderbook state from WebSocket update
     */
    update(data: OrderbookUpdate): void {
        // Only update if this is a newer message
        if (data.u <= this.state.lastUpdateId) {
            return;
        }

        this.state = {
            bids: data.b,
            asks: data.a,
            lastUpdateId: data.u,
            timestamp: data.E,
        };

        log.debug('Orderbook updated', {
            bids: this.state.bids.length,
            asks: this.state.asks.length,
            updateId: data.u,
        });
    }

    /**
     * Initialize orderbook from snapshot
     */
    initFromSnapshot(bids: OrderbookLevel[], asks: OrderbookLevel[], lastUpdateId: number): void {
        this.state = {
            bids,
            asks,
            lastUpdateId,
            timestamp: Date.now(),
        };

        log.info('Orderbook initialized from snapshot', {
            bids: bids.length,
            asks: asks.length,
        });
    }

    /**
     * Get the current orderbook state
     */
    getState(): OrderbookState {
        return { ...this.state };
    }

    /**
     * Check if orderbook has data
     */
    hasData(): boolean {
        return this.state.bids.length > 0 && this.state.asks.length > 0;
    }

    /**
     * Get the best bid price (highest bid)
     */
    getBestBid(): number | null {
        if (this.state.bids.length === 0) return null;
        return parseFloat(this.state.bids[0]![0]);
    }

    /**
     * Get the best ask price (lowest ask)
     */
    getBestAsk(): number | null {
        if (this.state.asks.length === 0) return null;
        return parseFloat(this.state.asks[0]![0]);
    }

    /**
     * Get bid price at a specific level (1-indexed)
     * Level 1 = best bid (highest), Level 2 = second best, etc.
     */
    getBidAtLevel(level: number): number | null {
        const index = level - 1;
        if (index < 0 || index >= this.state.bids.length) return null;
        return parseFloat(this.state.bids[index]![0]);
    }

    /**
     * Get ask price at a specific level (1-indexed)
     * Level 1 = best ask (lowest), Level 2 = second best, etc.
     */
    getAskAtLevel(level: number): number | null {
        const index = level - 1;
        if (index < 0 || index >= this.state.asks.length) return null;
        return parseFloat(this.state.asks[index]![0]);
    }

    /**
     * Get entry price based on direction
     * LONG: Place buy limit at 2nd bid level (below best bid)
     * SHORT: Place sell limit at 2nd ask level (above best ask)
     */
    getEntryPrice(direction: 'LONG' | 'SHORT', level: number = 2): number | null {
        if (direction === 'LONG') {
            return this.getBidAtLevel(level);
        } else {
            return this.getAskAtLevel(level);
        }
    }

    /**
     * Get take profit price based on direction
     * LONG: TP at higher ask level (e.g., 10th ask - price should be above entry)
     * SHORT: TP at lower bid level (e.g., 10th bid - price should be below entry)
     */
    getTakeProfitPrice(direction: 'LONG' | 'SHORT', level: number = 10): number | null {
        if (direction === 'LONG') {
            // For LONG, TP is at a higher price (asks)
            return this.getAskAtLevel(level);
        } else {
            // For SHORT, TP is at a lower price (bids)
            return this.getBidAtLevel(level);
        }
    }

    /**
     * Get stop loss price based on direction
     * LONG: SL at lower bid level (e.g., 8th bid - price below entry)
     * SHORT: SL at higher ask level (e.g., 8th ask - price above entry)
     */
    getStopLossPrice(direction: 'LONG' | 'SHORT', level: number = 8): number | null {
        if (direction === 'LONG') {
            // For LONG, SL is at a lower price (bids)
            return this.getBidAtLevel(level);
        } else {
            // For SHORT, SL is at a higher price (asks)
            return this.getAskAtLevel(level);
        }
    }

    /**
     * Verify that TP/SL prices are still valid given the current mark price
     * Returns true if prices are valid for order placement
     */
    validateTPSLPrices(
        direction: 'LONG' | 'SHORT',
        entryPrice: number,
        tpPrice: number,
        slPrice: number
    ): { tpValid: boolean; slValid: boolean; reason?: string } {
        if (direction === 'LONG') {
            // LONG: TP should be above entry, SL should be below entry
            const tpValid = tpPrice > entryPrice;
            const slValid = slPrice < entryPrice;

            if (!tpValid || !slValid) {
                return {
                    tpValid,
                    slValid,
                    reason: `LONG: TP=${tpPrice} (should > ${entryPrice}), SL=${slPrice} (should < ${entryPrice})`,
                };
            }
        } else {
            // SHORT: TP should be below entry, SL should be above entry
            const tpValid = tpPrice < entryPrice;
            const slValid = slPrice > entryPrice;

            if (!tpValid || !slValid) {
                return {
                    tpValid,
                    slValid,
                    reason: `SHORT: TP=${tpPrice} (should < ${entryPrice}), SL=${slPrice} (should > ${entryPrice})`,
                };
            }
        }

        return { tpValid: true, slValid: true };
    }

    /**
     * Get mid price (average of best bid and ask)
     */
    getMidPrice(): number | null {
        const bestBid = this.getBestBid();
        const bestAsk = this.getBestAsk();

        if (bestBid === null || bestAsk === null) return null;
        return (bestBid + bestAsk) / 2;
    }

    /**
     * Get spread (difference between best ask and best bid)
     */
    getSpread(): number | null {
        const bestBid = this.getBestBid();
        const bestAsk = this.getBestAsk();

        if (bestBid === null || bestAsk === null) return null;
        return bestAsk - bestBid;
    }

    /**
     * Get spread as percentage of mid price
     */
    getSpreadPercent(): number | null {
        const spread = this.getSpread();
        const midPrice = this.getMidPrice();

        if (spread === null || midPrice === null || midPrice === 0) return null;
        return (spread / midPrice) * 100;
    }
}
