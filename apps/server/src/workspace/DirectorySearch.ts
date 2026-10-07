// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";

import type { FileFinder as FileFinderType } from "@ff-labs/fff-node";
import type { FilesystemSearchDirectoriesEntry } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

// Loaded through `require` for the same single-executable reason as
// WorkspaceSearchIndex.
const requireForFff = NodeModule.createRequire(import.meta.url);
const { FileFinder } = requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

/** How long a query waits for shards it just created, so the first keystroke has results. */
const FRESH_SHARD_WAIT_MS = 1_000;
/** Shards do not watch the filesystem; a search rescans one in place once it is this old. */
const SHARD_RESCAN_AFTER_MS = 5 * 60_000;
/** Deepest relative depth matched from directory listings while a shard's first scan runs. */
const NAME_WALK_MAX_DEPTH = 3;
const NAME_WALK_MAX_LISTINGS = 200;
/** Folders that hold installed software rather than projects; never indexed. */
const SKIPPED_FOLDER_NAMES = new Set(["Applications", "Library", "node_modules"]);
const DIRNAME_MATCH_TYPES = new Set(["exact_dirname", "fuzzy_dirname"]);

interface Shard {
  readonly finder: FileFinderType;
  scannedAt: number;
}

interface Candidate extends FilesystemSearchDirectoriesEntry {
  readonly tier: number;
  readonly depth: number;
  readonly score: number;
}

function normalizeName(input: string): string {
  const lower = input.toLowerCase();
  const compact = lower.replace(/[^\p{L}\p{N}]/gu, "");
  return compact.length > 0 ? compact : lower;
}

