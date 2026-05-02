/**
 * Tests for auth token management and DPoP proof generation.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
    buildDPoPPayload,
    buildDPoPHeader,
    assembleDPoPProofUnsigned,
    dpopAuthHeader,
    bearerAuthHeader,
    stripQueryFragment,
    base64url,
    generateJti,
} from "../src/auth.pure.js";
import type { JsonWebKey } from "../src/auth.pure.js";

import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { SigningAdapter } from "../src/signing-interface.js";
import { initSigning } from "../src/signing-interface.js";

import {
    getAuthToken,
    storeToken,
    storeRefreshToken,
    clearAuth,
    storeDPoPKeyInfo,
    storeDPoPNonce,
    getDPoPKeyInfo,
    isAuthenticated,
    buildAuthHeaders,
} from "../src/auth.js";
import type { SolidSettings } from "../src/settings.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

// ---------------------------------------------------------------------------
// Mock adapters
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        return [...this.data.keys()].filter(k => !prefix || k.startsWith(prefix));
    }
}

class MockSigning implements SigningAdapter {
    signStringHex(payload: string): string { return "mocksig" + payload.length; }
    signingKeyId(): string { return "mock-key"; }
}

// ---------------------------------------------------------------------------
// Pure tests
// ---------------------------------------------------------------------------

describe("DPoP pure helpers", () => {
    it("buildDPoPPayload produces valid JSON with required fields", () => {
        const payload = JSON.parse(buildDPoPPayload("GET", "https://pod.example.com/resource"));
        assert.equal(payload.htm, "GET");
        assert.equal(payload.htu, "https://pod.example.com/resource");
        assert.ok(typeof payload.iat === "number");
        assert.ok(typeof payload.jti === "string");
    });

    it("buildDPoPPayload strips query and fragment from htu", () => {
        const payload = JSON.parse(buildDPoPPayload("POST", "https://pod.example.com/resource?foo=bar#frag"));
        assert.equal(payload.htu, "https://pod.example.com/resource");
    });

    it("buildDPoPPayload includes nonce when provided", () => {
        const payload = JSON.parse(buildDPoPPayload("GET", "https://pod.example.com/r", "server-nonce"));
        assert.equal(payload.nonce, "server-nonce");
    });

    it("buildDPoPHeader produces correct structure", () => {
        const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: "x", y: "y" };
        const header = JSON.parse(buildDPoPHeader("ES256", jwk));
        assert.equal(header.typ, "dpop+jwt");
        assert.equal(header.alg, "ES256");
        assert.deepEqual(header.jwk, jwk);
    });

    it("assembleDPoPProofUnsigned produces header.payload format", () => {
        const jwk: JsonWebKey = { kty: "EC", crv: "P-256" };
        const proof = assembleDPoPProofUnsigned("GET", "https://example.com", "ES256", jwk);
        const parts = proof.split(".");
        assert.equal(parts.length, 2);
    });

    it("dpopAuthHeader prefixes with DPoP", () => {
        assert.equal(dpopAuthHeader("token123"), "DPoP token123");
    });

    it("bearerAuthHeader prefixes with Bearer", () => {
        assert.equal(bearerAuthHeader("token123"), "Bearer token123");
    });

    it("stripQueryFragment removes query string", () => {
        assert.equal(stripQueryFragment("https://example.com/p?q=1"), "https://example.com/p");
    });

    it("stripQueryFragment removes fragment", () => {
        assert.equal(stripQueryFragment("https://example.com/p#frag"), "https://example.com/p");
    });

    it("stripQueryFragment handles both", () => {
        assert.equal(stripQueryFragment("https://example.com/p?q=1#f"), "https://example.com/p");
    });

    it("base64url produces url-safe encoding", () => {
        const encoded = base64url("hello world!");
        assert.ok(!encoded.includes("+"));
        assert.ok(!encoded.includes("/"));
        assert.ok(!encoded.includes("="));
    });

    it("generateJti produces 32-char string", () => {
        const jti = generateJti();
        assert.equal(jti.length, 32);
        assert.ok(/^[A-Za-z0-9]+$/.test(jti));
    });

    it("generateJti produces unique values", () => {
        const jti1 = generateJti();
        const jti2 = generateJti();
        assert.notEqual(jti1, jti2);
    });
});

// ---------------------------------------------------------------------------
// Auth token management (requires mock adapters)
// ---------------------------------------------------------------------------

describe("Auth token management", () => {
    beforeEach(() => {
        initStorage(new MockStorage());
        initSigning(new MockSigning());
    });

    it("getAuthToken returns bearer token from settings", () => {
        const settings: SolidSettings = {
            ...DEFAULT_SETTINGS,
            auth: { ...DEFAULT_SETTINGS.auth, bearerToken: "my-bearer-token" },
        };
        assert.equal(getAuthToken(settings), "my-bearer-token");
    });

    it("getAuthToken returns null when no token", () => {
        assert.equal(getAuthToken(DEFAULT_SETTINGS), null);
    });

    it("storeToken and getAuthToken round-trip", () => {
        storeToken("stored-token");
        const settings: SolidSettings = {
            ...DEFAULT_SETTINGS,
            auth: { ...DEFAULT_SETTINGS.auth, method: "solid-oidc" },
        };
        assert.equal(getAuthToken(settings), "stored-token");
    });

    it("expired token returns null", () => {
        storeToken("expired-token", -1); // expires immediately
        const settings: SolidSettings = {
            ...DEFAULT_SETTINGS,
            auth: { ...DEFAULT_SETTINGS.auth, method: "solid-oidc" },
        };
        assert.equal(getAuthToken(settings), null);
    });

    it("clearAuth removes all auth state", () => {
        storeToken("token");
        storeRefreshToken("refresh");
        storeDPoPKeyInfo("ES256", { kty: "EC" });
        clearAuth();
        const settings: SolidSettings = {
            ...DEFAULT_SETTINGS,
            auth: { ...DEFAULT_SETTINGS.auth, method: "solid-oidc" },
        };
        assert.equal(getAuthToken(settings), null);
        assert.equal(getDPoPKeyInfo(), null);
    });

    it("DPoP key info round-trip", () => {
        const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: "test-x", y: "test-y" };
        storeDPoPKeyInfo("ES256", jwk);
        const info = getDPoPKeyInfo();
        assert.ok(info);
        assert.equal(info!.alg, "ES256");
        assert.deepEqual(info!.jwk, jwk);
    });

    it("isAuthenticated returns true when token exists", () => {
        const settings: SolidSettings = {
            ...DEFAULT_SETTINGS,
            auth: { ...DEFAULT_SETTINGS.auth, bearerToken: "tok" },
        };
        assert.equal(isAuthenticated(settings), true);
    });

    it("isAuthenticated returns false when no token", () => {
        assert.equal(isAuthenticated(DEFAULT_SETTINGS), false);
    });

    it("buildAuthHeaders returns Bearer for bearer-token method", () => {
        const settings: SolidSettings = {
            ...DEFAULT_SETTINGS,
            auth: { ...DEFAULT_SETTINGS.auth, method: "bearer-token", bearerToken: "tok" },
        };
        const headers = buildAuthHeaders(settings, "GET", "https://pod.example.com/");
        assert.equal(headers["Authorization"], "Bearer tok");
    });

    it("buildAuthHeaders returns empty when no token", () => {
        const headers = buildAuthHeaders(DEFAULT_SETTINGS, "GET", "https://pod.example.com/");
        assert.deepEqual(headers, {});
    });
});
