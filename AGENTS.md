# AGENTS.md — solid-link-language

AD4M link language that provides real `perspective-sync` convergence on a Solid
pod by **emulating a content-addressed diff-DAG** over LDP (which has no native
causal history).

## Architecture (the load-bearing idea)

Two roles, kept strictly separate:

- **Convergence substrate = source of truth.** A content-addressed diff-DAG.
  Each commit is an immutable pod resource `diffs/diff-<hash>.ttl` whose body
  carries link additions, removals (tombstones), and `ad4m:previous` triples
  pointing at parent commit hash(es). Commits are named by content and are never
  mutated or deleted — the DAG is append-only, so history and concurrent
  removals survive.
- **Derived link cache = projection.** A local KV cache of the folded link set,
  for query/render only. Fully reconstructible from the DAG; never authoritative.

Invariants — do not break these:

- `currentRevision()` derives from the **DAG head set** (`store.getRevision()`):
  `null` when empty, the single head hash when one head, a deterministic digest
  of sorted head hashes when several. **Never** the container ETag / a timestamp
  / a sequence counter.
- Merge is an **OR-Set keyed by link content hash**: folded links = union of
  adds minus any whose hash appears in a tombstone. Commit fold and derived
  cache MUST use the same key — `store.hashLink` delegates to
  `diffdag.hashLinkContent` so the two layers cannot drift.
- Removals are **tombstone diff entries carrying the original link hash**, never
  HTTP `DELETE`.
- Sync **walks `ad4m:previous`** (fetch heads → follow parents → pull missing
  ancestors → re-fold). Do not reintroduce container-listing snapshot diffing or
  ETag change detection.

## Channel-B projection (shared, verbatim)

Beyond the diff-DAG, links also project into **native RDF resources** so Solid
apps read them as first-class linked data. This rides the shared, protocol-
agnostic SHACL→native transformer in `src/projection/`, **copied verbatim** across
all Channel-B languages (matrix, nostr, atproto, solid, ap): `bridge.ts`,
`expression.ts`, `index.ts`, `literal.ts`, `profile.ts`, `project.ts`,
`types.ts`. **Do not edit it in isolation** — mirror any change to every Channel-B
repo or the copies drift (asserted identical by diff). A `NodeShape` annotated
`projection://nativeType` selects the projected property; `projection://field`
marks projected properties. `src/solid-projection.ts` is the thin per-protocol
`NativeAdapter`. The projection is a **pure fold of the DAG, never read back to
rebuild it**; genuinely native-authored RDF from a user with **no AD4M DID** is
echo-suppressed and ingested as new Role-A links.

## Layout

- `src/diffdag.ts` — pure substrate: `hashLinkContent`, `commitHash`,
  `computeHeads`, `revisionOfHeads`, `foldCommits`/`foldToLinks`,
  `diffBetweenFolds`, `buildCommit`, `commitToTurtle`/`commitFromGraph`. No
  adapter or `ad4m:host` imports.
- `src/store.ts` — DAG cache (`dag/commit/*`, `dag/heads`) + derived link cache +
  query + peers. Key functions: `addCommitToDag`, `getHeads`, `recomputeHeads`,
  `rebuildLinksFromDag`, `getRevision`, `hashCommit`, `hashLink`.
- `src/sync.ts` — `syncFromPod` / `fullSync`: discover commit resources, walk
  `ad4m:previous`, fetch missing ancestors, re-fold, return the before/after diff.
- `src/ldp.ts` — LDP verbs + URL builders (`diffsContainerUrl`,
  `diffResourceUrl`, `extractCommitHash`).
- `src/ontology.ts` — `ad4m:DiffCommit`, `ad4m:previous`, `ad4m:addition`,
  `ad4m:removal`, `ad4m:Tombstone`, `ad4m:removesLinkHash`, `ad4m:linkHash`.
- `src/translate.ts` — link ↔ RDF, plus retained dual-language and SDNA-pattern
  helpers (were `dual-language.ts` / `sdna.ts`). These are **orthogonal to the
  diff-DAG contract and intentionally not wired into the append-only commit
  path**; they are still tested by `tests/dual-language.test.ts` /
  `tests/sdna.test.ts`.
- `src/solid-projection.ts` — the native-RDF `NativeAdapter` (Channel B).
- `src/projection/` — the shared SHACL transformer (see above).
- `src/{acl,auth,rdf,settings,types}.ts` — WAC, WebID-OIDC/CSS auth, Turtle
  primitives, settings, shared types.
- `src/adapters.ts` / `src/adapters-deno.ts` — injected Transport / Storage /
  Runtime / Signing. `ad4m:host` imports are confined to `adapters-deno.ts` and
  `index.ts`; core modules stay runtime-agnostic and unit-testable.

## Build / test / typecheck

```bash
NODE_ENV=development pnpm install     # NODE_ENV=production skips devDeps — installs will look broken
deno run --allow-all esbuild.ts       # bundle → build/ (needs @coasys/ad4m-ldk at ../ad4m/ad4m-ldk/js or AD4M_LDK_ENTRY)
npx tsc --noEmit                      # typecheck
node --experimental-vm-modules --import tsx --test tests/*.test.ts   # full suite
```

