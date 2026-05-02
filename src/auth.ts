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

import { getStorage } from "./storage-interface.js";
import { getTransport } from "./transport.js";
import { getSigning } from "./signing-interface.js";
import type { SolidSettings } from "./settings.js";
import {
    bearerAuthHeader,
    dpopAuthHeader,
    assembleDPoPProofUnsigned,
    base64url,
} from "./auth.pure.js";
import type { JsonWebKey } from "./auth.pure.js";

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
