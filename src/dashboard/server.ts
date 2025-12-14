import { getBotState } from '../trading/state';
import { getBotManager } from '../trading/bot-manager';
import { getConfig, saveTradingConfig, type TradingConfig } from '../config';
import { logger, Logger } from '../utils/logger';
import { join } from 'path';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';

const log = logger.child('DASHBOARD');

// Store server reference for log broadcasting
let dashboardServer: ReturnType<typeof Bun.serve> | null = null;

/**
 * Start the dashboard server
 */
export function startDashboard(port: number = 3000): void {
    const publicDir = join(import.meta.dir, 'public');
    const botState = getBotState();

    dashboardServer = Bun.serve({
        port,

        fetch(req, server) {
            const url = new URL(req.url);
            const path = url.pathname;

            // WebSocket upgrade for live logs
            if (path === '/ws/logs') {
                if (server.upgrade(req, { data: {} })) {
                    return;
                }
                return new Response('WebSocket upgrade failed', { status: 400 });
            }

            // API Routes
            if (path.startsWith('/api/')) {
                return handleApiRequest(req, path);
            }

            // Static files
            return serveStaticFile(path, publicDir);
        },

        websocket: {
            open(ws) {
                ws.subscribe('logs');
                log.debug('Dashboard client connected');
            },
            message(_ws, _message) {
                // No incoming messages expected
            },
            close(ws) {
                ws.unsubscribe('logs');
                log.debug('Dashboard client disconnected');
            },
        },

        error(error) {
            log.error('Dashboard server error:', error);
            return new Response('Internal Server Error', { status: 500 });
        },
    });

    // Subscribe state manager to broadcast updates
    botState.on('statusChange', (status) => {
        broadcastToClients({ type: 'status', data: status });
    });
    botState.on('statsChange', (stats) => {
        broadcastToClients({ type: 'stats', data: stats });
    });
    botState.on('tradeComplete', (trade) => {
        broadcastToClients({ type: 'trade', data: trade });
    });

    log.info(`Dashboard running at http://localhost:${port}`);
}

/**
 * Broadcast message to all connected WebSocket clients
 */
export function broadcastToClients(message: object): void {
    if (dashboardServer) {
        dashboardServer.publish('logs', JSON.stringify(message));
    }
}

/**
 * Broadcast log entry to dashboard
 */
export function broadcastLog(level: string, context: string, message: string, data?: object): void {
    broadcastToClients({
        type: 'log',
        data: {
            timestamp: Date.now(),
            level,
            context,
            message,
            data,
        },
    });
}

/**
 * Handle API requests
 */