## Testing without a pod

The whole convergence path is unit-tested against in-memory fixtures
(`tests/diffdag.test.ts`, `tests/sync.test.ts` with mock Storage/Transport/
Runtime, `tests/ldp.test.ts`, `tests/cross-runtime.test.ts`). What genuinely
needs a **live Solid server** (e.g. Community Solid Server) and is NOT covered:
real LDP container creation + `PUT`/`GET` round-trips, WebID-OIDC/CSS token
auth, and Web Access Control. The Channel-B projection is unit-tested for
native-RDF payload shape + echo-suppressed ingest; live rendering in a Solid app
against a running pod is not in CI.

## Gotchas

- **The executor DISCARDS `sync()`'s return value.** `Language::sync()`
  (rust-executor) runs `perspectiveSyncSync()` purely for its side effects;
  returning a `PerspectiveDiff` from `sync()`/`syncFromPod` does NOT make inbound
  links queryable. Peer links become visible on the perspective ONLY when pushed
  through the `emitPerspectiveDiff` host channel. `syncFromPod` therefore emits
  its before/after fold delta via `getRuntime().emitPerspectiveDiff(delta)` (guarded
  on a non-empty delta) — see `src/sync.ts`. Without this the pod's diff-DAG folds
  correctly into the local store but `perspective.queryLinks` never sees remote
  links: the live C1 freeze at **A=10/B=10** (each agent seeing only its own
  writes). The same host-contract trap bit Nostr and Hypercore. `commit()` already
  emits the local diff; the sync incremental delta excludes already-folded local
  links (the DAG dedups by commit hash), so there is no double-apply. `handleSignal`
  must NOT also fire `linkCallback` for an inbound update — `syncFromPod` already
  emits it. Regression: `tests/sync.test.ts` → "emits inbound folds to the executor"
  (a spy RuntimeAdapter asserting a non-empty fold emits exactly one diff; the test
  a silent no-op mock previously let pass).
- **Pod-URL / container-path joining must go through `joinPodPath`.** The
  wind-tunnel templates the language with `SOLID_POD_URL` carrying **no** trailing
  slash (`http://127.0.0.1:3005`) and `SOLID_CONTAINER_PATH` carrying **no** leading
  slash (`ad4m/c1-<uuid>/`). A naive `podUrl + containerPath` concatenation yields
  the invalid `http://127.0.0.1:3005ad4m/c1-<uuid>/diffs/` — every `httpFetch` then
  throws, each agent keeps only its own writes, and C1 freezes at **A=10/B=10** (the
  same surface symptom as the emit trap, different cause). `joinPodPath` (`src/ldp.ts`)
  strips trailing slashes off the base, leading/trailing off the path, and rejoins
  with exactly one separator; **all** container/resource builders
  (`linksContainerUrl`, `diffsContainerUrl`, `viewsContainerUrl`, `metaResourceUrl`,
  `membersResourceUrl`) route through it. This was invisible to the original unit
  tests because their fixtures used **leading-slash** container paths (`/ad4m/...`),
  which happen to concatenate correctly. Regression: `tests/ldp.test.ts` →
  "joinPodPath (slash-normalisation matrix)" + "container builders reject the
  no-separator concatenation bug" (asserts the exact wind-tunnel shape resolves to a
  `new URL()`-parseable string with no `3005ad4m` glue).
- **The OR-Set identity key EXCLUDES `proof`.** `hashLinkContent` (`src/diffdag.ts`)
  keys a link on `[source, predicate, target, author, timestamp]` and DELIBERATELY
  omits the signature/key. Reason: when AD4M's `perspective.removeLink` hands the
  language a removal, the executor does **not** round-trip the original signature —
  the tombstone LinkExpression arrives with an **empty proof** (`signature:""`,
  `key:""`). If proof were part of the key, a peer replica that folded the ADD with
  its real signature would compute a different hash than the empty-proof tombstone,
  so the tombstone could never reference the add's hash and removals would never fold
  out on peers. Symptom: adds converge 20/20 but removal freezes (times out at
  `C1_TIMEOUT_MS`). `timestamp` stays in the key because it DOES round-trip through
  `removeLink`; this matches the sibling nostr/ipfs convention
  (`source:predicate:target:author:timestamp`). Changing the key rehashes every
  commit globally but deterministically. Regression: `tests/diffdag.test.ts` →
  "a tombstone converges against its add even when the removal's proof is stripped"
  and "timestamp remains part of the identity key (it round-trips; proof does not)".
- The `interactions()` capability returning `[]` is the legitimate
  language-interface no-op (matches the `p-diff-sync` reference). Keep it; it is
  not the doc-fiction to strip.
- A stray `pnpm-workspace.yaml` containing template text (`allowBuilds: esbuild:
  set this to true or false`) is not valid config and not part of this language —
  do not commit it.
