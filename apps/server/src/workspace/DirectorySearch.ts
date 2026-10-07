// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";

import type { FileFinder as FileFinderType } from "@ff-labs/fff-node";
import type { FilesystemSearchDirectoriesEntry } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

// Loaded through `require` for the same single-executable reason as
// WorkspaceSearchIndex.
const requireForFff = NodeModule.createRequire(import.meta.url);
const { FileFinder } = requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

/** A shard still scanning after this long is split into its child folders. */
const SHARD_SCAN_BUDGET_MS = 5_000;
/** How long a query waits for shards it just created, so the first keystroke has results. */
const FRESH_SHARD_WAIT_MS = 1_000;
/** Indexes do not watch the filesystem; they are rebuilt after this long instead. */
const SHARD_MAX_AGE_MS = 10 * 60_000;
/** A split folder is retried as one shard after this long, since its files may be local by then. */
const SPLIT_RETRY_MS = 60 * 60_000;
/** Deepest relative depth of a folder that may be split; deeper slow shards are dropped. */
const MAX_SPLIT_DEPTH = 4;
const MAX_SHARDS_PER_SEARCH = 200;
/** Folders that hold installed software rather than projects; never indexed. */
const SKIPPED_FOLDER_NAMES = new Set(["Applications", "Library", "node_modules"]);
const DIRNAME_MATCH_TYPES = new Set(["exact_dirname", "fuzzy_dirname"]);

interface Shard {
  readonly finder: FileFinderType;
  readonly createdAt: number;
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
 * A search root such as `~` is too large to index as one fff index, and
 * iCloud-synced folders can take minutes to scan while evicted files download.
 * Each child folder of the root is indexed as its own shard instead. A shard
 * still scanning after its budget is split into one shard per child folder, so
 * `~/Documents` becomes `~/Documents/Code`, then each repo inside it. Folder
 * names along the split path are matched from directory listings, so a repo is
 * found by name even while its own index is slow. Shards are shared across
 * roots by path and rebuilt after `SHARD_MAX_AGE_MS`. fff only knows folders
 * that directly hold files, which every project root does.
 */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const shards = new Map<string, Shard>();
  const splitUntil = new Map<string, number>();

  const destroyShard = (shardPath: string) => {
    const shard = shards.get(shardPath);
    if (!shard) return;
    shards.delete(shardPath);
    try {
      shard.finder.destroy();
    } catch {
      // Destroying an already-torn-down native index is harmless.
    }
  };

  const splitShard = (shardPath: string, now: number) => {
    destroyShard(shardPath);
    splitUntil.set(shardPath, now + SPLIT_RETRY_MS);
  };

  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [shardPath, shard] of shards) {
      if (now - shard.createdAt > SHARD_MAX_AGE_MS) destroyShard(shardPath);
    }
    for (const [shardPath, until] of splitUntil) {
      if (until <= now) splitUntil.delete(shardPath);
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const shardPath of shards.keys()) destroyShard(shardPath);
    }),
  );
  yield* sweep.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

  /** Returns the shard and whether this call created it. */
  const acquireShard = Effect.fn("DirectorySearch.acquireShard")(function* (shardPath: string) {
    const existing = shards.get(shardPath);
    if (existing) return { shard: existing, fresh: false };

    const now = yield* Clock.currentTimeMillis;
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
    if (!created?.ok) {
      splitShard(shardPath, now);
      return null;
    }
    const shard: Shard = { finder: created.value, createdAt: now };
    shards.set(shardPath, shard);
    yield* Effect.promise(() => shard.finder.waitForScan(SHARD_SCAN_BUDGET_MS)).pipe(
      Effect.andThen(() => Clock.currentTimeMillis),
      Effect.map((finishedAt) => {
        if (shards.get(shardPath) === shard && shard.finder.isScanning()) {
          splitShard(shardPath, finishedAt);
        }
      }),
      Effect.forkIn(scope),
    );
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
    const active: Array<{
      readonly relativePath: string;
      readonly path: string;
      readonly shard: Shard;
    }> = [];
    const freshShards: Shard[] = [];
    const pending = input.childNames.map((name) => ({ relativePath: name, depth: 1 }));

    for (
      let next = pending.shift();
      next !== undefined && active.length < MAX_SHARDS_PER_SEARCH;
      next = pending.shift()
    ) {
      const { relativePath, depth } = next;
      const segments = relativePath.split("/");
      const name = segments.at(-1) ?? relativePath;
      const fullPath = path.join(input.root, ...segments);
      const tier = nameTier(name, normalizedQuery);
      if (tier < 3) {
        candidates.push({ relativePath, fullPath, tier, depth, score: 0 });
      }
      if (SKIPPED_FOLDER_NAMES.has(name)) continue;

      if ((splitUntil.get(fullPath) ?? 0) > now) {
        if (depth < MAX_SPLIT_DEPTH) {
          for (const child of yield* listChildFolders(fullPath)) {
            pending.push({ relativePath: `${relativePath}/${child}`, depth: depth + 1 });
          }
        }
        continue;
      }

      const acquired = yield* acquireShard(fullPath);
      if (!acquired) continue;
      active.push({ relativePath, path: fullPath, shard: acquired.shard });
      if (acquired.fresh) freshShards.push(acquired.shard);
    }

    if (freshShards.length > 0) {
      yield* Effect.promise(() =>
        Promise.all(freshShards.map((shard) => shard.finder.waitForScan(FRESH_SHARD_WAIT_MS))),
      );
    }

    for (const { relativePath, path: shardPath, shard } of active) {
      if (shards.get(shardPath) !== shard || shard.finder.isScanning()) continue;
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
          fullPath: path.join(shardPath, ...segments),
          tier: nameTier(segments.at(-1) ?? relativeToShard, normalizedQuery),
          depth: relativePath.split("/").length + segments.length,
          score: score.total,
        });
      });
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
