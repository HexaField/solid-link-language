/**
 * Tests for SDNA pattern detection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectPattern } from "../src/translate.js";
import type { DetectedPattern } from "../src/translate.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLink(source: string, predicate: string, target: string): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: { source, predicate, target },
        proof: { signature: "sig", key: "key" },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectPattern", () => {
    it("detects chat-message from default predicates", () => {
        const link = makeLink("channel://main", "flux://has_message", "expr://msg1");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "chat-message");
        assert.equal(pattern.channelUri, "channel://main");
        assert.equal(pattern.contentUri, "expr://msg1");
    });

    it("detects chat-message from sioc://content_of", () => {
        const link = makeLink("channel://main", "sioc://content_of", "expr://msg1");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "chat-message");
    });

    it("detects chat-message with custom predicates", () => {
        const link = makeLink("channel://main", "custom://chat", "expr://msg1");
        const pattern = detectPattern(link, ["custom://chat"]);
        assert.equal(pattern.type, "chat-message");
    });

    it("detects reply pattern", () => {
        const link = makeLink("expr://parent", "flux://has_reply", "expr://reply");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reply");
        assert.equal(pattern.parentUri, "expr://parent");
        assert.equal(pattern.contentUri, "expr://reply");
    });

    it("detects sioc reply", () => {
        const link = makeLink("expr://parent", "sioc://reply_of", "expr://reply");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reply");
    });

    it("detects mention pattern", () => {
        const link = makeLink("expr://msg", "flux://has_mention", "did:key:z6MkOther");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "mention");
        assert.equal(pattern.mentionedAgent, "did:key:z6MkOther");
    });

    it("detects reaction pattern", () => {
        const link = makeLink("expr://msg", "flux://has_reaction", "👍");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reaction");
        assert.equal(pattern.contentUri, "👍");
    });

    it("detects emoji reaction", () => {
        const link = makeLink("expr://msg", "emoji://reaction", "❤️");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reaction");
    });

    it("returns unknown for unrecognized predicate", () => {
        const link = makeLink("a://1", "custom://unknown", "b://2");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "unknown");
    });

    it("returns unknown for empty predicate", () => {
        const link = makeLink("a://1", "", "b://2");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "unknown");
    });

    it("chat predicates take priority over content", () => {
        // sioc://content_of is both a chat predicate and content predicate
        const link = makeLink("channel://main", "sioc://content_of", "expr://msg");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "chat-message");
    });

    it("reply takes priority over mention if predicate is reply", () => {
        const link = makeLink("expr://parent", "flux://has_reply", "expr://reply");
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reply");
    });
});
