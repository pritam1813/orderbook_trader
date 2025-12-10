import { getRestClient } from '../api/rest';
import { UserDataWebSocket } from '../api/websocket';
import { logger } from '../utils/logger';
import type { OrderUpdateEvent } from '../types';

const log = logger.child('USER_STREAM');

export type OrderEventType =
    | 'entry_filled'
    | 'entry_canceled'
    | 'tp_filled'
    | 'sl_filled'
    | 'order_update';

export interface OrderEvent {
    type: OrderEventType;
    orderId: number;
    clientOrderId: string;
    status: string;
    executionType: string;
    side: string;
    orderType: string;
    quantity: string;
    price: string;
    avgPrice: string;
    realizedProfit?: string;
    raw: OrderUpdateEvent;
}

type OrderEventHandler = (event: OrderEvent) => void;

/**
 * User stream service for managing user data WebSocket and order events
 */
export class UserStreamService {
    private ws: UserDataWebSocket | null = null;
    private listenKey: string | null = null;
    private handlers: Map<OrderEventType | 'all', OrderEventHandler[]> = new Map();

    // Track order IDs to identify order types
    private entryOrderId: number | null = null;
    private tpOrderId: number | null = null;
    private slOrderId: number | null = null;

    /**
     * Initialize and connect to user data stream
     */
    async connect(): Promise<void> {
        const client = getRestClient();

        // Create listen key
        const { listenKey } = await client.createListenKey();
        this.listenKey = listenKey;

        log.info('Listen key created', { listenKey: listenKey.substring(0, 20) + '...' });

        // Connect to WebSocket
        this.ws = new UserDataWebSocket(
            listenKey,
            this.handleOrderUpdate.bind(this),
            async () => {
                await client.keepAliveListenKey();
            }
        );

        await this.ws.connect();
        log.info('User data stream connected');
    }

    /**
     * Disconnect from user data stream
     */
    async disconnect(): Promise<void> {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        if (this.listenKey) {
            try {
                const client = getRestClient();
                await client.closeListenKey();
            } catch (error) {
                log.warn('Failed to close listen key', { error });
            }
            this.listenKey = null;
        }

        log.info('User data stream disconnected');
    }

    /**
     * Set the current entry order ID to track
     */
    setEntryOrderId(orderId: number): void {
        this.entryOrderId = orderId;
    }

    /**
     * Set the current TP order ID to track
     */
    setTpOrderId(orderId: number): void {
        this.tpOrderId = orderId;
    }

    /**
     * Set the current SL order ID to track
     */
    setSlOrderId(orderId: number): void {
        this.slOrderId = orderId;
    }

    /**
     * Clear all tracked order IDs
     */
    clearOrderIds(): void {
        this.entryOrderId = null;
        this.tpOrderId = null;
        this.slOrderId = null;
    }

    /**
     * Subscribe to order events
     */
    on(eventType: OrderEventType | 'all', handler: OrderEventHandler): void {
        const existing = this.handlers.get(eventType) || [];
        this.handlers.set(eventType, [...existing, handler]);
    }

    /**
     * Unsubscribe from order events
     */
    off(eventType: OrderEventType | 'all', handler: OrderEventHandler): void {
        const existing = this.handlers.get(eventType) || [];
        this.handlers.set(eventType, existing.filter(h => h !== handler));
    }

    /**
     * Handle incoming order update from WebSocket
     */
    private handleOrderUpdate(update: OrderUpdateEvent): void {
        const order = update.o;

        const event: OrderEvent = {
            type: 'order_update',
            orderId: order.i,
            clientOrderId: order.c,
            status: order.X,
            executionType: order.x,
            side: order.S,
            orderType: order.o,
            quantity: order.q,
            price: order.p,
            avgPrice: order.ap,
            realizedProfit: order.rp,
            raw: update,
        };

        // Log ALL order updates at INFO level for debugging
        log.info('Order update received', {
            orderId: order.i,
            status: order.X,
            type: order.o,
            execution: order.x,
            trackedEntryId: this.entryOrderId,
            trackedTpId: this.tpOrderId,
            trackedSlId: this.slOrderId,
        });

        // Determine event type based on order ID and status
        if (order.i === this.entryOrderId) {
            if (order.X === 'FILLED') {
                event.type = 'entry_filled';
                log.trade('ENTRY_FILLED', { orderId: order.i, avgPrice: order.ap });
            } else if (order.X === 'CANCELED' || order.X === 'EXPIRED') {
                event.type = 'entry_canceled';
                log.trade('ENTRY_CANCELED', { orderId: order.i });
            }
        } else if (order.i === this.tpOrderId) {
            if (order.X === 'FILLED') {
                event.type = 'tp_filled';
                log.trade('TP_FILLED', {
                    orderId: order.i,
                    avgPrice: order.ap,
                    realizedProfit: order.rp,
                });
            }
        } else if (order.i === this.slOrderId) {
            if (order.X === 'FILLED') {
                event.type = 'sl_filled';
                log.trade('SL_FILLED', {
                    orderId: order.i,
                    avgPrice: order.ap,
                    realizedProfit: order.rp,
                });
            }
        }

        // Emit to specific handlers
        const handlers = this.handlers.get(event.type) || [];
        for (const handler of handlers) {
            try {
                handler(event);
            } catch (error) {
                log.error('Error in order event handler', { error, eventType: event.type });
            }
        }

        // Emit to 'all' handlers
        const allHandlers = this.handlers.get('all') || [];
        for (const handler of allHandlers) {
            try {
                handler(event);
            } catch (error) {
                log.error('Error in order event handler', { error });
            }
        }
    }

    /**
     * Wait for a specific event type with timeout
     */
    waitForEvent(
        eventTypes: OrderEventType[],
        timeoutMs: number = 60000
    ): Promise<OrderEvent | null> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                resolve(null);
            }, timeoutMs);

            const handler = (event: OrderEvent) => {
                if (eventTypes.includes(event.type)) {
                    cleanup();
                    resolve(event);
                }
            };

            const cleanup = () => {
                clearTimeout(timeout);
                this.off('all', handler);
            };

            this.on('all', handler);
        });
    }
}
