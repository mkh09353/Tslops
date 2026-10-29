import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PullRequestInboxEntry, PullRequestReviewThread } from "@t3tools/contracts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";

/** What the user decided about one review thread before handing the PR back to its agent. */
export type ReviewThreadVerdict = "fix" | "decline";

export interface InboxAttention {
  readonly unresolved: ReadonlyArray<PullRequestReviewThread>;
  /** Unresolved threads whose latest word is not the viewer's: someone is waiting on a reply. */
  readonly awaitingReply: number;
  readonly conflicting: boolean;
  readonly checksFailing: boolean;
  readonly changesRequested: boolean;
  /** Something an agent can act on: open feedback, a conflict, or red checks. */
  readonly actionable: boolean;
}

export function inboxAttention(entry: PullRequestInboxEntry, viewer: string): InboxAttention {
  const unresolved = entry.reviewThreads.filter((thread) => !thread.isResolved);
  const awaitingReply = unresolved.filter(
    (thread) => thread.comments.at(-1)?.author?.login.toLowerCase() !== viewer.toLowerCase(),
  ).length;
  const conflicting = entry.mergeability === "conflicting";
  const checksFailing = entry.checksState === "failing";
  const changesRequested = entry.reviewDecision === "changes-requested";
  return {
    unresolved,
    awaitingReply,
    conflicting,
    checksFailing,
    changesRequested,
    actionable: unresolved.length > 0 || conflicting || checksFailing || changesRequested,
  };
}

/** Labels such as `ready-for-review` or `Ready to merge`, but not `not ready`. */
export function isReadyLabel(name: string): boolean {
  return /\bready\b/i.test(name) && !/\bnot[\s_-]*ready\b/i.test(name);
}

export interface InboxRepositoryGroup {
  readonly repository: string;
  readonly entries: ReadonlyArray<PullRequestInboxEntry>;
}

/** One section per repository, alphabetical; newest activity first inside each. */
export function groupInboxByRepository(
  entries: ReadonlyArray<PullRequestInboxEntry>,
): ReadonlyArray<InboxRepositoryGroup> {
  const groups = new Map<string, PullRequestInboxEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.repository);
    if (group) group.push(entry);
    else groups.set(entry.repository, [entry]);
  }
  return [...groups]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([repository, group]) => ({
      repository,
      entries: group.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    }));
}

/**
 * The threads that worked on a pull request, best first: the one that opened it, then any other
 * link, then a thread whose branch merely points at it. Archived threads are left out.
 */
export function linkedThreadsForPullRequest(
  entry: Pick<PullRequestInboxEntry, "host" | "repository" | "number" | "url">,
  shells: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const key = threadPullRequestKeyOf(entry);
  const ranked: Array<{ readonly shell: EnvironmentThreadShell; readonly rank: number }> = [];
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    const link = visibleThreadPullRequests(shell.pullRequests).find(
      (candidate) => threadPullRequestKeyOf(candidate) === key,
    );
    const rank =
      link?.source === "created"
        ? 0
        : link !== undefined
          ? 1
          : shell.branchPullRequest != null &&
              threadPullRequestKeyOf(legacyThreadPullRequestKey(shell.branchPullRequest)) === key
            ? 2
            : null;
    if (rank !== null) ranked.push({ shell, rank });
  }
  return ranked
    .toSorted(
      (left, right) =>
        left.rank - right.rank || right.shell.updatedAt.localeCompare(left.shell.updatedAt),
    )
    .map(({ shell }) => shell);
}

function threadLocation(thread: PullRequestReviewThread): string {
  return thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
}

function threadExcerpt(thread: PullRequestReviewThread): string {
  const first = thread.comments[0];
  const text = (first?.body ?? "").replace(/\s+/g, " ").trim();
  const excerpt = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  const author = first?.author?.login ?? "someone";
  return `${threadLocation(thread)} (${author}): "${excerpt}"${first?.url ? ` ${first.url}` : ""}`;
}

/**
 * The message sent to the thread that owns a pull request. The agent judges each comment unless
 * the user already did; their calls are listed so it does not second-guess them.
 */
export function buildAddressFeedbackPrompt(
  entry: PullRequestInboxEntry,
  attention: InboxAttention,
  verdicts: ReadonlyMap<string, ReviewThreadVerdict>,
): string {
  const lines = [
    `Address the open feedback on ${entry.url} (${entry.repository}#${entry.number}, branch \`${entry.headBranch}\`).`,
    "",
  ];
  if (attention.unresolved.length > 0) {
    lines.push(
      `There ${attention.unresolved.length === 1 ? "is 1 unresolved review thread" : `are ${attention.unresolved.length} unresolved review threads`}. Read each one with \`gh\`. For each:`,
      "- If it is right, fix it, reply briefly with what changed, and resolve the thread.",
      "- If it is wrong, out of scope, or not worth the churn, reply with a short reason and resolve it. Do not make changes just to satisfy a reviewer bot.",
    );
  }
  const fixes = attention.unresolved.filter((thread) => verdicts.get(thread.id) === "fix");
  const declines = attention.unresolved.filter((thread) => verdicts.get(thread.id) === "decline");
  if (fixes.length > 0 || declines.length > 0) {
    lines.push("", "I already made these calls; follow them:");
    for (const thread of fixes) lines.push(`- Fix: ${threadExcerpt(thread)}`);
    for (const thread of declines)
      lines.push(`- Decline (reply and resolve): ${threadExcerpt(thread)}`);
  }
  if (attention.changesRequested && attention.unresolved.length === 0) {
    lines.push(
      "- A reviewer requested changes. Read the latest reviews and address what they asked for.",
    );
  }
  if (attention.conflicting) {
    lines.push(
      `- The branch conflicts with \`${entry.baseBranch}\`. Bring in \`${entry.baseBranch}\` and resolve the conflicts.`,
    );
  }
  if (attention.checksFailing) {
    lines.push("- Checks are failing. Find out why and fix what belongs to this change.");
  }
  lines.push("", "When you are done, push the branch and give me a one-line summary per item.");
  return lines.join("\n");
}
