import { EventEmitter } from 'events';
import type { TradeRecord, BotStatus, TradeStats } from '../types/trade';
import { calculateFees } from '../types/trade';
import { getConfig } from '../config';

/**
 * Global bot state manager for dashboard integration
 * Singleton pattern for easy access from dashboard server
 */
class BotStateManager extends EventEmitter {
    private _isRunning: boolean = false;
    private _startTime: number | null = null;
    private _direction: 'LONG' | 'SHORT' = 'LONG';
    private _currentTrade: TradeRecord | null = null;
    private _trades: TradeRecord[] = [];
    private _consecutiveLosses: number = 0;

    // Stats
    private _totalWins: number = 0;
    private _totalLosses: number = 0;
    private _totalVolume: number = 0;
    private _totalPnl: number = 0;
    private _totalFees: number = 0;

    // Micro-grid specific stats
    private _forceCloseCount: number = 0;
    private _forceClosePnL: number = 0;
    private _takerFees: number = 0;

    constructor() {
        super();
        const config = getConfig();
        this._direction = config.initialDirection;
    }

    // Getters
    get isRunning(): boolean { return this._isRunning; }
    get direction(): 'LONG' | 'SHORT' { return this._direction; }
    get currentTrade(): TradeRecord | null { return this._currentTrade; }
    get trades(): TradeRecord[] { return this._trades; }
    get consecutiveLosses(): number { return this._consecutiveLosses; }

    /**
     * Get bot status for dashboard
     */
    getStatus(): BotStatus {
        const config = getConfig();
        return {
            isRunning: this._isRunning,
            startTime: this._startTime,
            direction: this._direction,
            strategy: config.strategy,
            currentTrade: this._currentTrade,
        };
    }

    /**
     * Get trade statistics for dashboard
     */
    getStats(): TradeStats {
        const totalTrades = this._totalWins + this._totalLosses;
        return {
            totalTrades,
            wins: this._totalWins,
            losses: this._totalLosses,
            winRate: totalTrades > 0 ? (this._totalWins / totalTrades) * 100 : 0,
            totalVolume: this._totalVolume,
            totalPnl: this._totalPnl,
            totalFees: this._totalFees,
            netPnl: this._totalPnl - this._totalFees,
            consecutiveLosses: this._consecutiveLosses,
            // Micro-grid specific
            forceCloseCount: this._forceCloseCount,
            forceClosePnL: this._forceClosePnL,
            takerFees: this._takerFees,
            makerFees: this._totalFees - this._takerFees,
        };
    }

    /**
     * Set bot running state
     */
    setRunning(running: boolean): void {
        this._isRunning = running;
        if (running) {
            this._startTime = Date.now();
        }
        this.emit('statusChange', this.getStatus());
    }

    /**
     * Set current direction
     */
    setDirection(direction: 'LONG' | 'SHORT'): void {
        this._direction = direction;
        this.emit('statusChange', this.getStatus());
    }

    /**
     * Start a new trade
     */
    startTrade(trade: Omit<TradeRecord, 'id'>): string {
        const id = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this._currentTrade = { id, ...trade };
        this._totalVolume += trade.entryPrice * trade.quantity;
        this.emit('tradeStart', this._currentTrade);
        this.emit('statusChange', this.getStatus());
        return id;
    }

    /**
     * Complete current trade
     */
    completeTrade(
        exitPrice: number,
        result: 'WIN' | 'LOSS' | 'TIMEOUT'
    ): TradeRecord | null {
        if (!this._currentTrade) return null;

        const trade = this._currentTrade;
        trade.exitTime = Date.now();
        trade.exitPrice = exitPrice;
        trade.result = result;

        // Calculate P&L
        const priceDiff = trade.direction === 'LONG'
            ? exitPrice - trade.entryPrice
            : trade.entryPrice - exitPrice;
        trade.pnl = priceDiff * trade.quantity;

        // Calculate fees
        const exitType = result === 'WIN' ? 'TP' : result === 'LOSS' ? 'SL' : 'TIMEOUT';
        trade.fees = calculateFees(trade.entryPrice, exitPrice, trade.quantity, exitType);
        trade.pnlAfterFees = trade.pnl - trade.fees;

        // Update stats
        this._totalPnl += trade.pnl;
        this._totalFees += trade.fees;
        this._totalVolume += exitPrice * trade.quantity;

        if (result === 'WIN') {
            this._totalWins++;
            this._consecutiveLosses = 0;
        } else {
            this._totalLosses++;
            this._consecutiveLosses++;
        }

        // Add to history
        this._trades.unshift(trade);
        if (this._trades.length > 100) {
            this._trades.pop(); // Keep last 100 trades
        }

        this._currentTrade = null;

        this.emit('tradeComplete', trade);
        this.emit('statusChange', this.getStatus());
        this.emit('statsChange', this.getStats());

        return trade;
    }

    /**
     * Reset consecutive losses (after direction switch)
     */
    resetConsecutiveLosses(): void {
        this._consecutiveLosses = 0;
        this.emit('statsChange', this.getStats());
    }

    /**
     * Record a force close (market order to close position)
     * Used by micro-grid strategy when closing due to out-of-range or circuit breaker
     */
    addForceClose(params: {
        direction: 'LONG' | 'SHORT';
        entryPrice: number;
        exitPrice: number;
        quantity: number;
        grossPnL: number;
        takerFee: number;
        netPnL: number;
        reason: 'OUT_OF_RANGE' | 'CIRCUIT_BREAKER' | 'MANUAL_STOP';
    }): void {
        const { direction, entryPrice, exitPrice, quantity, grossPnL, takerFee, netPnL, reason } = params;

        // Update force close specific stats
        this._forceCloseCount++;
        this._forceClosePnL += netPnL;
        this._takerFees += takerFee;

        // Update overall stats
        this._totalPnl += grossPnL;
        this._totalFees += takerFee;
        this._totalVolume += exitPrice * quantity;

        // Count as loss if negative P&L
        if (netPnL < 0) {
            this._totalLosses++;
            this._consecutiveLosses++;
        } else if (netPnL > 0) {
            this._totalWins++;
            this._consecutiveLosses = 0;
        }

        // Create trade record
        const trade: TradeRecord = {
            id: `force_close_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            entryTime: Date.now() - 1000,
            exitTime: Date.now(),
            direction,
            entryPrice,
            exitPrice,
            quantity,
            tpPrice: 0,
            slPrice: 0,
            result: netPnL >= 0 ? 'WIN' : 'LOSS',
            pnl: grossPnL,
            pnlAfterFees: netPnL,
            fees: takerFee,
        };

        // Add to history
        this._trades.unshift(trade);
        if (this._trades.length > 100) {
            this._trades.pop();
        }

        this.emit('tradeComplete', trade);
        this.emit('statsChange', this.getStats());
    }
}

// Singleton instance
let instance: BotStateManager | null = null;

export function getBotState(): BotStateManager {
    if (!instance) {
        instance = new BotStateManager();
    }
    return instance;
}
