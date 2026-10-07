// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import type { FilesystemSearchDirectoriesEntry } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

/** How long a query waits for a root's first walk, so the first keystroke has results. */
const FIRST_WALK_WAIT = "1 second";
/** Folder lists do not watch the filesystem; a search rewalks a root once its list is this old. */
const REWALK_AFTER_MS = 5 * 60_000;
const MAX_CACHED_ROOTS = 8;
const MAX_WALK_DEPTH = 10;
const MAX_FOLDERS_PER_ROOT = 200_000;
const WALK_CONCURRENCY = 32;
/** Folders that hold installed software rather than projects; never walked. */
const SKIPPED_FOLDER_NAMES = new Set(["Applications", "Library", "node_modules"]);
/** macOS bundles look like folders but are never projects, and are slow to list from iCloud. */
const BUNDLE_EXTENSION = /\.(app|framework|bundle|photoslibrary|musiclibrary|tvlibrary)$/i;
/** Longest normalized name checked for typos; longer names still match exactly or by substring. */
const MAX_TYPO_NAME_LENGTH = 128;

interface FolderList {
  readonly relativePaths: Array<string>;
  readonly names: Array<string>;
  readonly depths: Array<number>;
  readonly startedAt: number;
}

interface RootFolders {
  list: FolderList;
  walk: Fiber.Fiber<void> | null;
  walking: boolean;
  usedAt: number;
}

function normalizeName(input: string): string {
  const lower = input.toLowerCase();
  const compact = lower.replace(/[^\p{L}\p{N}]/gu, "");
  return compact.length > 0 ? compact : lower;
}

/**
 * Fewest single-letter edits (insert, delete, replace, or swap two neighbours)
 * that turn `query` into some substring of `name`. Rows are reused across calls.
 */
function substringTypoDistance(query: string, name: string, rows: Array<Int32Array>): number {
  let [beforePrevious, previous, current] = rows as [Int32Array, Int32Array, Int32Array];
  previous.fill(0, 0, name.length + 1);
  for (let i = 1; i <= query.length; i++) {
    current[0] = i;
    for (let j = 1; j <= name.length; j++) {
      const replaceCost = query[i - 1] === name[j - 1] ? 0 : 1;
      let distance = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + replaceCost,
      );
      if (i > 1 && j > 1 && query[i - 1] === name[j - 2] && query[i - 2] === name[j - 1]) {
        distance = Math.min(distance, beforePrevious[j - 2]! + 1);
      }
      current[j] = distance;
    }
    [beforePrevious, previous, current] = [previous, current, beforePrevious];
  }
  let best = query.length;
  for (let j = 0; j <= name.length; j++) best = Math.min(best, previous[j]!);
  return best;
}

/** Higher is better; null when the name does not match. */
function scoreName(name: string, query: string, rows: Array<Int32Array>): number | null {
  if (name === query) return 1000;
  if (name.startsWith(query)) return 900 - (name.length - query.length);
  const index = name.indexOf(query);
  if (index !== -1) return 800 - index - (name.length - query.length);
  const allowedTypos = query.length >= 8 ? 2 : query.length >= 4 ? 1 : 0;
  if (
    allowedTypos === 0 ||
    name.length < query.length - allowedTypos ||
    name.length > MAX_TYPO_NAME_LENGTH
  ) {
    return null;
  }
  const typos = substringTypoDistance(query, name, rows);
  if (typos > allowedTypos) return null;
  return 600 - typos * 100 - Math.abs(name.length - query.length);
}

const listFolder = (directory: string) =>
  Effect.promise(() =>
    NodeFSP.readdir(directory, { withFileTypes: true }).then(
      (dirents) => ({
        isRepository: dirents.some((dirent) => dirent.name === ".git"),
        children: dirents
          .filter(
            (dirent) =>
              dirent.isDirectory() &&
              !dirent.name.startsWith(".") &&
              !SKIPPED_FOLDER_NAMES.has(dirent.name) &&
              !BUNDLE_EXTENSION.test(dirent.name),
          )
          .map((dirent) => dirent.name),
      }),
      () => ({ isRepository: false, children: [] }),
    ),
  );

