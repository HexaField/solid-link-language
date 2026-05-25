/**
 * Solid-OIDC / DPoP token management.
 *
 * Manages authentication state for Solid Pod access:
 * - Bearer token storage and retrieval
 * - Solid-OIDC token refresh
 * - DPoP keypair management
 * - Auth header generation
 *
 * No ad4m:host imports — uses injected adapters only.
 */

import { getStorage } from "./adapters.js";
import { getTransport } from "./adapters.js";
import { getSigning } from "./adapters.js";
import type { SolidSettings } from "./settings.js";
// ---------------------------------------------------------------------------
// KV Keys
// ---------------------------------------------------------------------------

const TOKEN_KEY = "solid:auth:token";
const TOKEN_EXPIRY_KEY = "solid:auth:token:expiry";
const REFRESH_TOKEN_KEY = "solid:auth:refresh-token";
const DPOP_ALG_KEY = "solid:auth:dpop:alg";
const DPOP_JWK_KEY = "solid:auth:dpop:jwk";
const DPOP_NONCE_KEY = "solid:auth:dpop:nonce";

// ---------------------------------------------------------------------------
// Token Management
// ---------------------------------------------------------------------------

/**
 * Get the current auth token (or null if not set / expired).
 */
export function getAuthToken(settings: SolidSettings): string | null {
    const storage = getStorage();

    if (settings.auth.method === "bearer-token") {
        // Bearer token from settings takes precedence
        if (settings.auth.bearerToken) {
            return settings.auth.bearerToken;
        }
    }

    // Check stored token
    const token = storage.get(TOKEN_KEY);
    if (!token) return null;

    // Check expiry
    const expiryStr = storage.get(TOKEN_EXPIRY_KEY);
    if (expiryStr) {
        const expiry = parseInt(expiryStr, 10);
        if (Date.now() >= expiry) {
            // Token expired
            return null;
        }
    }

    return token;
}

/**
 * Store an access token with optional expiry.
 */
export function storeToken(token: string, expiresInSeconds?: number): void {
    const storage = getStorage();
    storage.put(TOKEN_KEY, token);
    if (expiresInSeconds) {
        const expiry = Date.now() + expiresInSeconds * 1000;
        storage.put(TOKEN_EXPIRY_KEY, expiry.toString());
    }
}

/**
 * Store a refresh token.
 */
export function storeRefreshToken(refreshToken: string): void {
    getStorage().put(REFRESH_TOKEN_KEY, refreshToken);
}

/**
 * Clear all auth state.
 */
export function clearAuth(): void {
    const storage = getStorage();
    storage.delete(TOKEN_KEY);
    storage.delete(TOKEN_EXPIRY_KEY);
    storage.delete(REFRESH_TOKEN_KEY);
    storage.delete(DPOP_ALG_KEY);
    storage.delete(DPOP_JWK_KEY);
    storage.delete(DPOP_NONCE_KEY);
}

// ---------------------------------------------------------------------------
// DPoP Support
// ---------------------------------------------------------------------------

/**
 * Store DPoP keypair information.
 */
export function storeDPoPKeyInfo(alg: string, jwk: JsonWebKey): void {
    const storage = getStorage();
    storage.put(DPOP_ALG_KEY, alg);
    storage.put(DPOP_JWK_KEY, JSON.stringify(jwk));
}

/**
 * Store a server-provided DPoP nonce.
 */
export function storeDPoPNonce(nonce: string): void {
    getStorage().put(DPOP_NONCE_KEY, nonce);
}

/**
 * Get stored DPoP key info.
 */
export function getDPoPKeyInfo(): { alg: string; jwk: JsonWebKey } | null {
    const storage = getStorage();
    const alg = storage.get(DPOP_ALG_KEY);
    const jwkStr = storage.get(DPOP_JWK_KEY);
    if (!alg || !jwkStr) return null;
    return { alg, jwk: JSON.parse(jwkStr) };
}

// ---------------------------------------------------------------------------
// Auth Header Builder
// ---------------------------------------------------------------------------

/**
 * Build the Authorization header for a request.
 *
 * For bearer-token auth: `Bearer {token}`
 * For Solid-OIDC with DPoP: `DPoP {token}` + DPoP proof header
 */
export function buildAuthHeaders(
    settings: SolidSettings,
    method: string,
    url: string,
): Record<string, string> {
    const token = getAuthToken(settings);
    if (!token) return {};

    if (settings.auth.method === "bearer-token") {
        return { "Authorization": bearerAuthHeader(token) };
    }

    // Solid-OIDC with DPoP
    const headers: Record<string, string> = {
        "Authorization": dpopAuthHeader(token),
    };

    const keyInfo = getDPoPKeyInfo();
    if (keyInfo) {
        const nonce = getStorage().get(DPOP_NONCE_KEY) || undefined;
        const unsigned = assembleDPoPProofUnsigned(
            method,
            url,
            keyInfo.alg,
            keyInfo.jwk,
            nonce,
        );
        // Sign with the signing adapter
        const signature = getSigning().signStringHex(unsigned);
        const signatureEncoded = base64url(signature);
        headers["DPoP"] = `${unsigned}.${signatureEncoded}`;
    }

    return headers;
}

// ---------------------------------------------------------------------------
// Token Refresh
// ---------------------------------------------------------------------------

/**
 * Attempt to refresh the access token using the stored refresh token.
 *
 * @param idpUrl Identity Provider URL
 * @param settings Language settings
 * @returns true if refresh succeeded
 */
export async function refreshToken(
    idpUrl: string,
    settings: SolidSettings,
): Promise<boolean> {
    const storage = getStorage();
    const refreshTokenValue = storage.get(REFRESH_TOKEN_KEY);
    if (!refreshTokenValue) return false;

    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshTokenValue,
        client_id: settings.auth.clientId,
        client_secret: settings.auth.clientSecret,
    }).toString();

    const response = await getTransport().fetch(
        `${idpUrl}/token`,
        "POST",
        { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    );

    if (response.status >= 200 && response.status < 300) {
        const data = JSON.parse(response.body);
        storeToken(data.access_token, data.expires_in);
        if (data.refresh_token) {
            storeRefreshToken(data.refresh_token);
        }
        return true;
    }

    return false;
}

/**
 * Check if auth is configured and valid.
 */
export function isAuthenticated(settings: SolidSettings): boolean {
    return getAuthToken(settings) !== null;
}

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
