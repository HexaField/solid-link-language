/**
 * # Solid Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via Solid Pods using
 * the Linked Data Platform (LDP) protocol.
 *
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Links are stored as reified RDF triples in Turtle format on Solid
 * Pods, with full AD4M provenance metadata. Sync uses container
 * polling with ETag-based change detection.
 *
 * Spec: solid-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    hash,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { SolidSettings } from "./src/settings.js";
import { linkToTurtle, linkBatchToTurtle, turtleToLinks, linkContentKey, buildInsertPatch, buildDeletePatch } from "./src/translate.js";
import { shouldPublishToSolid, linkOriginKey, isExcludedPredicate, linkContentHash } from "./src/dual-language.js";
import * as store from "./src/store.js";
import { syncFromPod, fullSync } from "./src/sync.js";
import { ldpPut, ldpPatch, ldpDelete, ldpHead, ldpGet, resourceExists } from "./src/ldp.js";
import { linksContainerUrl, linkResourceUrl, metaResourceUrl } from "./src/ldp.pure.js";
import { getAuthToken, buildAuthHeaders, isAuthenticated } from "./src/auth.js";
import { setContainerAcl, updateMembersRegistry } from "./src/acl.js";

// Adapter imports (interfaces for singletons, Deno impls for init)
import { initTransport, getTransport } from "./src/transport.js";
import { DenoTransport } from "./src/transport-deno.js";
import { initStorage, getStorage } from "./src/storage-interface.js";
import { DenoStorageAdapter } from "./src/storage-deno.js";
import { initSigning } from "./src/signing-interface.js";
import { DenoSigningAdapter } from "./src/signing-deno.js";
import { initRuntime, getRuntime } from "./src/runtime-interface.js";
import { DenoRuntime } from "./src/runtime-deno.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §9)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const SOLID_POD_URL = "<to-be-filled>";

//!@ad4m-template-variable
const SOLID_CONTAINER_PATH = "<to-be-filled>";

//!@ad4m-template-variable
const SOLID_IDP_URL = "<to-be-filled>";

//!@ad4m-template-variable
const SOLID_WEBID = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: SolidSettings;

function containerUrl(): string {
    return linksContainerUrl(SOLID_POD_URL, SOLID_CONTAINER_PATH);
}

function authToken(): string | null {
    return getAuthToken(settings);
}

// ---------------------------------------------------------------------------
// Container initialization
// ---------------------------------------------------------------------------

let containerInitialized = false;

/**
 * Ensure the LDP container exists, creating it if necessary.
 * CSS creates containers when you PUT with the right Link header for LDP BasicContainer.
 */
