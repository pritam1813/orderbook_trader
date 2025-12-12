/**
 * Trade record for dashboard tracking
 */
export interface TradeRecord {
    id: string;
    entryTime: number;
    exitTime?: number;
    direction: 'LONG' | 'SHORT';
    entryPrice: number;
    exitPrice?: number;
    quantity: number;
    tpPrice: number;
    slPrice: number;
    result?: 'WIN' | 'LOSS' | 'TIMEOUT';
    pnl?: number;          // P&L before fees
    pnlAfterFees?: number; // P&L after fees
    fees?: number;         // Total fees paid
}

/**
 * Bot status for dashboard
 */
export interface BotStatus {
    isRunning: boolean;
    startTime: number | null;
    direction: 'LONG' | 'SHORT';
    strategy: string;
    currentTrade: TradeRecord | null;
}

/**
 * Trade statistics for dashboard
 */
export interface TradeStats {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalVolume: number;
    totalPnl: number;
    totalFees: number;
    netPnl: number;
    consecutiveLosses: number;
}

/**
 * Fee rates (maker/taker)
 */
export const FEE_RATES = {
    MAKER: 0.0002,  // 0.02%
    TAKER: 0.0005,  // 0.05%
};

/**
 * Calculate trade fees
 * Entry is typically taker (market-like limit that fills immediately)
 * Exit via TP is maker, exit via SL is taker
 */
export function calculateFees(
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    exitType: 'TP' | 'SL' | 'TIMEOUT'
): number {
    const entryNotional = entryPrice * quantity;
    const exitNotional = exitPrice * quantity;

    // Entry is usually taker (fills quickly at market-like price)
    const entryFee = entryNotional * FEE_RATES.MAKER; // Using maker since we place limit orders

    // Exit: TP is maker (limit), SL and TIMEOUT are taker (market)
    const exitFeeRate = exitType === 'TP' ? FEE_RATES.MAKER : FEE_RATES.TAKER;
    const exitFee = exitNotional * exitFeeRate;

    return entryFee + exitFee;
}
