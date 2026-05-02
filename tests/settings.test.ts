/**
 * Tests for the SolidSettings parser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import type { SolidSettings } from "../src/settings.js";

describe("parseSettings", () => {
    it("returns defaults for null input", () => {
        const settings = parseSettings(null);
        assert.deepEqual(settings, DEFAULT_SETTINGS);
    });

    it("returns defaults for undefined input", () => {
        const settings = parseSettings(undefined);
        assert.deepEqual(settings, DEFAULT_SETTINGS);
    });

    it("returns defaults for empty string", () => {
        const settings = parseSettings("");
        assert.deepEqual(settings, DEFAULT_SETTINGS);
    });

    it("returns defaults for invalid JSON", () => {
        const settings = parseSettings("{not valid json");
        assert.deepEqual(settings, DEFAULT_SETTINGS);
    });

    it("parses valid settings", () => {
        const input = JSON.stringify({
            syncMode: "publish-only",
            rendering: {
                strategy: "raw-triples",
                format: "application/ld+json",
                includeProvenance: false,
            },
            sync: {
                notificationsEnabled: false,
                pollIntervalMs: 60000,
                useEtags: false,
            },
            auth: {
                method: "solid-oidc",
                bearerToken: "",
                clientId: "my-client",
                clientSecret: "secret",
            },
            batching: {
                windowMs: 120000,
                maxLinksPerResource: 50,
            },
            membership: "open",
            dualLanguage: {
                enabled: true,
                excludePredicates: ["flux://internal"],
            },
        });
        const settings = parseSettings(input);
        assert.equal(settings.syncMode, "publish-only");
        assert.equal(settings.rendering.strategy, "raw-triples");
        assert.equal(settings.rendering.format, "application/ld+json");
        assert.equal(settings.rendering.includeProvenance, false);
        assert.equal(settings.sync.notificationsEnabled, false);
        assert.equal(settings.sync.pollIntervalMs, 60000);
        assert.equal(settings.sync.useEtags, false);
        assert.equal(settings.auth.method, "solid-oidc");
        assert.equal(settings.auth.clientId, "my-client");
        assert.equal(settings.batching.windowMs, 120000);
        assert.equal(settings.batching.maxLinksPerResource, 50);
        assert.equal(settings.membership, "open");
        assert.equal(settings.dualLanguage.enabled, true);
        assert.deepEqual(settings.dualLanguage.excludePredicates, ["flux://internal"]);
    });

    it("fills in defaults for partially specified settings", () => {
        const input = JSON.stringify({ syncMode: "subscribe-only" });
        const settings = parseSettings(input);
        assert.equal(settings.syncMode, "subscribe-only");
        // Everything else should be defaults
        assert.equal(settings.rendering.strategy, DEFAULT_SETTINGS.rendering.strategy);
        assert.equal(settings.sync.pollIntervalMs, DEFAULT_SETTINGS.sync.pollIntervalMs);
        assert.equal(settings.auth.method, DEFAULT_SETTINGS.auth.method);
        assert.equal(settings.membership, DEFAULT_SETTINGS.membership);
    });

    it("rejects invalid syncMode", () => {
        const input = JSON.stringify({ syncMode: "invalid" });
        const settings = parseSettings(input);
        assert.equal(settings.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("rejects invalid rendering strategy", () => {
        const input = JSON.stringify({ rendering: { strategy: "invalid" } });
        const settings = parseSettings(input);
        assert.equal(settings.rendering.strategy, DEFAULT_SETTINGS.rendering.strategy);
    });

    it("rejects invalid membership mode", () => {
        const input = JSON.stringify({ membership: "invalid" });
        const settings = parseSettings(input);
        assert.equal(settings.membership, DEFAULT_SETTINGS.membership);
    });

    it("rejects invalid auth method", () => {
        const input = JSON.stringify({ auth: { method: "invalid" } });
        const settings = parseSettings(input);
        assert.equal(settings.auth.method, DEFAULT_SETTINGS.auth.method);
    });

    it("rejects negative poll interval", () => {
        const input = JSON.stringify({ sync: { pollIntervalMs: -1000 } });
        const settings = parseSettings(input);
        assert.equal(settings.sync.pollIntervalMs, DEFAULT_SETTINGS.sync.pollIntervalMs);
    });

    it("rejects non-number batch window", () => {
        const input = JSON.stringify({ batching: { windowMs: "fast" } });
        const settings = parseSettings(input);
        assert.equal(settings.batching.windowMs, DEFAULT_SETTINGS.batching.windowMs);
    });

    it("rejects non-array excludePredicates", () => {
        const input = JSON.stringify({ dualLanguage: { excludePredicates: "not-an-array" } });
        const settings = parseSettings(input);
        assert.deepEqual(settings.dualLanguage.excludePredicates, DEFAULT_SETTINGS.dualLanguage.excludePredicates);
    });

    it("handles all three membership modes", () => {
        for (const mode of ["open", "members-only", "private"]) {
            const settings = parseSettings(JSON.stringify({ membership: mode }));
            assert.equal(settings.membership, mode);
        }
    });

    it("handles all three sync modes", () => {
        for (const mode of ["bidirectional", "publish-only", "subscribe-only"]) {
            const settings = parseSettings(JSON.stringify({ syncMode: mode }));
            assert.equal(settings.syncMode, mode);
        }
    });

    it("handles all rendering strategies", () => {
        for (const strategy of ["raw-triples", "reified", "named-graphs"]) {
            const settings = parseSettings(JSON.stringify({ rendering: { strategy } }));
            assert.equal(settings.rendering.strategy, strategy);
        }
    });
});

describe("DEFAULT_SETTINGS", () => {
    it("has sensible defaults", () => {
        assert.equal(DEFAULT_SETTINGS.syncMode, "bidirectional");
        assert.equal(DEFAULT_SETTINGS.rendering.strategy, "reified");
        assert.equal(DEFAULT_SETTINGS.rendering.format, "text/turtle");
        assert.equal(DEFAULT_SETTINGS.rendering.includeProvenance, true);
        assert.equal(DEFAULT_SETTINGS.sync.pollIntervalMs, 30000);
        assert.equal(DEFAULT_SETTINGS.sync.useEtags, true);
        assert.equal(DEFAULT_SETTINGS.auth.method, "bearer-token");
        assert.equal(DEFAULT_SETTINGS.membership, "members-only");
        assert.equal(DEFAULT_SETTINGS.dualLanguage.enabled, false);
    });
});