async function ensureContainerExists(): Promise<void> {
    if (containerInitialized) return;

    const cUrl = containerUrl();
    const token = authToken();

    // Check if container already exists
    const exists = await resourceExists(cUrl, token || undefined);
    if (exists) {
        containerInitialized = true;
        return;
    }

    // Create the parent container first
    const parentUrl = `${SOLID_POD_URL.replace(/\/$/, "")}${SOLID_CONTAINER_PATH.replace(/\/$/, "")}/`;
    const parentExists = await resourceExists(parentUrl, token || undefined);
    if (!parentExists) {
        console.log(`[solid-link-language] creating parent container: ${parentUrl}`);
        const parentHeaders: Record<string, string> = {
            "Content-Type": "text/turtle",
            "Link": '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        };
        if (token) parentHeaders["Authorization"] = `Bearer ${token}`;
        const parentBody = `@prefix dcterms: <http://purl.org/dc/terms/> .\n\n<> dcterms:title "AD4M Container" .\n`;
        const parentResp = await getTransport().fetch(parentUrl, "PUT", parentHeaders, parentBody);
        console.log(`[solid-link-language] parent container PUT: ${parentResp.status}`);
    }

    // Create the links/ container
    console.log(`[solid-link-language] creating links container: ${cUrl}`);
    const linksHeaders: Record<string, string> = {
        "Content-Type": "text/turtle",
        "Link": '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    };
    if (token) linksHeaders["Authorization"] = `Bearer ${token}`;
    const linksBody = `@prefix dcterms: <http://purl.org/dc/terms/> .\n\n<> dcterms:title "AD4M Links" .\n`;
    const linksResp = await getTransport().fetch(cUrl, "PUT", linksHeaders, linksBody);
    console.log(`[solid-link-language] links container PUT: ${linksResp.status}`);

    if (linksResp.status >= 200 && linksResp.status < 300) {
        containerInitialized = true;
    } else {
        console.error(`[solid-link-language] failed to create container: ${linksResp.status} ${linksResp.body}`);
    }
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/solid-link-language",
    version: "0.1.0",

    isPublic: true,

    async init() {
        // Initialize adapters before anything else
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
        store.initStore();

        myDid = agentDid();
        settings = parseSettings(languageSettings());

        console.log(`[solid-link-language] init: did=${myDid}`);
        console.log(`[solid-link-language] pod: ${SOLID_POD_URL}`);
        console.log(`[solid-link-language] container: ${SOLID_CONTAINER_PATH}`);
        console.log(`[solid-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[solid-link-language] membership: ${settings.membership}`);
        console.log(`[solid-link-language] rendering: ${settings.rendering.strategy}`);

        // Ensure container exists on init
        if (SOLID_POD_URL !== "<to-be-filled>" && SOLID_CONTAINER_PATH !== "<to-be-filled>") {
            try {
                await ensureContainerExists();
            } catch (err) {
                console.error(`[solid-link-language] failed to ensure container: ${err}`);
            }
        }
    },

    async teardown() {
        myDid = "";
        console.log("[solid-link-language] teardown");
    },

    interactions() {
        return [];
    },

    // -----------------------------------------------------------------------
    // perspective-commit
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            // 1. Store links locally
            store.applyDiff(diff);

            // 2. Skip outbound in subscribe-only mode
            if (settings.syncMode === "subscribe-only") {
                emitPerspectiveDiff(diff);
                return "";
            }

            const token = authToken();
            const hashFn = getRuntime().hash;
            const storage = getStorage();

            // Ensure container exists before writing
            await ensureContainerExists();

            // 3. Track origins for new native commits
            for (const link of diff.additions) {
                const h = store.hashLink(link);
                const originKey = linkOriginKey(h);
                const existing = storage.get(originKey);
                if (existing === "solid") {
                    storage.put(originKey, "dual");
                } else if (!existing) {
                    storage.put(originKey, "native");
                }
            }

            // 4. Write additions to Pod
            for (const link of diff.additions) {
                const h = store.hashLink(link);

                // Dual-language filter
                if (settings.dualLanguage.enabled) {
                    if (!shouldPublishToSolid(h, (key) => storage.get(key))) continue;
                    if (isExcludedPredicate(link.data.predicate || "", settings.dualLanguage.excludePredicates)) continue;
                }

                // Create individual link resource
                const turtle = linkToTurtle(link, settings);
                const resourceUrl = linkResourceUrl(containerUrl(), h);
                await ldpPut(resourceUrl, turtle, "text/turtle", token || undefined);
            }

            // 5. Delete removed links from Pod
            for (const link of diff.removals) {
                const h = store.hashLink(link);
                const resourceUrl = linkResourceUrl(containerUrl(), h);
                await ldpDelete(resourceUrl, token || undefined);
            }

            // 6. Emit the perspective diff for local subscribers
            emitPerspectiveDiff(diff);

            return "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            if (settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }
            return await syncFromPod(
                SOLID_POD_URL,
                SOLID_CONTAINER_PATH,
                authToken() || undefined,
            );
        },

        async render() {
            return store.allLinks();
        },

        async currentRevision() {
            return store.getRevision() || "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            return store.listPeers("peers/");
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports (required by the AD4M runtime dispatcher)
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    interactions,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Callback registration
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}

// ---------------------------------------------------------------------------
// Signal-based handler
// ---------------------------------------------------------------------------

export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return;
    }

    // Handle notifications from Solid Notifications Protocol
    const notification = signal as { type?: string; object?: string };
    if (notification.type === "Update" || notification.type === "Create") {
        // A resource was created or updated — trigger sync
        const diff = await syncFromPod(
            SOLID_POD_URL,
            SOLID_CONTAINER_PATH,
            authToken() || undefined,
        );

        if (linkCallback && (diff.additions.length > 0 || diff.removals.length > 0)) {
            linkCallback(diff);
        }
    }
}
