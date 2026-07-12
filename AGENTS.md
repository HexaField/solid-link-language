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

- The `interactions()` capability returning `[]` is the legitimate
  language-interface no-op (matches the `p-diff-sync` reference). Keep it; it is
  not the doc-fiction to strip.
- A stray `pnpm-workspace.yaml` containing template text (`allowBuilds: esbuild:
  set this to true or false`) is not valid config and not part of this language —
  do not commit it.
