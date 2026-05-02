/**
 * Settings for the Solid Link Language.
 *
 * Parsed from the JSON string returned by `languageSettings()` at
 * runtime. Provides sensible defaults per Spec §10.
 */

export interface RenderingSettings {
    /** Rendering strategy: how links are stored as RDF */
    strategy: "raw-triples" | "reified" | "named-graphs";
    /** RDF serialization format for writes */
    format: "text/turtle" | "application/ld+json" | "application/n-triples";
    /** Whether to include provenance (author, proof) on every triple */
    includeProvenance: boolean;
}

export interface SyncSettings {
    /** Use Solid Notifications (WebSocket) if available */
    notificationsEnabled: boolean;
    /** Polling interval (ms) when notifications not available */
    pollIntervalMs: number;
    /** Use ETags for change detection */
    useEtags: boolean;
}

export interface AuthSettings {
    /** Auth method */
    method: "solid-oidc" | "bearer-token";
    /** Static bearer token (for token auth) */
    bearerToken: string;
    /** Client ID (for Solid-OIDC) */
    clientId: string;
    /** Client secret (for Solid-OIDC) */
    clientSecret: string;
}

export interface BatchingSettings {
    /** Time window for batching links into one resource (ms) */
    windowMs: number;
    /** Max links per resource */
    maxLinksPerResource: number;
}

export interface DualLanguageSettings {
    enabled: boolean;
    excludePredicates: string[];
}

export type SyncMode = "bidirectional" | "publish-only" | "subscribe-only";
export type MembershipMode = "open" | "members-only" | "private";

export interface SolidSettings {
    syncMode: SyncMode;
    rendering: RenderingSettings;
    sync: SyncSettings;
    auth: AuthSettings;
    batching: BatchingSettings;
    membership: MembershipMode;
    dualLanguage: DualLanguageSettings;
}

/** Default settings — sensible defaults for bidirectional Solid sync. */
export const DEFAULT_SETTINGS: SolidSettings = {
    syncMode: "bidirectional",
    rendering: {
        strategy: "reified",
        format: "text/turtle",
        includeProvenance: true,
    },
    sync: {
        notificationsEnabled: true,
        pollIntervalMs: 30000,
        useEtags: true,
    },
    auth: {
        method: "bearer-token",
        bearerToken: "",
        clientId: "",
        clientSecret: "",
    },
    batching: {
        windowMs: 60000,
        maxLinksPerResource: 100,
    },
    membership: "members-only",
    dualLanguage: {
        enabled: false,
        excludePredicates: [],
    },
};

/**
 * Parse settings from a raw JSON string, falling back to defaults
 * for any missing or invalid fields.
 */
export function parseSettings(raw: string | null | undefined): SolidSettings {
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
        const parsed = JSON.parse(raw);
        return {
            syncMode:
                ["bidirectional", "publish-only", "subscribe-only"].includes(parsed?.syncMode)
                    ? parsed.syncMode
                    : DEFAULT_SETTINGS.syncMode,
            rendering: {
                strategy:
                    ["raw-triples", "reified", "named-graphs"].includes(parsed?.rendering?.strategy)
                        ? parsed.rendering.strategy
                        : DEFAULT_SETTINGS.rendering.strategy,
                format:
                    ["text/turtle", "application/ld+json", "application/n-triples"].includes(parsed?.rendering?.format)
                        ? parsed.rendering.format
                        : DEFAULT_SETTINGS.rendering.format,
                includeProvenance:
                    typeof parsed?.rendering?.includeProvenance === "boolean"
                        ? parsed.rendering.includeProvenance
                        : DEFAULT_SETTINGS.rendering.includeProvenance,
            },
            sync: {
                notificationsEnabled:
                    typeof parsed?.sync?.notificationsEnabled === "boolean"
                        ? parsed.sync.notificationsEnabled
                        : DEFAULT_SETTINGS.sync.notificationsEnabled,
                pollIntervalMs:
                    typeof parsed?.sync?.pollIntervalMs === "number" && parsed.sync.pollIntervalMs > 0
                        ? parsed.sync.pollIntervalMs
                        : DEFAULT_SETTINGS.sync.pollIntervalMs,
                useEtags:
                    typeof parsed?.sync?.useEtags === "boolean"
                        ? parsed.sync.useEtags
                        : DEFAULT_SETTINGS.sync.useEtags,
            },
            auth: {
                method:
                    ["solid-oidc", "bearer-token"].includes(parsed?.auth?.method)
                        ? parsed.auth.method
                        : DEFAULT_SETTINGS.auth.method,
                bearerToken:
                    typeof parsed?.auth?.bearerToken === "string"
                        ? parsed.auth.bearerToken
                        : DEFAULT_SETTINGS.auth.bearerToken,
                clientId:
                    typeof parsed?.auth?.clientId === "string"
                        ? parsed.auth.clientId
                        : DEFAULT_SETTINGS.auth.clientId,
                clientSecret:
                    typeof parsed?.auth?.clientSecret === "string"
                        ? parsed.auth.clientSecret
                        : DEFAULT_SETTINGS.auth.clientSecret,
            },
            batching: {
                windowMs:
                    typeof parsed?.batching?.windowMs === "number" && parsed.batching.windowMs > 0
                        ? parsed.batching.windowMs
                        : DEFAULT_SETTINGS.batching.windowMs,
                maxLinksPerResource:
                    typeof parsed?.batching?.maxLinksPerResource === "number" && parsed.batching.maxLinksPerResource > 0
                        ? parsed.batching.maxLinksPerResource
                        : DEFAULT_SETTINGS.batching.maxLinksPerResource,
            },
            membership:
                ["open", "members-only", "private"].includes(parsed?.membership)
                    ? parsed.membership
                    : DEFAULT_SETTINGS.membership,
            dualLanguage: {
                enabled:
                    typeof parsed?.dualLanguage?.enabled === "boolean"
                        ? parsed.dualLanguage.enabled
                        : DEFAULT_SETTINGS.dualLanguage.enabled,
                excludePredicates:
                    Array.isArray(parsed?.dualLanguage?.excludePredicates)
                        ? parsed.dualLanguage.excludePredicates
                        : DEFAULT_SETTINGS.dualLanguage.excludePredicates,
            },
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}
