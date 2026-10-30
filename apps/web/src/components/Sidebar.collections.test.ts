import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupSidebarCollections,
  isThreadInSidebarCollection,
  resolveThreadCollectionMenuAction,
  threadCollectionMenuState,
} from "./Sidebar.collections";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");

function thread(
  overrides: Partial<Parameters<typeof groupSidebarCollections>[0][number]> = {},
): Parameters<typeof groupSidebarCollections>[0][number] {
  return {
    environmentId: local,
    archivedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread" as never },
    collection: { id: "collection:forms", title: "Intake Forms" },
    updatedAt: "2026-10-29T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    ...overrides,
  } as Parameters<typeof groupSidebarCollections>[0][number];
}

describe("groupSidebarCollections", () => {
  it("groups members per server, counts them, and sorts by title", () => {
    const collections = groupSidebarCollections([
      thread(),
      thread(),
      thread({ collection: { id: "collection:billing", title: "Billing" } }),
      thread({ environmentId: remote }),
      thread({ collection: null }),
    ]);
    expect(collections.map(({ title, threadCount }) => [title, threadCount])).toEqual([
      ["Billing", 1],
      ["Intake Forms", 2],
      ["Intake Forms", 1],
    ]);
  });

  it("leaves out archived and subagent threads, so an emptied collection disappears", () => {
    expect(
      groupSidebarCollections([
        thread({ archivedAt: "2026-10-29T11:00:00.000Z" }),
        thread({
          lineage: {
            parentThreadId: "parent" as never,
            relationshipToParent: "subagent",
            rootThreadId: "parent" as never,
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("takes the title from the most recently updated member while a rename lands", () => {
    const [collection] = groupSidebarCollections([
      thread({ collection: { id: "collection:forms", title: "Old name" } }),
      thread({
        collection: { id: "collection:forms", title: "New name" },
        updatedAt: "2026-10-29T12:00:00.000Z",
      }),
    ]);
    expect(collection?.title).toBe("New name");
  });

  it("surfaces the member that needs the user over one that is working", () => {
    const [collection] = groupSidebarCollections([
      thread({ runtime: { status: "running" } as never }),
      thread({ hasPendingUserInput: true }),
    ]);
    expect(collection?.attention).toBe("input");
  });
});

describe("collection menu", () => {
  const collections = groupSidebarCollections([
    thread(),
    thread({ environmentId: remote, collection: { id: "collection:ops", title: "Ops" } }),
  ]);

  it("offers only collections on the thread's own server and checks the current one", () => {
    const state = threadCollectionMenuState(thread(), collections, true);
    expect(state?.options.map((option) => option.title)).toEqual(["Intake Forms"]);
    expect(state?.currentKey).toBe(collections.find((c) => c.title === "Intake Forms")?.key);
    expect(threadCollectionMenuState(thread(), collections, false)).toBeNull();
  });

  it("starts a new collection titled after the thread and asks for a generated title", () => {
    const change = resolveThreadCollectionMenuAction(
      "collection:new",
      { title: "Form renderer" },
      collections,
    );
    expect(change?.collection?.title).toBe("Form renderer");
    expect(change?.generateTitle).toBe(true);
  });

  it("joins an existing collection with its current title and leaves with null", () => {
    const target = collections.find((c) => c.title === "Intake Forms")!;
    expect(
      resolveThreadCollectionMenuAction(
        `collection:join:${target.key}`,
        { title: "x" },
        collections,
      ),
    ).toEqual({ collection: { id: "collection:forms", title: "Intake Forms" } });
    expect(
      resolveThreadCollectionMenuAction("collection:leave", { title: "x" }, collections),
    ).toEqual({ collection: null });
    expect(resolveThreadCollectionMenuAction("pin", { title: "x" }, collections)).toBeNull();
  });

  it("matches threads to a collection key on their own server only", () => {
    const key = collections.find((c) => c.title === "Intake Forms")!.key;
    expect(isThreadInSidebarCollection(thread(), key)).toBe(true);
    expect(isThreadInSidebarCollection(thread({ environmentId: remote }), key)).toBe(false);
  });
});
