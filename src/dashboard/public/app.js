/**
 * Trading Bot Dashboard Frontend
 */

// API base URL
const API_BASE = window.location.origin;
const WS_URL = `ws://${window.location.host}/ws/logs`;

// DOM Elements
const elements = {
    statusIndicator: document.getElementById('status-indicator'),
    botStatus: document.getElementById('bot-status'),
    botDirection: document.getElementById('bot-direction'),
    botStrategy: document.getElementById('bot-strategy'),
    botUptime: document.getElementById('bot-uptime'),
    currentTrade: document.getElementById('trade-details'),
    winRate: document.getElementById('win-rate'),
    totalWins: document.getElementById('total-wins'),
    totalLosses: document.getElementById('total-losses'),
    totalTrades: document.getElementById('total-trades'),
    totalVolume: document.getElementById('total-volume'),
    totalPnl: document.getElementById('total-pnl'),
    totalFees: document.getElementById('total-fees'),
    netPnl: document.getElementById('net-pnl'),
    // Micro-grid specific stats
    forceCloseCount: document.getElementById('force-close-count'),
    forceClosePnl: document.getElementById('force-close-pnl'),
    makerFees: document.getElementById('maker-fees'),
    takerFees: document.getElementById('taker-fees'),
    tradesBody: document.getElementById('trades-body'),
    logsContainer: document.getElementById('logs-container'),
    configForm: document.getElementById('config-form'),
    configMessage: document.getElementById('config-message'),
    clearLogs: document.getElementById('clear-logs'),
    autoScroll: document.getElementById('auto-scroll'),
    startBot: document.getElementById('start-bot'),
    stopBot: document.getElementById('stop-bot'),
    stopMessage: document.getElementById('stop-message'),
    logfilesBody: document.getElementById('logfiles-body'),
    refreshLogs: document.getElementById('refresh-logs'),
    currentLog: document.getElementById('current-log'),
};

// State
let ws = null;
let startTime = null;
let uptimeInterval = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadStatus();
    loadStats();
    loadTrades();
    loadConfig();
    connectWebSocket();

    elements.configForm.addEventListener('submit', saveConfig);
    elements.clearLogs.addEventListener('click', clearLogs);
    elements.startBot.addEventListener('click', startBot);
    elements.stopBot.addEventListener('click', stopBot);
    elements.refreshLogs.addEventListener('click', loadLogFiles);

    // Load log files
    loadLogFiles();
});

// API Functions
async function loadStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/status`);
        const status = await res.json();
        updateStatus(status);
    } catch (err) {
        console.error('Failed to load status:', err);
    }
}

async function loadStats() {
    try {
        const res = await fetch(`${API_BASE}/api/stats`);
        const stats = await res.json();
        updateStats(stats);
    } catch (err) {
        console.error('Failed to load stats:', err);
    }
}

async function loadTrades() {
    try {
        const res = await fetch(`${API_BASE}/api/trades`);
        const trades = await res.json();
        updateTrades(trades);
    } catch (err) {
        console.error('Failed to load trades:', err);
    }
}

async function loadConfig() {
    try {
        const res = await fetch(`${API_BASE}/api/config`);
        const config = await res.json();
        populateConfig(config);
    } catch (err) {
        console.error('Failed to load config:', err);
    }
}

async function loadLogFiles() {
    try {
        const res = await fetch(`${API_BASE}/api/logs`);
        const data = await res.json();
        updateLogFiles(data.files, data.currentLogFile);
    } catch (err) {
        console.error('Failed to load log files:', err);
        elements.logfilesBody.innerHTML = '<tr><td colspan="4" class="empty">Failed to load log files</td></tr>';
    }
}

function updateLogFiles(files, currentLogFile) {
    if (!files || files.length === 0) {
        elements.logfilesBody.innerHTML = '<tr><td colspan="4" class="empty">No log files yet</td></tr>';
        elements.currentLog.textContent = '';
        return;
    }

    // Show current log file indicator
    if (currentLogFile) {
        const currentFileName = currentLogFile.split('/').pop().split('\\').pop();
        elements.currentLog.innerHTML = `📝 Current: <strong>${currentFileName}</strong>`;
    }

    elements.logfilesBody.innerHTML = files.map(file => {
        const isCurrentLog = currentLogFile && currentLogFile.includes(file.name);
        const sizeKB = (file.size / 1024).toFixed(1);
        const created = new Date(file.created).toLocaleString();

        return `
            <tr class="${isCurrentLog ? 'current-log-row' : ''}">
                <td>
                    ${isCurrentLog ? '📝 ' : ''}${file.name}
                </td>
                <td>${sizeKB} KB</td>
                <td>${created}</td>
                <td>
                    <button class="btn btn-primary btn-sm" onclick="downloadLogFile('${file.name}')">
                        ⬇️ Download
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