/**
 * Typo-tolerant folder search for the add-project picker.
 *
 * Each search root is walked once for folder names only, which stays small
 * (tens of thousands of short paths) where an index of every file under `~`
 * would hold hundreds of thousands. The walk does not descend into git
 * repositories, since folders inside a project are not projects to add, and it
 * skips app bundles, which can take minutes to list from iCloud. Searches see
 * folders as soon as the walk finds them, and a stale list is rewalked in the
 * background while the old one keeps answering.
 */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const roots = new Map<string, RootFolders>();

  const walkFolders = Effect.fn("DirectorySearch.walkFolders")(function* (
    root: string,
    list: FolderList,
  ) {
    const permits = yield* Semaphore.make(WALK_CONCURRENCY);
    const visit = (relativePath: string, depth: number): Effect.Effect<void> =>
      permits
        .withPermits(1)(listFolder(path.join(root, ...relativePath.split("/"))))
        .pipe(
          Effect.flatMap(({ isRepository, children }) => {
            if ((depth > 0 && isRepository) || depth >= MAX_WALK_DEPTH) return Effect.void;
            const childPaths: Array<string> = [];
            for (const child of children) {
              if (list.relativePaths.length >= MAX_FOLDERS_PER_ROOT) break;
              const childPath = relativePath ? `${relativePath}/${child}` : child;
              list.relativePaths.push(childPath);
              list.names.push(normalizeName(child));
              list.depths.push(depth + 1);
              childPaths.push(childPath);
            }
            return Effect.forEach(childPaths, (childPath) => visit(childPath, depth + 1), {
              concurrency: "unbounded",
              discard: true,
            });
          }),
        );
    yield* visit("", 0);
  });

  const startWalk = Effect.fn("DirectorySearch.startWalk")(function* (
    root: string,
    entry: RootFolders,
    list: FolderList,
  ) {
    entry.walking = true;
    entry.walk = yield* walkFolders(root, list).pipe(
      Effect.andThen(
        Effect.sync(() => {
          entry.list = list;
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          entry.walking = false;
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const emptyList = (startedAt: number): FolderList => ({
    relativePaths: [],
    names: [],
    depths: [],
    startedAt,
  });

  const search = Effect.fn("DirectorySearch.search")(function* (input: {
    readonly root: string;
    readonly query: string;
    readonly limit: number;
  }) {
    const now = yield* Clock.currentTimeMillis;
    let entry = roots.get(input.root);
    if (!entry) {
      entry = { list: emptyList(now), walk: null, walking: false, usedAt: now };
      roots.set(input.root, entry);
      if (roots.size > MAX_CACHED_ROOTS) {
        const [oldestRoot, oldest] = [...roots].reduce((left, right) =>
          right[1].usedAt < left[1].usedAt ? right : left,
        );
        roots.delete(oldestRoot);
        if (oldest.walk) yield* Fiber.interrupt(oldest.walk).pipe(Effect.forkIn(scope));
      }
      yield* startWalk(input.root, entry, entry.list);
      if (entry.walk) {
        yield* Fiber.join(entry.walk).pipe(Effect.timeoutOption(FIRST_WALK_WAIT), Effect.exit);
      }
    } else if (!entry.walking && now - entry.list.startedAt > REWALK_AFTER_MS) {
      yield* startWalk(input.root, entry, emptyList(now));
    }
    entry.usedAt = now;

    const { relativePaths, names, depths } = entry.list;
    const query = normalizeName(input.query);
    const rows = Array.from({ length: 3 }, () => new Int32Array(MAX_TYPO_NAME_LENGTH + 1));
    const matches: Array<{ readonly index: number; readonly score: number }> = [];
    for (let index = 0; index < names.length; index++) {
      const score = scoreName(names[index]!, query, rows);
      // Shallower folders win ties, so `~/Code/app` beats `~/Code/app/packages/app`.
      if (score !== null) matches.push({ index, score: score - depths[index]! });
    }
    return matches
      .toSorted(
        (left, right) =>
          right.score - left.score ||
          relativePaths[left.index]!.localeCompare(relativePaths[right.index]!),
      )
      .slice(0, input.limit)
      .map(({ index }): FilesystemSearchDirectoriesEntry => ({
        relativePath: relativePaths[index]!,
        fullPath: path.join(input.root, ...relativePaths[index]!.split("/")),
      }));
  });

  return { search };
});
