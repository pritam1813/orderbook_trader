import { getConfig, getEndpoints } from '../config';
import { logger } from '../utils/logger';
import {
    OrderbookUpdateSchema,
    OrderUpdateEventSchema,
    type OrderbookUpdate,
    type OrderUpdateEvent,
} from '../types';

const log = logger.child('WS');

type MessageHandler<T> = (data: T) => void;
type ErrorHandler = (error: Error) => void;
type CloseHandler = () => void;

interface WebSocketOptions {
    onMessage?: MessageHandler<unknown>;
    onError?: ErrorHandler;
    onClose?: CloseHandler;
    onOpen?: () => void;
    reconnect?: boolean;
    reconnectDelay?: number;
}

/**
 * Base WebSocket client with auto-reconnect
 */
export class BaseWebSocket {
    protected ws: WebSocket | null = null;
    protected url: string;
    protected options: WebSocketOptions;
    protected isConnected: boolean = false;
    protected shouldReconnect: boolean = true;
    protected reconnectAttempts: number = 0;
    protected maxReconnectAttempts: number = 10;
    protected pingInterval: ReturnType<typeof setInterval> | null = null;

    constructor(url: string, options: WebSocketOptions = {}) {
        this.url = url;
        this.options = {
            reconnect: true,
            reconnectDelay: 5000,
            ...options,
        };
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                log.info('Connecting to WebSocket', { url: this.url.substring(0, 80) + '...' });

                this.ws = new WebSocket(this.url);

                this.ws.onopen = () => {
                    log.info('WebSocket connected');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.startPingInterval();
                    this.options.onOpen?.();
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this.handleMessage(data);
                    } catch (error) {
                        log.error('Failed to parse WebSocket message', { error });
                    }
                };

                this.ws.onerror = (event) => {
                    log.error('WebSocket error', { event });
                    const error = new Error('WebSocket error');
                    this.options.onError?.(error);
                    if (!this.isConnected) {
                        reject(error);
                    }
                };

                this.ws.onclose = () => {
                    log.warn('WebSocket closed');
                    this.isConnected = false;
                    this.stopPingInterval();
                    this.options.onClose?.();

                    if (this.shouldReconnect && this.options.reconnect) {
                        this.attemptReconnect();
                    }
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    protected handleMessage(data: unknown): void {
        this.options.onMessage?.(data);
    }

    private startPingInterval(): void {
        // Send pong frames every 5 minutes to keep connection alive
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                // Binance expects pong frames in response to pings
                // The WebSocket implementation handles this automatically
                log.debug('Connection alive check');
            }
        }, 5 * 60 * 1000);
    }

    private stopPingInterval(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    private async attemptReconnect(): Promise<void> {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            log.error('Max reconnect attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.options.reconnectDelay! * this.reconnectAttempts;

        log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            await this.connect();
        } catch (error) {
            log.error('Reconnection failed', { error });
        }
    }

    send(data: unknown): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        } else {
            log.warn('Cannot send - WebSocket not connected');
        }
    }

    close(): void {
        this.shouldReconnect = false;
        this.stopPingInterval();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }

    get connected(): boolean {
        return this.isConnected;
    }
}

/**
 * WebSocket client for orderbook depth stream
 */
export class OrderbookWebSocket extends BaseWebSocket {
    private symbol: string;
    private onOrderbookUpdate: MessageHandler<OrderbookUpdate>;

    constructor(symbol: string, onUpdate: MessageHandler<OrderbookUpdate>) {
        const config = getConfig();
        const endpoints = getEndpoints(config.useTestnet);
        const streamName = `${symbol.toLowerCase()}@depth20@100ms`;
        const url = `${endpoints.wsBaseUrl}/ws/${streamName}`;

        super(url);
        this.symbol = symbol;
        this.onOrderbookUpdate = onUpdate;
    }

    protected override handleMessage(data: unknown): void {
        const parsed = OrderbookUpdateSchema.safeParse(data);
        if (parsed.success) {
            this.onOrderbookUpdate(parsed.data);
        } else {
            log.debug('Non-orderbook message received', { data });
        }
    }
}

/**
 * WebSocket client for user data stream
 */
export class UserDataWebSocket extends BaseWebSocket {
    private onOrderUpdate: MessageHandler<OrderUpdateEvent>;
    private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
    private keepAliveCallback: () => Promise<void>;

    constructor(
        listenKey: string,
        onOrderUpdate: MessageHandler<OrderUpdateEvent>,
        keepAliveCallback: () => Promise<void>
    ) {
        const config = getConfig();
        const endpoints = getEndpoints(config.useTestnet);
        const url = `${endpoints.wsBaseUrl}/ws/${listenKey}`;

        super(url);
        this.onOrderUpdate = onOrderUpdate;
        this.keepAliveCallback = keepAliveCallback;
    }

    override async connect(): Promise<void> {
        await super.connect();
        this.startKeepAlive();
    }

    protected override handleMessage(data: unknown): void {
        // Check if it's an order update event
        if (typeof data === 'object' && data !== null && 'e' in data) {
            const eventData = data as { e: string };

            if (eventData.e === 'ORDER_TRADE_UPDATE') {
                const parsed = OrderUpdateEventSchema.safeParse(data);
                if (parsed.success) {
                    this.onOrderUpdate(parsed.data);
                } else {
                    log.warn('Failed to parse order update', { error: parsed.error });
                }
            } else {
                log.debug('User data event received', { type: eventData.e });
            }
        }
    }

    private startKeepAlive(): void {
        // Keep listen key alive every 30 minutes
        this.keepAliveInterval = setInterval(async () => {
            try {
                await this.keepAliveCallback();
                log.debug('Listen key kept alive');
            } catch (error) {
                log.error('Failed to keep listen key alive', { error });
            }
        }, 30 * 60 * 1000);
    }

    override close(): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        super.close();
    }
}

/**
 * Combined WebSocket manager for both orderbook and user data streams
 */
export class WebSocketManager {
    private orderbookWs: OrderbookWebSocket | null = null;
    private userDataWs: UserDataWebSocket | null = null;

    async connectOrderbook(
        symbol: string,
        onUpdate: MessageHandler<OrderbookUpdate>
    ): Promise<void> {
        this.orderbookWs = new OrderbookWebSocket(symbol, onUpdate);
        await this.orderbookWs.connect();
    }

    async connectUserData(
        listenKey: string,
        onOrderUpdate: MessageHandler<OrderUpdateEvent>,
        keepAliveCallback: () => Promise<void>
    ): Promise<void> {
        this.userDataWs = new UserDataWebSocket(listenKey, onOrderUpdate, keepAliveCallback);
        await this.userDataWs.connect();
    }

    closeAll(): void {
        this.orderbookWs?.close();
        this.userDataWs?.close();
        this.orderbookWs = null;
        this.userDataWs = null;
    }

    get orderbookConnected(): boolean {
        return this.orderbookWs?.connected ?? false;
    }

    get userDataConnected(): boolean {
        return this.userDataWs?.connected ?? false;
    }
}
