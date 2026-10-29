import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PullRequestInboxEntry, PullRequestReviewThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAddressFeedbackPrompt,
  groupInboxByRepository,
  inboxAttention,
  isReadyLabel,
  linkedThreadsForPullRequest,
} from "./pullRequestInbox.logic";

const thread = (
  id: string,
  isResolved: boolean,
  lastAuthor: string,
  body = "Rename this",
): PullRequestReviewThread => ({
  id,
  path: "src/a.ts",
  line: 4,
  side: "right",
  isResolved,
  isOutdated: false,
  comments: [
    {
      id: `${id}-1`,
      author: { login: "greptile-apps", name: null, avatarUrl: null, isBot: true },
      body,
      createdAt: "2026-10-01T00:00:00Z",
      url: `https://github.com/acme/web/pull/7#${id}`,
    },
    ...(lastAuthor === "greptile-apps"
      ? []
      : [
          {
            id: `${id}-2`,
            author: { login: lastAuthor, name: null, avatarUrl: null },
            body: "Done",
            createdAt: "2026-10-02T00:00:00Z",
            url: null,
          },
        ]),
  ],
});

const entry = (overrides: Partial<PullRequestInboxEntry> = {}): PullRequestInboxEntry => ({
  host: "github.com",
  repository: "acme/web",
  number: 7,
  title: "Add the inbox",
  url: "https://github.com/acme/web/pull/7",
  headBranch: "feat/inbox",
  baseBranch: "main",
  isDraft: false,
  mergeability: "mergeable",
  reviewDecision: null,
  checksState: "passing",
  labels: [],
  updatedAt: "2026-10-02T00:00:00Z",
  reviewThreads: [],
  reviewThreadsTruncated: false,
  ...overrides,
});

const shell = (overrides: Partial<EnvironmentThreadShell>): EnvironmentThreadShell =>
  ({
    environmentId: "env",
    id: "thread",
    title: "Thread",
    archivedAt: null,
    updatedAt: "2026-10-01T00:00:00Z",
    pullRequests: [],
    branchPullRequest: null,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const link = (source: "created" | "manual" | "stack-dismissed") => ({
  host: "github.com",
  repository: "acme/web",
  number: 7,
  url: "https://github.com/acme/web/pull/7",
  source,
  linkedAt: "2026-10-01T00:00:00Z",
  snapshot: null,
  stack: null,
});

describe("inboxAttention", () => {
  it("counts unresolved threads and those still waiting on the author", () => {
    const attention = inboxAttention(
      entry({
        reviewThreads: [
          thread("a", false, "greptile-apps"),
          thread("b", false, "Max"),
          thread("c", true, "greptile-apps"),
        ],
      }),
      "max",
    );
    expect(attention.unresolved.map((item) => item.id)).toEqual(["a", "b"]);
    expect(attention.awaitingReply).toBe(1);
    expect(attention.actionable).toBe(true);
  });

  it("is quiet for a clean, approved pull request", () => {
    expect(inboxAttention(entry({ reviewDecision: "approved" }), "max").actionable).toBe(false);
    expect(inboxAttention(entry({ mergeability: "conflicting" }), "max").actionable).toBe(true);
  });
});

describe("isReadyLabel", () => {
  it("recognizes ready labels but not their negation", () => {
    expect(isReadyLabel("ready-for-review")).toBe(true);
    expect(isReadyLabel("Ready to merge")).toBe(true);
    expect(isReadyLabel("not-ready")).toBe(false);
    expect(isReadyLabel("already-merged")).toBe(false);
  });
});

describe("groupInboxByRepository", () => {
  it("groups alphabetically with the newest pull request first", () => {
    const groups = groupInboxByRepository([
      entry({ repository: "acme/web", number: 1, updatedAt: "2026-10-01T00:00:00Z" }),
      entry({ repository: "acme/api", number: 2 }),
      entry({ repository: "acme/web", number: 3, updatedAt: "2026-10-03T00:00:00Z" }),
    ]);
    expect(groups.map((group) => group.repository)).toEqual(["acme/api", "acme/web"]);
    expect(groups[1]?.entries.map((item) => item.number)).toEqual([3, 1]);
  });
});

describe("linkedThreadsForPullRequest", () => {
  it("prefers the thread that opened the pull request and skips archived or dismissed ones", () => {
    const threads = linkedThreadsForPullRequest(entry(), [
      shell({ id: "manual" as never, pullRequests: [link("manual")] as never }),
      shell({ id: "creator" as never, pullRequests: [link("created")] as never }),
      shell({ id: "dismissed" as never, pullRequests: [link("stack-dismissed")] as never }),
      shell({
        id: "archived" as never,
        archivedAt: "2026-10-01T00:00:00Z",
        pullRequests: [link("created")] as never,
      }),
      shell({
        id: "branch" as never,
        branchPullRequest: {
          projectId: "p" as never,
          repository: "acme/web",
          number: 7,
          url: "https://github.com/acme/web/pull/7",
        },
      }),
    ]);
    expect(threads.map((item) => item.id)).toEqual(["creator", "manual", "branch"]);
  });
});

describe("buildAddressFeedbackPrompt", () => {
  it("names the pull request, the user's calls, and the other blockers", () => {
    const pullRequest = entry({
      mergeability: "conflicting",
      checksState: "failing",
      reviewThreads: [thread("a", false, "greptile-apps", "Use a map"), thread("b", false, "x")],
    });
    const prompt = buildAddressFeedbackPrompt(
      pullRequest,
      inboxAttention(pullRequest, "max"),
      new Map([["b", "decline"]]),
    );
    expect(prompt).toContain("https://github.com/acme/web/pull/7");
    expect(prompt).toContain("2 unresolved review threads");
    expect(prompt).toContain(
      'Decline (reply and resolve): src/a.ts:4 (greptile-apps): "Rename this"',
    );
    expect(prompt).not.toContain("Fix: ");
    expect(prompt).toContain("conflicts with `main`");
    expect(prompt).toContain("Checks are failing");
    expect(prompt).toContain("push the branch");
  });
});
