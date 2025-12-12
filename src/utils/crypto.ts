/**
 * HMAC SHA256 signature generation for Binance API authentication
 */

/**
 * Generate HMAC SHA256 signature
 * @param message The message to sign (query string or request body)
 * @param secret The API secret key
 * @returns The hex-encoded signature
 */
export async function generateSignature(message: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);

    // Import the secret key
    const key = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    // Sign the message
    const signature = await crypto.subtle.sign('HMAC', key, messageData);

    // Convert to hex string
    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Build query string from parameters object
 */
export function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
    const entries = Object.entries(params)
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);

    return entries.join('&');
}

/**
 * Build signed query string with timestamp and signature
 */
export async function buildSignedQueryString(
    params: Record<string, string | number | boolean | undefined>,
    apiSecret: string,
    recvWindow: number = 5000
): Promise<string> {
    // Use timestamp from params if provided (allows server-synced time), otherwise use Date.now()
    const timestamp = params.timestamp ?? Date.now();
    const paramsWithTimestamp = {
        ...params,
        timestamp,
        recvWindow,
    };

    const queryString = buildQueryString(paramsWithTimestamp);
    const signature = await generateSignature(queryString, apiSecret);

    return `${queryString}&signature=${signature}`;
}
