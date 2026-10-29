import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestInboxEntry,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { cn, newMessageId } from "~/lib/utils";
import { useProjects, useThreadShells } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  buildAddressFeedbackPrompt,
  groupInboxByRepository,
  inboxAttention,
  isReadyLabel,
  linkedThreadsForPullRequest,
  type InboxAttention,
  type ReviewThreadVerdict,
} from "./pullRequestInbox.logic";

type InboxFilter = "all" | "attention";
type Verdicts = ReadonlyMap<string, ReviewThreadVerdict>;

interface InboxRow {
  readonly entry: PullRequestInboxEntry;
  readonly attention: InboxAttention;
  readonly owner: EnvironmentThreadShell | null;
}

/** Sends the feedback prompt to a pull request's thread, queued behind any running turn. */
function useAddressFeedback() {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return useCallback(
    async (row: InboxRow, verdicts: Verdicts): Promise<boolean> => {
      if (row.owner === null) return false;
      const result = await startTurn({
        environmentId: row.owner.environmentId,
        input: {
          threadId: row.owner.id,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: buildAddressFeedbackPrompt(row.entry, row.attention, verdicts),
            attachments: [],
          },
          runtimeMode: row.owner.runtimeMode,
          interactionMode: row.owner.interactionMode,
          dispatchMode: "queue",
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not send #${row.entry.number} to its thread`,
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      return true;
    },
    [startTurn],
  );
}

export function PullRequestInbox() {
  const environmentId = usePrimaryEnvironmentId();
  const inbox = useEnvironmentQuery(
    environmentId === null ? null : pullRequestEnvironment.inbox({ environmentId, input: {} }),
  );
  const shells = useThreadShells();
  const [filter, setFilter] = useState<InboxFilter>("all");

  const rows = useMemo((): ReadonlyArray<InboxRow> => {
    const data = inbox.data;
    if (data === null) return [];
    return data.entries.map((entry) => ({
      entry,
      attention: inboxAttention(entry, data.viewer),
      owner: linkedThreadsForPullRequest(entry, shells)[0] ?? null,
    }));
  }, [inbox.data, shells]);
  const visible = filter === "all" ? rows : rows.filter((row) => row.attention.actionable);
  const groups = useMemo(() => {
    const byUrl = new Map(visible.map((row) => [row.entry.url, row]));
    return groupInboxByRepository(visible.map((row) => row.entry)).map((group) => ({
      repository: group.repository,
      rows: group.entries.map((entry) => byUrl.get(entry.url)!),
    }));
  }, [visible]);
  const attentionCount = rows.filter((row) => row.attention.actionable).length;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <h1 className="truncate font-medium text-sm">My pull requests</h1>
        {inbox.data ? (
          <span className="truncate text-muted-foreground text-xs">
            {rows.length} open · {attentionCount} need attention
            {inbox.data.truncated ? " · showing the 50 most recent" : ""}
          </span>
        ) : null}
        <div className="ms-auto flex items-center gap-1.5 [-webkit-app-region:no-drag]">
          <ToggleGroup
            aria-label="Filter pull requests"
            value={[filter]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "all" || value === "attention") setFilter(value);
            }}
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="attention">Needs attention</ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="ghost-muted"
            size="xs"
            render={<Link to="/pull-requests" search={readPullRequestListPreferences()} />}
          >
            Browse all
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Refresh"
            disabled={inbox.isPending}
            onClick={() => inbox.refresh()}
          >
            <RefreshIcon refreshing={inbox.isPending} />
          </Button>
        </div>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-(--workspace-gutter-start) pt-2 pb-12">
          {inbox.data === null ? (
            inbox.error !== null ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Could not load your pull requests</EmptyTitle>
                  <EmptyDescription>{inbox.error}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex justify-center py-16">
                <Spinner />
              </div>
            )
          ) : groups.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {filter === "attention" ? "Nothing needs you" : "No open pull requests"}
                </EmptyTitle>
                <EmptyDescription>
                  {filter === "attention"
                    ? "No unresolved comments, conflicts, or failing checks."
                    : "Pull requests you open on GitHub show up here."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            groups.map((group) => (
              <RepositorySection
                key={group.repository}
                repository={group.repository}
                rows={group.rows}
                environmentId={environmentId}
              />
            ))
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function RepositorySection({
  repository,
  rows,
  environmentId,
}: {
  repository: string;
  rows: ReadonlyArray<InboxRow>;
  environmentId: EnvironmentId | null;
}) {
  const addressFeedback = useAddressFeedback();
  const [sending, setSending] = useState(false);
  const sendable = rows.filter((row) => row.attention.actionable && row.owner !== null);
  const addressAll = async () => {
    setSending(true);
    const sent = await Promise.all(sendable.map((row) => addressFeedback(row, new Map())));
    setSending(false);
    const count = sent.filter(Boolean).length;
    if (count > 0) {
      toastManager.add({
        type: "success",
        title: `Sent ${count} pull request${count === 1 ? "" : "s"} back to their threads`,
      });
    }
  };
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-7 items-center gap-2">
        <h2 className="truncate font-mono text-muted-foreground text-xs">{repository}</h2>
        <span className="text-muted-foreground/60 text-xs">{rows.length}</span>
        {sendable.length > 1 ? (
          <Button
            variant="ghost-muted"
            size="xs"
            className="ms-auto"
            disabled={sending}
            onClick={() => void addressAll()}
          >
            {sending ? <Spinner /> : <SparklesIcon />}
            Address all ({sendable.length})
          </Button>
        ) : null}
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {rows.map((row) => (
          <InboxRowItem key={row.entry.url} row={row} environmentId={environmentId} />
        ))}
      </ul>
    </section>
  );
}

const InboxRowItem = memo(function InboxRowItem({
  row,
  environmentId,
}: {
  row: InboxRow;
  environmentId: EnvironmentId | null;
}) {
  const { entry, attention, owner } = row;
  const navigate = useNavigate();
  const addressFeedback = useAddressFeedback();
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [verdicts, setVerdicts] = useState<Verdicts>(new Map());
  const readyLabels = entry.labels.filter((label) => isReadyLabel(label.name));
  const resolvedCount = entry.reviewThreads.length - attention.unresolved.length;

  const send = async () => {
    setSending(true);
    const sent = await addressFeedback(row, verdicts);
    setSending(false);
    if (sent && owner !== null) {
      toastManager.add({
        type: "success",
        title: `Sent #${entry.number} to "${owner.title}"`,
        actionProps: {
          children: "Open thread",
          onClick: () =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: owner.environmentId, threadId: owner.id },
            }),
        },
      });
    }
  };

  const addressDisabledReason =
    owner === null
      ? "No T3 thread is linked to this pull request."
      : !attention.actionable
        ? "Nothing to address."
        : null;

  return (
    <li className="bg-card">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {entry.isDraft ? (
            <PullRequestGlyph.draft className="size-4" />
          ) : (
            <PullRequestGlyph.pullRequest className="size-4 text-success-foreground" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <a
              href={entry.url}
              target="_blank"
              rel="noreferrer"
              className="truncate font-medium text-sm hover:underline"
            >
              {entry.title}
            </a>
            <span className="shrink-0 text-muted-foreground text-xs">#{entry.number}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {entry.isDraft ? <Badge variant="outline">Draft</Badge> : null}
            {readyLabels.map((label) => (
              <Badge key={label.name} variant="success">
                {label.name}
              </Badge>
            ))}
            {attention.conflicting ? (
              <Badge variant="error">
                <PullRequestGlyph.conflicting />
                Conflicts
              </Badge>
            ) : null}
            <ChecksBadge state={entry.checksState} />
            <ReviewBadge decision={entry.reviewDecision} />
            {attention.unresolved.length > 0 ? (
              <Badge
                variant="warning"
                render={<button type="button" onClick={() => setExpanded((open) => !open)} />}
              >
                <MessageSquareIcon />
                {attention.unresolved.length} unresolved
                {attention.awaitingReply > 0 &&
                attention.awaitingReply < attention.unresolved.length
                  ? ` · ${attention.awaitingReply} awaiting reply`
                  : ""}
                {entry.reviewThreadsTruncated ? "+" : ""}
              </Badge>
            ) : resolvedCount > 0 ? (
              <Badge variant="outline">
                <CheckIcon />
                {resolvedCount} resolved
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <span className="truncate font-mono">{entry.headBranch}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">updated {formatRelativeTimeLabel(entry.updatedAt)}</span>
            <span aria-hidden>·</span>
            {owner === null ? (
              <span className="shrink-0 text-muted-foreground/60">no linked thread</span>
            ) : (
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: owner.environmentId, threadId: owner.id }}
                className="truncate hover:text-foreground hover:underline"
              >
                {owner.title}
              </Link>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {attention.unresolved.length > 0 ? (
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={expanded ? "Hide comments" : "Show comments"}
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              <ChevronRightIcon className={cn(expanded && "rotate-90")} />
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="xs"
                  disabled={addressDisabledReason !== null || sending}
                  onClick={() => void send()}
                />
              }
            >
              {sending ? <Spinner /> : <SparklesIcon />}
              Address
            </TooltipTrigger>
            <TooltipPopup>
              {addressDisabledReason ??
                `Queue a message in "${owner?.title}" to fix, reply to, and resolve this feedback, then push.`}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {expanded && attention.unresolved.length > 0 ? (
        <ReviewThreadList
          threads={attention.unresolved}
          verdicts={verdicts}
          onVerdict={(threadId, verdict) =>
            setVerdicts((current) => {
              const next = new Map(current);
              if (verdict === null) next.delete(threadId);
              else next.set(threadId, verdict);
              return next;
            })
          }
          environmentId={environmentId}
          owner={owner}
        />
      ) : null}
    </li>
  );
});

function ChecksBadge({ state }: { state: PullRequestInboxEntry["checksState"] }) {
  switch (state) {
    case "failing":
      return (
        <Badge variant="error">
          <XIcon />
          Checks failing
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="warning">
          <CircleDotIcon />
          Checks running
        </Badge>
      );
    case "passing":
      return (
        <Badge variant="success">
          <CheckIcon />
          Checks pass
        </Badge>
      );
    case null:
      return null;
  }
}

function ReviewBadge({ decision }: { decision: PullRequestInboxEntry["reviewDecision"] }) {
  switch (decision) {
    case "approved":
      return <Badge variant="success">Approved</Badge>;
    case "changes-requested":
      return <Badge variant="error">Changes requested</Badge>;
    case "review-required":
      return <Badge variant="outline">Review required</Badge>;
    case null:
      return null;
  }
}

function ReviewThreadList({
  threads,
  verdicts,
  onVerdict,
  environmentId,
  owner,
}: {
  threads: ReadonlyArray<PullRequestReviewThread>;
  verdicts: Verdicts;
  onVerdict: (threadId: string, verdict: ReviewThreadVerdict | null) => void;
  environmentId: EnvironmentId | null;
  owner: EnvironmentThreadShell | null;
}) {
  const projects = useProjects();
  // Private GitHub images in a remark load through a checkout's credentials.
  const cwd =
    projects.find(
      (project) =>
        owner !== null &&
        project.environmentId === owner.environmentId &&
        project.id === owner.projectId,
    )?.workspaceRoot ?? ".";
  const markdownEnvironmentId = owner?.environmentId ?? environmentId;
  return (
    <ol className="flex flex-col gap-2 border-border border-t bg-muted/30 px-3 py-3 ps-10">
      {threads.map((thread) => {
        const [first, ...replies] = thread.comments;
        const verdict = verdicts.get(thread.id) ?? "auto";
        return (
          <li key={thread.id} className="rounded-md border border-border bg-background">
            <div className="flex items-center gap-2 border-border border-b px-2.5 py-1.5 text-xs">
              {first?.author?.isBot ? <BotIcon className="size-3.5 text-muted-foreground" /> : null}
              <span className="font-medium">{first?.author?.login ?? "unknown"}</span>
              <span className="truncate font-mono text-muted-foreground">
                {thread.line === null ? thread.path : `${thread.path}:${thread.line}`}
              </span>
              {thread.isOutdated ? <Badge variant="outline">Outdated</Badge> : null}
              {first?.url ? (
                <a
                  href={first.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open on GitHub"
                  className="ms-auto text-muted-foreground hover:text-foreground"
                >
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              ) : null}
            </div>
            <div className="max-h-64 overflow-y-auto px-2.5 py-2 text-sm">
              {first && markdownEnvironmentId !== null ? (
                <PullRequestMarkdown
                  text={first.body}
                  cwd={cwd}
                  environmentId={markdownEnvironmentId}
                />
              ) : (
                <p className="whitespace-pre-wrap">{first?.body}</p>
              )}
              {replies.length > 0 ? (
                <p className="mt-2 text-muted-foreground text-xs">
                  {replies.length} repl{replies.length === 1 ? "y" : "ies"} · last by{" "}
                  {replies.at(-1)?.author?.login ?? "unknown"}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2 border-border border-t px-2.5 py-1.5">
              <span className="text-muted-foreground text-xs">Your call</span>
              <ToggleGroup
                aria-label="What the agent should do with this comment"
                value={[verdict]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "fix" || value === "decline") onVerdict(thread.id, value);
                  else if (value === "auto") onVerdict(thread.id, null);
                }}
              >
                <ToggleGroupItem value="auto">Agent decides</ToggleGroupItem>
                <ToggleGroupItem value="fix">Fix it</ToggleGroupItem>
                <ToggleGroupItem value="decline">Push back</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
