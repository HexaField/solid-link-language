/**
 * Pure DPoP proof generation helpers.
 *
 * Implements the DPoP (Demonstrating Proof-of-Possession) token
 * generation for Solid-OIDC authentication per RFC 9449.
 *
 * Pure functions — no ad4m:host imports.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DPoPProofPayload {
    /** HTTP method (e.g. "GET", "POST") */
    htm: string;
    /** HTTP URI (the target URL, without query/fragment) */
    htu: string;
    /** Issued at (Unix timestamp in seconds) */
    iat: number;
    /** JWT unique identifier */
    jti: string;
}

export interface DPoPHeader {
    typ: "dpop+jwt";
    alg: string;
    jwk: JsonWebKey;
}

export interface JsonWebKey {
    kty: string;
    crv?: string;
    x?: string;
    y?: string;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// DPoP Proof Construction
// ---------------------------------------------------------------------------

/**
 * Build the unsigned DPoP proof payload.
 *
 * @param method HTTP method
 * @param url Target URL
 * @param nonce Optional server-provided nonce
 * @returns DPoP JWT payload as JSON string
 */
export function buildDPoPPayload(
    method: string,
    url: string,
    nonce?: string,
): string {
    const payload: DPoPProofPayload & { nonce?: string } = {
        htm: method,
        htu: stripQueryFragment(url),
        iat: Math.floor(Date.now() / 1000),
        jti: generateJti(),
    };
    if (nonce) {
        payload.nonce = nonce;
    }
    return JSON.stringify(payload);
}

/**
 * Build the DPoP JWT header.
 */
export function buildDPoPHeader(alg: string, jwk: JsonWebKey): string {
    const header: DPoPHeader = {
        typ: "dpop+jwt",
        alg,
        jwk,
    };
    return JSON.stringify(header);
}

/**
 * Assemble a DPoP proof JWT from pre-signed components.
 *
 * The actual signing is done externally (by the signing adapter).
 * This function constructs the unsigned JWT and returns the
 * base64url-encoded header.payload string ready for signing.
 */
export function assembleDPoPProofUnsigned(
    method: string,
    url: string,
    alg: string,
    jwk: JsonWebKey,
    nonce?: string,
): string {
    const header = buildDPoPHeader(alg, jwk);
    const payload = buildDPoPPayload(method, url, nonce);
    const encodedHeader = base64url(header);
    const encodedPayload = base64url(payload);
    return `${encodedHeader}.${encodedPayload}`;
}

/**
 * Build the complete DPoP Authorization header value.
 */
export function dpopAuthHeader(accessToken: string): string {
    return `DPoP ${accessToken}`;
}

/**
 * Build a Bearer Authorization header value.
 */
export function bearerAuthHeader(token: string): string {
    return `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip query string and fragment from a URL.
 */
export function stripQueryFragment(url: string): string {
    const queryIdx = url.indexOf("?");
    const fragIdx = url.indexOf("#");
    let end = url.length;
    if (queryIdx >= 0) end = Math.min(end, queryIdx);
    if (fragIdx >= 0) end = Math.min(end, fragIdx);
    return url.slice(0, end);
}

/**
 * Base64url encode a string (no padding).
 */
export function base64url(input: string): string {
    // Convert string to bytes
    const bytes = new TextEncoder().encode(input);
    // Convert to base64
    let base64 = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let i = 0;
    while (i < bytes.length) {
        const a = bytes[i++] || 0;
        const b = bytes[i++] || 0;
        const c = bytes[i++] || 0;
        const triplet = (a << 16) | (b << 8) | c;
        base64 += chars[(triplet >> 18) & 0x3f];
        base64 += chars[(triplet >> 12) & 0x3f];
        base64 += i - 2 <= bytes.length ? chars[(triplet >> 6) & 0x3f] : "";
        base64 += i - 1 <= bytes.length ? chars[triplet & 0x3f] : "";
    }
    // Convert to base64url
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a unique JTI (JWT ID).
 */
export function generateJti(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 32; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}
