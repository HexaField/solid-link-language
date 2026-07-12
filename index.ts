/**
 * # Solid Link Language for AD4M
 *
 * Bridge language that gives a Perspective genuine perspective-sync
 * convergence on top of Solid Pods (Linked Data Platform).
 *
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Solid/LDP has no native causal history, so this language emulates a
 * content-addressed diff-DAG in the pod: each commit is an immutable
 * resource named by its content hash, carrying ad4m:previous pointers to
 * its parent commit(s). Folding that DAG (an OR-Set keyed by link content
 * hash, with removals as tombstones) is the source of truth; the RDF link
 * view is a derived projection. Sync walks the ad4m:previous chain rather
 * than snapshot-diffing the container, and currentRevision is derived from
 * the DAG head set (never the container ETag).
 *
 * Spec: solid-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { SolidSettings } from "./src/settings.js";
import * as store from "./src/store.js";
import { buildCommit, commitToTurtle } from "./src/diffdag.js";
import { syncFromPod, fullSync } from "./src/sync.js";
import { ldpPut, ldpHead, ldpGet, resourceExists } from "./src/ldp.js";
import { diffsContainerUrl, diffResourceUrl } from "./src/ldp.js";
import { getAuthToken } from "./src/auth.js";

// Adapter imports
import { initTransport, getTransport, initStorage, initSigning, initRuntime } from "./src/adapters.js";
import { DenoTransport, DenoStorageAdapter, DenoSigningAdapter, DenoRuntime } from "./src/adapters-deno.js";

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

/** The pod container holding the immutable diff-commit DAG resources. */
function diffsContainer(): string {
    return diffsContainerUrl(SOLID_POD_URL, SOLID_CONTAINER_PATH);
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

    const cUrl = diffsContainer();
    const token = authToken();

    // Check if the diffs/ container already exists.
    const exists = await resourceExists(cUrl, token || undefined);
    if (exists) {
        containerInitialized = true;
        return;
    }

    const containerHeaders = (): Record<string, string> => {
        const h: Record<string, string> = {
            "Content-Type": "text/turtle",
            "Link": '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        };
        if (token) h["Authorization"] = `Bearer ${token}`;
        return h;
    };

    // Create the parent container first.
    const parentUrl = `${SOLID_POD_URL.replace(/\/$/, "")}${SOLID_CONTAINER_PATH.replace(/\/$/, "")}/`;
    const parentExists = await resourceExists(parentUrl, token || undefined);
    if (!parentExists) {
        console.log(`[solid-link-language] creating parent container: ${parentUrl}`);
        const parentBody = `@prefix dcterms: <http://purl.org/dc/terms/> .\n\n<> dcterms:title "AD4M Container" .\n`;
        const parentResp = await ldpPut(parentUrl, parentBody, "text/turtle", token || undefined);
        console.log(`[solid-link-language] parent container PUT: ${parentResp.status}`);
    }

    // Create the diffs/ container (holds the immutable diff-commit DAG).
    console.log(`[solid-link-language] creating diffs container: ${cUrl}`);
    const diffsBody = `@prefix dcterms: <http://purl.org/dc/terms/> .\n\n<> dcterms:title "AD4M Diff-DAG" .\n`;
    const diffsResp = await getTransport().fetch(cUrl, "PUT", containerHeaders(), diffsBody);
    console.log(`[solid-link-language] diffs container PUT: ${diffsResp.status}`);

    if (diffsResp.status >= 200 && diffsResp.status < 300) {
        containerInitialized = true;
    } else {
        console.error(`[solid-link-language] failed to create container: ${diffsResp.status} ${diffsResp.body}`);
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
    // perspective-commit — append an immutable diff-commit to the DAG
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            const hashFn = store.getHashFn();

            // 1. Build a diff-commit whose parents are the current DAG heads.
            //    Removals become tombstones carrying the ORIGINAL link hash, so
            //    they converge against the original add on every replica.
            const parents = store.getHeads();
            const commit = buildCommit(
                diff,
                parents,
                myDid,
                new Date().toISOString(),
                hashFn,
            );
            const commitHash = store.hashCommit(commit);

            // 2. Ingest into the local DAG (source of truth) and rebuild the
            //    derived link cache by folding. currentRevision now follows the
            //    new head automatically.
            store.addCommitToDag(commitHash, commit);
            store.rebuildLinksFromDag();

            // 3. Emit for local subscribers regardless of sync direction.
            emitPerspectiveDiff(diff);
            if (settings.syncMode === "subscribe-only") {
                return commitHash;
            }

            // 4. Publish the immutable diff-commit resource to the pod. It is
            //    named by its content hash and carries ad4m:previous pointers,
            //    forming the content-hash DAG in the pod. We never PUT/DELETE
            //    per-link resources — the DAG is append-only, so history and
            //    concurrent removals survive.
            const token = authToken();
            await ensureContainerExists();

            const turtle = commitToTurtle(commit, hashFn);
            const resourceUrl = diffResourceUrl(diffsContainer(), commitHash);
            await ldpPut(resourceUrl, turtle, "text/turtle", token || undefined);

            return commitHash;
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

        async currentRevision(): Promise<string | null> {
            // Content hash of the DAG head(s). Null when the DAG is empty.
            return store.getRevision();
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
