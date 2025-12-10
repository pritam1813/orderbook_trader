# Binance Orderbook Scalping Bot

A high-frequency scalping bot for Binance USDT-M Futures that trades based on live orderbook data.

## Features

- **Orderbook-based entry**: Places limit orders at the 2nd price level
- **Dynamic TP/SL**: Uses orderbook levels for take profit and stop loss (configurable)
- **Direction switching**: Automatically switches direction after consecutive losses
- **Robust order handling**: Retry logic for TP/SL placement in volatile conditions
- **WebSocket-based**: Real-time orderbook and order updates

## Quick Start

1. Install dependencies:
```bash
bun install
```

2. Copy `.env.example` to `.env` and add your API keys:
```bash
cp .env.example .env
```

3. Run tests to verify setup:
```bash
bun test
```

4. Start the bot:
```bash
bun run start
```

## Configuration

All configuration is done via environment variables (see `.env.example`):

| Variable | Description | Default |
|----------|-------------|---------|
| `BINANCE_API_KEY` | Your Binance Futures API key | - |
| `BINANCE_API_SECRET` | Your Binance Futures API secret | - |
| `USE_TESTNET` | Use testnet instead of mainnet | `true` |
| `SYMBOL` | Trading pair | `BTCUSDT` |
| `QUANTITY` | Order quantity | `0.001` |
| `INITIAL_DIRECTION` | Starting direction (LONG/SHORT) | `LONG` |
| `ENTRY_LEVEL` | Orderbook level for entry | `2` |
| `TP_LEVEL` | Orderbook level for take profit | `10` |
| `SL_LEVEL` | Orderbook level for stop loss | `8` |
| `ORDER_TIMEOUT_SECONDS` | Seconds to wait for limit order fill | `30` |
| `DIRECTION_SWITCH_LOSSES` | Consecutive losses before switching direction | `3` |

## Project Structure

```
src/
├── config/          # Configuration & environment
├── types/           # TypeScript types and Zod schemas
├── api/             # REST and WebSocket clients
├── services/        # Orderbook, orders, user stream
├── trading/         # Main bot logic
├── utils/           # Crypto, logging utilities
└── tests/           # Test files
```

## Testing

```bash
# Run all tests
bun test

# Run specific test suite
bun test:api
bun test:orderbook
bun test:trading
```

## License

MIT