function nameTier(name: string, normalizedQuery: string): number {
  const normalizedName = normalizeName(name);
  if (normalizedName === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 1;
  if (normalizedName.includes(normalizedQuery)) return 2;
  return 3;
}

const listChildFolders = (directory: string) =>
  Effect.promise(() =>
    NodeFSP.readdir(directory, { withFileTypes: true }).then(
      (dirents) =>
        dirents
          .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
          .map((dirent) => dirent.name),
      () => [],
    ),
  );

/**
 * Fuzzy folder search for the add-project picker, backed by fff.
 *
 * Each child folder of the search root is indexed as its own shard, so a slow
 * folder such as an iCloud-synced `~/Documents` does not hold back the rest.
 * Shards are created on the first search, kept for the life of the server, and
 * rescanned in place when stale: fff's `destroy` neither stops a running scan
 * nor returns the index's memory, so rebuilding shards would cost more than
 * keeping them. A first scan can take minutes while iCloud fetches metadata;
 * until it finishes, folder names inside that shard are matched from directory
 * listings. fff only knows folders that directly hold files, which every
 * project root does.
 */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const shards = new Map<string, Shard>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const shard of shards.values()) {
        try {
          shard.finder.destroy();
        } catch {
          // Destroying an already-torn-down native index is harmless.
        }
      }
      shards.clear();
    }),
  );

  /** Returns the shard and whether this call created it. */
  const acquireShard = Effect.fn("DirectorySearch.acquireShard")(function* (
    shardPath: string,
    now: number,
  ) {
    const existing = shards.get(shardPath);
    if (existing) {
      if (now - existing.scannedAt > SHARD_RESCAN_AFTER_MS && !existing.finder.isScanning()) {
        // Rescans run in the background and keep serving the previous results.
        existing.scannedAt = now;
        yield* Effect.try(() => existing.finder.scanFiles()).pipe(Effect.ignore);
      }
      return { shard: existing, fresh: false };
    }

    const created = yield* Effect.try(() =>
      FileFinder.create({
        basePath: shardPath,
        disableMmapCache: true,
        disableContentIndexing: true,
        disableWatch: true,
        aiMode: false,
        enableHomeDirScanning: true,
      }),
    ).pipe(Effect.orElseSucceed(() => null));
    if (!created?.ok) return null;
    const shard: Shard = { finder: created.value, scannedAt: now };
    shards.set(shardPath, shard);
    return { shard, fresh: true };
  });

  const search = Effect.fn("DirectorySearch.search")(function* (input: {
    readonly root: string;
    readonly childNames: ReadonlyArray<string>;
    readonly query: string;
    readonly limit: number;
  }) {
    const normalizedQuery = normalizeName(input.query);
    const now = yield* Clock.currentTimeMillis;
    const candidates: Candidate[] = [];
    const matchName = (relativePath: string, depth: number) => {
      const segments = relativePath.split("/");
      const tier = nameTier(segments.at(-1) ?? relativePath, normalizedQuery);
      if (tier < 3) {
        candidates.push({
          relativePath,
          fullPath: path.join(input.root, ...segments),
          tier,
          depth,
          score: 0,
        });
      }
    };

    const active: Array<{ readonly relativePath: string; readonly shard: Shard }> = [];
    const freshShards: Shard[] = [];
    for (const name of input.childNames) {
      matchName(name, 1);
      if (SKIPPED_FOLDER_NAMES.has(name)) continue;
      const acquired = yield* acquireShard(path.join(input.root, name), now);
      if (!acquired) continue;
      active.push({ relativePath: name, shard: acquired.shard });
      if (acquired.fresh) freshShards.push(acquired.shard);
    }

    if (freshShards.length > 0) {
      yield* Effect.promise(() =>
        Promise.all(freshShards.map((shard) => shard.finder.waitForScan(FRESH_SHARD_WAIT_MS))),
      );
    }

    let walk: Array<string> = [];
    for (const { relativePath, shard } of active) {
      if (shard.finder.isScanning()) {
        walk.push(relativePath);
        continue;
      }
      const result = yield* Effect.try(() =>
        shard.finder.directorySearch(input.query, { pageSize: input.limit }),
      ).pipe(Effect.orElseSucceed(() => null));
      if (!result?.ok) continue;
      result.value.items.forEach((item, index) => {
        const score = result.value.scores[index];
        const relativeToShard = item.relativePath.replaceAll("\\", "/").replace(/\/$/, "");
        if (!relativeToShard || !score || !DIRNAME_MATCH_TYPES.has(score.matchType)) return;
        const segments = relativeToShard.split("/");
        candidates.push({
          relativePath: `${relativePath}/${relativeToShard}`,
          fullPath: path.join(input.root, relativePath, ...segments),
          tier: nameTier(segments.at(-1) ?? relativeToShard, normalizedQuery),
          depth: 1 + segments.length,
          score: score.total,
        });
      });
    }

    // Shards still on their first scan return nothing, so match names inside them from listings.
    let listings = 0;
    for (let depth = 2; depth <= NAME_WALK_MAX_DEPTH && walk.length > 0; depth++) {
      const parents = walk.slice(0, NAME_WALK_MAX_LISTINGS - listings);
      listings += parents.length;
      const children = yield* Effect.forEach(
        parents,
        (parent) =>
          listChildFolders(path.join(input.root, ...parent.split("/"))).pipe(
            Effect.map((names) => names.map((name) => `${parent}/${name}`)),
          ),
        { concurrency: 16 },
      );
      walk = [];
      for (const child of children.flat()) {
        matchName(child, depth);
        if (!SKIPPED_FOLDER_NAMES.has(child.split("/").at(-1) ?? child)) walk.push(child);
      }
    }

    // Name matches rank shallow-first; typo-tolerant fff matches rank by score.
    return candidates
      .toSorted(
        (left, right) =>
          left.tier - right.tier ||
          (left.tier < 3
            ? left.depth - right.depth || right.score - left.score
            : right.score - left.score || left.depth - right.depth) ||
          left.relativePath.localeCompare(right.relativePath),
      )
      .slice(0, input.limit)
      .map(({ relativePath, fullPath }) => ({ relativePath, fullPath }));
  });

  return { search };
});