async function handleApiRequest(req: Request, path: string): Promise<Response> {
    const botState = getBotState();
    const method = req.method;

    // CORS headers
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
        return new Response(null, { headers });
    }

    try {
        switch (path) {
            case '/api/status':
                return Response.json(botState.getStatus(), { headers });

            case '/api/stats':
                return Response.json(botState.getStats(), { headers });

            case '/api/trades':
                return Response.json(botState.trades, { headers });

            case '/api/config':
                if (method === 'GET') {
                    const config = getConfig();
                    return Response.json(config, { headers });
                }
                if (method === 'POST') {
                    const newConfig = await req.json() as Partial<TradingConfig>;
                    const result = saveTradingConfig(newConfig);
                    return Response.json(result, { headers });
                }
                break;

            case '/api/bot/stop':
                if (method === 'POST') {
                    const botManager = getBotManager();
                    const result = await botManager.stopBot();
                    return Response.json(result, { headers });
                }
                break;

            case '/api/bot/start':
                if (method === 'POST') {
                    const botManager = getBotManager();
                    const result = await botManager.startBot();
                    return Response.json(result, { headers });
                }
                break;

            // Volume lookup - get user's trading volume for any symbol
            case '/api/ticker':
                if (method === 'GET') {
                    const url = new URL(req.url);
                    const symbol = url.searchParams.get('symbol')?.toUpperCase();

                    if (!symbol) {
                        return Response.json({ error: 'Symbol parameter required' }, { status: 400, headers });
                    }

                    try {
                        const { getRestClient } = await import('../api/rest');
                        const rest = getRestClient();
                        await rest.syncTime();
                        const trades = await rest.getUserTrades(symbol, 500);

                        // Calculate aggregate stats from user's trades
                        let totalVolume = 0;
                        let totalVolumeUSDT = 0;
                        let totalPnL = 0;
                        let totalFees = 0;
                        let buyVolume = 0;
                        let sellVolume = 0;

                        for (const trade of trades) {
                            const qty = parseFloat(trade.qty);
                            const quoteQty = parseFloat(trade.quoteQty);
                            const pnl = parseFloat(trade.realizedPnl);
                            const fee = parseFloat(trade.commission);

                            totalVolume += qty;
                            totalVolumeUSDT += quoteQty;
                            totalPnL += pnl;
                            totalFees += fee;

                            if (trade.side === 'BUY') {
                                buyVolume += qty;
                            } else {
                                sellVolume += qty;
                            }
                        }

                        return Response.json({
                            symbol,
                            tradeCount: trades.length,
                            totalVolume: totalVolume.toFixed(6),
                            totalVolumeUSDT: totalVolumeUSDT.toFixed(2),
                            buyVolume: buyVolume.toFixed(6),
                            sellVolume: sellVolume.toFixed(6),
                            totalPnL: totalPnL.toFixed(4),
                            totalFees: totalFees.toFixed(4),
                            netPnL: (totalPnL - totalFees).toFixed(4),
                            oldestTrade: trades.length > 0 ? trades[trades.length - 1]?.time : null,
                            newestTrade: trades.length > 0 ? trades[0]?.time : null,
                        }, { headers });
                    } catch (error) {
                        const message = error instanceof Error ? error.message : 'Failed to fetch trades';
                        return Response.json({ error: message }, { status: 500, headers });
                    }
                }
                break;

            case '/api/logs':
                // List all available log files
                if (method === 'GET') {
                    const logsDir = 'logs';
                    if (!existsSync(logsDir)) {
                        return Response.json({ files: [] }, { headers });
                    }

                    const files = readdirSync(logsDir)
                        .filter(file => file.endsWith('.log'))
                        .map(file => {
                            const filePath = join(logsDir, file);
                            const stats = statSync(filePath);
                            return {
                                name: file,
                                size: stats.size,
                                created: stats.birthtime.toISOString(),
                                modified: stats.mtime.toISOString(),
                            };
                        })
                        .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()); // Newest first

                    return Response.json({
                        files,
                        currentLogFile: Logger.getLogFilePath()?.replace(/\\/g, '/')
                    }, { headers });
                }
                break;

            case '/api/logs/download':
                // Download a specific log file
                if (method === 'GET') {
                    const url = new URL(req.url);
                    const fileName = url.searchParams.get('file');

                    if (!fileName) {
                        return Response.json({ error: 'File name required' }, { status: 400, headers });
                    }

                    // Security: Only allow .log files from logs directory
                    if (!fileName.endsWith('.log') || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
                        return Response.json({ error: 'Invalid file name' }, { status: 400, headers });
                    }

                    const filePath = join('logs', fileName);
                    if (!existsSync(filePath)) {
                        return Response.json({ error: 'File not found' }, { status: 404, headers });
                    }

                    const content = readFileSync(filePath, 'utf-8');
                    return new Response(content, {
                        headers: {
                            'Content-Type': 'text/plain; charset=utf-8',
                            'Content-Disposition': `attachment; filename="${fileName}"`,
                            'Access-Control-Allow-Origin': '*',
                        },
                    });
                }
                break;

            default:
                return Response.json({ error: 'Not found' }, { status: 404, headers });
        }
    } catch (error) {
        log.error('API error:', error);
        return Response.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500, headers }
        );
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
}

/**
 * Serve static files from public directory
 */
function serveStaticFile(path: string, publicDir: string): Response {
    // Default to index.html
    let filePath = path === '/' ? '/index.html' : path;
    const fullPath = join(publicDir, filePath);

    // Check if file exists
    const file = Bun.file(fullPath);
    if (existsSync(fullPath)) {
        return new Response(file);
    }

    // Fallback to index.html for SPA routing
    const indexPath = join(publicDir, 'index.html');
    if (existsSync(indexPath)) {
        return new Response(Bun.file(indexPath));
    }

    return new Response('Not Found', { status: 404 });
}
