import { describe, expect, it } from "vite-plus/test";

import { toPullRequestInbox } from "./gitHubPullRequestJson.ts";

const pullRequestNode = (overrides: Record<string, unknown> = {}) => ({
  __typename: "PullRequest",
  number: 7,
  title: "Add the inbox",
  url: "https://github.com/acme/web/pull/7",
  headRefName: "feat/inbox",
  baseRefName: "main",
  isDraft: false,
  mergeable: "CONFLICTING",
  reviewDecision: "CHANGES_REQUESTED",
  updatedAt: "2026-10-02T00:00:00Z",
  repository: { nameWithOwner: "acme/web" },
  latestReviews: { nodes: [] },
  labels: { nodes: [{ name: "ready-for-review", color: "0e8a16" }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  reviewThreads: {
    totalCount: 3,
    nodes: [
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        path: "src/a.ts",
        line: 12,
        diffSide: "RIGHT",
        comments: {
          totalCount: 1,
          nodes: [
            {
              id: "C1",
              author: {
                __typename: "Bot",
                login: "greptile-apps",
                avatarUrl: "https://avatars.githubusercontent.com/u/1",
              },
              body: "x".repeat(5_000),
              createdAt: "2026-10-02T00:00:00Z",
              lastEditedAt: null,
              url: "https://github.com/acme/web/pull/7#discussion_r1",
            },
          ],
        },
      },
      {
        id: "T2",
        isResolved: true,
        isOutdated: true,
        path: "src/b.ts",
        line: null,
        diffSide: "RIGHT",
        comments: { totalCount: 0, nodes: [] },
      },
    ],
  },
  ...overrides,
});

const inbox = (nodes: ReadonlyArray<unknown>, hasNextPage = false) => ({
  viewer: { login: "max" },
  search: { pageInfo: { hasNextPage }, nodes },
});

describe("toPullRequestInbox", () => {
  it("carries status and review threads for each open pull request", () => {
    const result = toPullRequestInbox(inbox([pullRequestNode()], true), "github.com");
    expect(result?.viewer).toBe("max");
    expect(result?.truncated).toBe(true);
    const entry = result?.entries[0];
    expect(entry).toMatchObject({
      host: "github.com",
      repository: "acme/web",
      mergeability: "conflicting",
      reviewDecision: "changes-requested",
      checksState: "failing",
      labels: [{ name: "ready-for-review", color: "0e8a16" }],
      // Three threads exist and two were read, one of them empty.
      reviewThreadsTruncated: true,
    });
    // The empty thread is dropped; the bot's essay is cut down.
    expect(entry?.reviewThreads.map((thread) => thread.id)).toEqual(["T1"]);
    const comment = entry?.reviewThreads[0]?.comments[0];
    expect(comment?.author?.isBot).toBe(true);
    expect(comment?.body.length).toBeLessThan(4_100);
  });

  it("skips a node it cannot read rather than failing the inbox", () => {
    const result = toPullRequestInbox(
      inbox([{ __typename: "PullRequest", number: "not a number" }, pullRequestNode()]),
      "github.com",
    );
    expect(result?.entries).toHaveLength(1);
  });
});