function downloadLogFile(fileName) {
    // Create a link and trigger download
    const link = document.createElement('a');
    link.href = `${API_BASE}/api/logs/download?file=${encodeURIComponent(fileName)}`;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

async function saveConfig(e) {
    e.preventDefault();

    const formData = new FormData(elements.configForm);
    const config = {};

    for (const [key, value] of formData.entries()) {
        // Convert numbers
        if (['quantity', 'leverage', 'entryLevel', 'tpLevel', 'slLevel',
            'riskRewardRatio', 'slDistancePercent', 'orderTimeoutSeconds',
            'tpslMonitorIntervalSeconds', 'directionSwitchLosses', 'spreadGapPercent', 'priceRangePercent',
            'maxPositionMultiplier', 'dailyLossLimitPercent', 'makerFeePercent',
            'minSpreadPercent', 'maxSpreadPercent', 'volatilityLookbackMinutes', 'rollingPriceUpdateTrades'].includes(key)) {
            config[key] = parseFloat(value);
        } else {
            config[key] = value;
        }
    }

    try {
        const res = await fetch(`${API_BASE}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
        });
        const result = await res.json();

        elements.configMessage.textContent = result.message;
        elements.configMessage.className = 'config-message' + (result.success ? '' : ' error');

        setTimeout(() => {
            elements.configMessage.textContent = '';
        }, 5000);
    } catch (err) {
        elements.configMessage.textContent = 'Failed to save config';
        elements.configMessage.className = 'config-message error';
    }
}

// Stop Bot
async function stopBot() {
    elements.stopBot.disabled = true;
    elements.stopBot.textContent = 'Stopping...';

    try {
        const res = await fetch(`${API_BASE}/api/bot/stop`, {
            method: 'POST',
        });
        const result = await res.json();

        elements.stopMessage.textContent = result.message;
        elements.stopMessage.className = 'config-message' + (result.success ? '' : ' error');

        if (!result.success) {
            elements.stopBot.disabled = false;
            elements.stopBot.textContent = '⏹ Stop Bot';
        }

        setTimeout(() => {
            elements.stopMessage.textContent = '';
        }, 5000);
    } catch (err) {
        elements.stopMessage.textContent = 'Failed to stop bot';
        elements.stopMessage.className = 'config-message error';
        elements.stopBot.disabled = false;
        elements.stopBot.textContent = '⏹ Stop Bot';
    }
}

// Start Bot
async function startBot() {
    elements.startBot.disabled = true;
    elements.startBot.textContent = 'Starting...';

    try {
        const res = await fetch(`${API_BASE}/api/bot/start`, {
            method: 'POST',
        });
        const result = await res.json();

        elements.stopMessage.textContent = result.message;
        elements.stopMessage.className = 'config-message' + (result.success ? '' : ' error');

        if (!result.success) {
            elements.startBot.disabled = false;
            elements.startBot.textContent = '▶ Start Bot';
        }

        setTimeout(() => {
            elements.stopMessage.textContent = '';
        }, 5000);
    } catch (err) {
        elements.stopMessage.textContent = 'Failed to start bot';
        elements.stopMessage.className = 'config-message error';
        elements.startBot.disabled = false;
        elements.startBot.textContent = '▶ Start Bot';
    }
}

// WebSocket
function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        elements.statusIndicator.className = 'status-indicator connected';
        elements.statusIndicator.querySelector('.status-text').textContent = 'Connected';
        addLog({ level: 'INFO', context: 'DASHBOARD', message: 'Connected to bot' });
    };

    ws.onclose = () => {
        elements.statusIndicator.className = 'status-indicator disconnected';
        elements.statusIndicator.querySelector('.status-text').textContent = 'Disconnected';
        addLog({ level: 'WARN', context: 'DASHBOARD', message: 'Disconnected from bot' });

        // Reconnect after 3 seconds
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleMessage(message);
        } catch (err) {
            console.error('Failed to parse message:', err);
        }
    };
}

function handleMessage(message) {
    switch (message.type) {
        case 'status':
            updateStatus(message.data);
            break;
        case 'stats':
            updateStats(message.data);
            break;
        case 'trade':
            loadTrades(); // Reload full trade list
            break;
        case 'log':
            addLog(message.data);
            break;
    }
}

// UI Update Functions
function updateStatus(status) {
    elements.botStatus.textContent = status.isRunning ? '🟢 Running' : '🔴 Stopped';
    elements.botDirection.textContent = status.direction;
    elements.botDirection.className = 'stat-value ' + (status.direction === 'LONG' ? 'win' : 'loss');
    elements.botStrategy.textContent = status.strategy;

    // Update button states
    if (status.isRunning) {
        elements.startBot.disabled = true;
        elements.startBot.textContent = '▶ Start Bot';
        elements.stopBot.disabled = false;
        elements.stopBot.textContent = '⏹ Stop Bot';
    } else {
        elements.startBot.disabled = false;
        elements.startBot.textContent = '▶ Start Bot';
        elements.stopBot.disabled = true;
        elements.stopBot.textContent = '⏹ Stop Bot';
    }

    // Update uptime
    if (status.isRunning && status.startTime) {
        startTime = status.startTime;
        if (!uptimeInterval) {
            uptimeInterval = setInterval(updateUptime, 1000);
        }
    } else {
        startTime = null;
        if (uptimeInterval) {
            clearInterval(uptimeInterval);
            uptimeInterval = null;
        }
        elements.botUptime.textContent = '--';
    }

    // Current trade
    if (status.currentTrade) {
        const t = status.currentTrade;
        elements.currentTrade.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;">
                <div><strong>Direction:</strong> ${t.direction}</div>
                <div><strong>Entry:</strong> $${t.entryPrice.toFixed(2)}</div>
                <div><strong>TP:</strong> $${t.tpPrice.toFixed(2)}</div>
                <div><strong>SL:</strong> $${t.slPrice.toFixed(2)}</div>
            </div>
        `;
    } else {
        elements.currentTrade.textContent = 'No active trade';
    }
}

function updateUptime() {
    if (!startTime) return;

    const elapsed = Date.now() - startTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);

    elements.botUptime.textContent = `${hours}h ${minutes}m ${seconds}s`;
}

function updateStats(stats) {
    elements.winRate.textContent = `${stats.winRate.toFixed(1)}%`;
    elements.totalWins.textContent = stats.wins;
    elements.totalLosses.textContent = stats.losses;
    elements.totalTrades.textContent = stats.totalTrades;
    elements.totalVolume.textContent = formatCurrency(stats.totalVolume);
    elements.totalPnl.textContent = formatPnl(stats.totalPnl);
    elements.totalFees.textContent = formatCurrency(stats.totalFees);
    elements.netPnl.textContent = formatPnl(stats.netPnl);

    // Color net P&L
    elements.netPnl.className = 'stat-value ' + (stats.netPnl >= 0 ? 'win' : 'loss');
    elements.totalPnl.className = 'stat-value ' + (stats.totalPnl >= 0 ? 'win' : 'loss');

    // Micro-grid specific stats
    if (elements.forceCloseCount) {
        elements.forceCloseCount.textContent = stats.forceCloseCount || 0;
    }
    if (elements.forceClosePnl) {
        const fcPnl = stats.forceClosePnL || 0;
        elements.forceClosePnl.textContent = formatPnl(fcPnl);
        elements.forceClosePnl.className = 'stat-value ' + (fcPnl >= 0 ? 'win' : 'loss');
    }
    if (elements.makerFees) {
        elements.makerFees.textContent = formatCurrency(stats.makerFees || 0);
    }
    if (elements.takerFees) {
        elements.takerFees.textContent = formatCurrency(stats.takerFees || 0);
    }
}

function updateTrades(trades) {
    if (!trades || trades.length === 0) {
        elements.tradesBody.innerHTML = '<tr><td colspan="9" class="empty">No trades yet</td></tr>';
        return;
    }

    elements.tradesBody.innerHTML = trades.map(t => `
        <tr>
            <td>${formatTime(t.entryTime)}</td>
            <td><span class="badge ${t.direction.toLowerCase()}">${t.direction}</span></td>
            <td>$${t.entryPrice.toFixed(2)}</td>
            <td>${t.exitPrice ? '$' + t.exitPrice.toFixed(2) : '--'}</td>
            <td>${t.quantity}</td>
            <td><span class="badge ${t.result?.toLowerCase()}">${t.result || '--'}</span></td>
            <td class="${t.pnl >= 0 ? 'win' : 'loss'}">${formatPnl(t.pnl)}</td>
            <td class="fee">${formatCurrency(t.fees || 0)}</td>
            <td class="${t.pnlAfterFees >= 0 ? 'win' : 'loss'}">${formatPnl(t.pnlAfterFees)}</td>
        </tr>
    `).join('');
}

function populateConfig(config) {
    document.getElementById('cfg-symbol').value = config.symbol || '';
    document.getElementById('cfg-quantity').value = config.quantity || '';
    document.getElementById('cfg-leverage').value = config.leverage || '';
    document.getElementById('cfg-strategy').value = config.strategy || 'orderbook';
    document.getElementById('cfg-direction').value = config.initialDirection || 'LONG';
    document.getElementById('cfg-switch-losses').value = config.directionSwitchLosses || '';
    document.getElementById('cfg-entry-level').value = config.entryLevel || '';
    document.getElementById('cfg-tp-level').value = config.tpLevel || '';
    document.getElementById('cfg-sl-level').value = config.slLevel || '';
    document.getElementById('cfg-rr-ratio').value = config.riskRewardRatio || '';
    document.getElementById('cfg-sl-percent').value = config.slDistancePercent || '';
    document.getElementById('cfg-timeout').value = config.orderTimeoutSeconds || '';
    document.getElementById('cfg-monitor-interval').value = config.tpslMonitorIntervalSeconds || '';

    // Micro-Grid Strategy
    document.getElementById('cfg-spread-gap').value = config.spreadGapPercent || '';
    document.getElementById('cfg-min-spread').value = config.minSpreadPercent || '';
    document.getElementById('cfg-max-spread').value = config.maxSpreadPercent || '';
    document.getElementById('cfg-price-range').value = config.priceRangePercent || '';
    document.getElementById('cfg-volatility-lookback').value = config.volatilityLookbackMinutes || '';
    document.getElementById('cfg-rolling-update').value = config.rollingPriceUpdateTrades || '';

    // Micro-Grid Risk Management
    document.getElementById('cfg-max-pos-mult').value = config.maxPositionMultiplier || '';
    document.getElementById('cfg-daily-loss').value = config.dailyLossLimitPercent || '';
    document.getElementById('cfg-maker-fee').value = config.makerFeePercent || '';
}

function addLog(log) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const time = log.timestamp ? formatLogTime(log.timestamp) : formatLogTime(Date.now());
    const data = log.data ? JSON.stringify(log.data) : '';

    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-level ${log.level}">${log.level}</span>
        <span class="log-context">[${log.context}]</span>
        <span class="log-message">${escapeHtml(log.message)}</span>
        ${data ? `<span class="log-data">${escapeHtml(data)}</span>` : ''}
    `;

    elements.logsContainer.appendChild(entry);

    // Limit log entries
    while (elements.logsContainer.children.length > 500) {
        elements.logsContainer.removeChild(elements.logsContainer.firstChild);
    }

    // Auto-scroll
    if (elements.autoScroll.checked) {
        elements.logsContainer.scrollTop = elements.logsContainer.scrollHeight;
    }
}

function clearLogs() {
    elements.logsContainer.innerHTML = '';
}

// Utility Functions
function formatCurrency(value) {
    if (value === undefined || value === null) return '$0.00';
    return '$' + value.toFixed(2);
}

function formatPnl(value) {
    if (value === undefined || value === null) return '$0.00';
    const prefix = value >= 0 ? '+$' : '-$';
    return prefix + Math.abs(value).toFixed(4);
}

function formatTime(timestamp) {
    if (!timestamp) return '--';
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
}

function formatLogTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour12: false });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
