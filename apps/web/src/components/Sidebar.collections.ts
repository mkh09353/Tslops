import type { EnvironmentId, OrchestrationV2ThreadCollection } from "@t3tools/contracts";

import { isSidebarSubagentThread, resolveSidebarThreadStatus } from "./Sidebar.logic";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";
import type { SidebarThreadSummary } from "../types";

/** A collection as the sidebar shows it: the threads that share a collection id on one server. */
export interface SidebarCollection {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly title: string;
  readonly threadCount: number;
  /** The member state worth surfacing on the row: the user's turn outranks motion. */
  readonly attention: "approval" | "input" | "failed" | "working" | null;
}

type CollectionThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "lineage"
  | "collection"
  | "updatedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "runtime"
> & { readonly environmentId: EnvironmentId };

const ATTENTION_RANK = { approval: 4, input: 3, failed: 2, working: 1 } as const;

function sidebarCollectionKey(environmentId: string, collectionId: string): string {
  return `${environmentId}:${collectionId}`;
}

export function isThreadInSidebarCollection(
  thread: Pick<CollectionThread, "collection"> & { readonly environmentId: string },
  collectionKey: string,
): boolean {
  return (
    thread.collection != null &&
    sidebarCollectionKey(thread.environmentId, thread.collection.id) === collectionKey
  );
}

/**
 * Collections exist while a visible thread is in them. A rename lands on each
 * member separately, so the most recently updated member's title wins until
 * the rest catch up. Sorted by title so rows never jump while threads work.
 */
export function groupSidebarCollections(threads: readonly CollectionThread[]): SidebarCollection[] {
  const groups = new Map<
    string,
    {
      environmentId: EnvironmentId;
      id: string;
      title: string;
      titleUpdatedAt: string;
      threadCount: number;
      attention: SidebarCollection["attention"];
    }
  >();
  for (const thread of threads) {
    const collection = thread.collection;
    if (collection == null || thread.archivedAt !== null || isSidebarSubagentThread(thread)) {
      continue;
    }
    const key = sidebarCollectionKey(thread.environmentId, collection.id);
    const status = resolveSidebarThreadStatus(thread);
    const attention =
      status === "approval" || status === "input" || status === "failed" || status === "working"
        ? status
        : null;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        environmentId: thread.environmentId,
        id: collection.id,
        title: collection.title,
        titleUpdatedAt: thread.updatedAt,
        threadCount: 1,
        attention,
      });
      continue;
    }
    group.threadCount += 1;
    if (thread.updatedAt > group.titleUpdatedAt) {
      group.title = collection.title;
      group.titleUpdatedAt = thread.updatedAt;
    }
    if (
      attention !== null &&
      (group.attention === null || ATTENTION_RANK[attention] > ATTENTION_RANK[group.attention])
    ) {
      group.attention = attention;
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      environmentId: group.environmentId,
      id: group.id,
      title: group.title,
      threadCount: group.threadCount,
      attention: group.attention,
    }))
    .toSorted(
      (left, right) => left.title.localeCompare(right.title) || left.key.localeCompare(right.key),
    );
}

/** Every collection, read at call time for menus that open outside the sidebar. */
export function readSidebarCollections(): SidebarCollection[] {
  return groupSidebarCollections(appAtomRegistry.get(environmentThreadShells.threadShellsAtom));
}

/** A fresh collection id; the server only requires it to be unique and non-empty. */
export function newSidebarCollectionId(): string {
  return `collection:${randomUUID()}`;
}

/** The thread menu's Collection submenu state; null where collections are unsupported. */
export function threadCollectionMenuState(
  thread: Pick<CollectionThread, "collection"> & { readonly environmentId: string },
  collections: readonly SidebarCollection[],
  supported: boolean,
) {
  if (!supported) return null;
  return {
    currentKey:
      thread.collection == null
        ? null
        : sidebarCollectionKey(thread.environmentId, thread.collection.id),
    options: collections
      .filter((collection) => collection.environmentId === thread.environmentId)
      .map((collection) => ({ key: collection.key, title: collection.title })),
  };
}

export interface ThreadCollectionChange {
  readonly collection: OrchestrationV2ThreadCollection | null;
  readonly generateTitle?: boolean;
}

/**
 * What a Collection menu pick does to one thread. A new collection starts with
 * the thread's title as a placeholder until the generated title lands.
 */
export function resolveThreadCollectionMenuAction(
  action: string,
  thread: { readonly title: string },
  collections: readonly SidebarCollection[],
): ThreadCollectionChange | null {
  if (action === "collection:new") {
    return {
      collection: { id: newSidebarCollectionId(), title: thread.title.trim() || "New collection" },
      generateTitle: true,
    };
  }
  if (action === "collection:leave") return { collection: null };
  if (action.startsWith("collection:join:")) {
    const key = action.slice("collection:join:".length);
    const target = collections.find((collection) => collection.key === key);
    return target ? { collection: { id: target.id, title: target.title } } : null;
  }
  return null;
}
