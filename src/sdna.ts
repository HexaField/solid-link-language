/**
 * SDNA / Subject Class pattern detection — pure module.
 *
 * Detects known Subject Class patterns in LinkExpressions for smart
 * content categorization. Same pattern as AP link language.
 *
 * Pure functions — no ad4m:host imports.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectedPattern {
    type: "chat-message" | "reply" | "content" | "mention" | "reaction" | "unknown";
    contentUri?: string;
    parentUri?: string;
    channelUri?: string;
    mentionedAgent?: string;
}

// ---------------------------------------------------------------------------
// Well-known predicates
// ---------------------------------------------------------------------------

const CHAT_PREDICATES = new Set([
    "flux://has_message",
    "sioc://content_of",
]);

const REPLY_PREDICATES = new Set([
    "flux://has_reply",
    "sioc://reply_of",
]);

const REACTION_PREDICATES = new Set([
    "flux://has_reaction",
    "emoji://reaction",
]);

const CONTENT_PREDICATE = "sioc://content_of";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the Subject Class pattern of a link based on its predicate.
 *
 * Priority (first match wins):
 * 1. Chat predicates → chat-message
 * 2. Reply predicates → reply
 * 3. Predicate contains "mention" → mention
 * 4. Reaction predicates → reaction
 * 5. sioc://content_of → content
 * 6. Default → unknown
 */
export function detectPattern(
    link: LinkExpression,
    chatPredicates?: string[],
): DetectedPattern {
    const predicate = link.data.predicate || "";
    const source = link.data.source || "";
    const target = link.data.target || "";

    const chatPreds = chatPredicates
        ? new Set(chatPredicates)
        : CHAT_PREDICATES;

    // 1. Chat message
    if (predicate && chatPreds.has(predicate)) {
        return {
            type: "chat-message",
            contentUri: target,
            channelUri: source,
        };
    }

    // 2. Reply
    if (REPLY_PREDICATES.has(predicate)) {
        return {
            type: "reply",
            contentUri: target,
            parentUri: source,
        };
    }

    // 3. Mention
    if (predicate && predicate.toLowerCase().includes("mention")) {
        return {
            type: "mention",
            mentionedAgent: target,
        };
    }

    // 4. Reaction
    if (REACTION_PREDICATES.has(predicate)) {
        return {
            type: "reaction",
            contentUri: target,
        };
    }

    // 5. Content
    if (predicate === CONTENT_PREDICATE) {
        return {
            type: "content",
            contentUri: target,
        };
    }

    // 6. Unknown
    return { type: "unknown" };
}
