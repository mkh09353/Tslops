import {
  ChevronLeftIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  LayersIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
} from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";

import type { SidebarCollection } from "../Sidebar.collections";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Rows mark themselves as drop targets; the sidebar hit-tests the pointer against them. */
const COLLECTION_DROP_ATTRIBUTE = "data-collection-drop";
export const NEW_COLLECTION_DROP_TARGET = "new";
export const LEAVE_COLLECTION_DROP_TARGET = "leave";

export function collectionDropTargetAt(point: { x: number; y: number }): string | null {
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(`[${COLLECTION_DROP_ATTRIBUTE}]`)
      ?.getAttribute(COLLECTION_DROP_ATTRIBUTE) ?? null
  );
}

const rowClassName =
  "group/collection-row flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const dropOverClassName = "bg-sidebar-row-hover ring-1 ring-inset ring-primary/70";

function CollectionAttention(props: { attention: SidebarCollection["attention"] }) {
  switch (props.attention) {
    case "approval":
      return (
        <ShieldQuestionIcon
          aria-label="Needs approval"
          className="size-3.5 shrink-0 text-warning-foreground"
        />
      );
    case "input":
      return (
        <MessageCircleQuestionIcon
          aria-label="Needs input"
          className="size-3.5 shrink-0 text-warning-foreground"
        />
      );
    case "failed":
      return (
        <CircleAlertIcon
          aria-label="A thread failed"
          className="size-3.5 shrink-0 text-destructive-foreground"
        />
      );
    case "working":
      return (
        <CircleDashedIcon aria-label="Working" className="size-3.5 shrink-0 text-secondary-label" />
      );
    case null:
      return null;
  }
}

function CollectionTitleInput(props: {
  initialTitle: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(props.initialTitle);
  return (
    <input
      autoFocus
      aria-label="Collection name"
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => props.onCommit(title)}
      onKeyDown={(event) => {
        if (event.key === "Enter") props.onCommit(title);
        if (event.key === "Escape") props.onCancel();
      }}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}

/**
 * Collections above the thread list, hidden until one exists. Nothing here
 * changes height during a drag, so lifted rows keep their measured positions.
 */
export function SidebarCollections(props: {
  collections: readonly SidebarCollection[];
  expanded: boolean;
  onToggle: () => void;
  dragging: boolean;
  dropTarget: string | null;
  renamingKey: string | null;
  onSelect: (collection: SidebarCollection) => void;
  onContextMenu: (collection: SidebarCollection, position: { x: number; y: number }) => void;
  onRename: (collection: SidebarCollection, title: string) => void;
  onCancelRename: () => void;
}) {
  if (props.collections.length === 0) return null;
  const overRow = props.collections.some((collection) => collection.key === props.dropTarget);
  return (
    <div className="mx-0.5 mb-1 flex flex-col gap-px" data-testid="sidebar-collections">
      <CollapsibleSectionHeader
        expanded={props.expanded}
        onClick={props.onToggle}
        tone={overRow ? "accent" : props.dragging ? "emphasized" : "muted"}
      >
        Collections
      </CollapsibleSectionHeader>
      {props.expanded
        ? props.collections.map((collection) => (
            <div
              key={collection.key}
              role="button"
              tabIndex={0}
              {...{ [COLLECTION_DROP_ATTRIBUTE]: collection.key }}
              aria-label={`${collection.title}, ${collection.threadCount} threads`}
              className={cn(
                rowClassName,
                "text-sidebar-foreground hover:bg-sidebar-row-hover",
                props.dropTarget === collection.key && dropOverClassName,
              )}
              onClick={() => {
                if (props.renamingKey !== collection.key) props.onSelect(collection);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  props.onSelect(collection);
                }
              }}
              onContextMenu={(event: ReactMouseEvent) => {
                event.preventDefault();
                props.onContextMenu(collection, { x: event.clientX, y: event.clientY });
              }}
            >
              <LayersIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
              {props.renamingKey === collection.key ? (
                <CollectionTitleInput
                  initialTitle={collection.title}
                  onCommit={(title) => props.onRename(collection, title)}
                  onCancel={props.onCancelRename}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{collection.title}</span>
              )}
              <CollectionAttention attention={collection.attention} />
              <span className="shrink-0 text-xs tabular-nums text-secondary-label">
                {collection.threadCount}
              </span>
            </div>
          ))
        : null}
    </div>
  );
}

/**
 * Takes the search row's place while a thread is lifted: same height, so the
 * list below never moves, and always reachable at the top of the sidebar.
 */
export function NewCollectionDropSlot(props: { isDropTarget: boolean }) {
  return (
    <div
      {...{ [COLLECTION_DROP_ATTRIBUTE]: NEW_COLLECTION_DROP_TARGET }}
      data-testid="sidebar-new-collection-drop"
      className={cn(
        "flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
        props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
      )}
    >
      <PlusIcon aria-hidden className="size-3.5" />
      New collection
    </div>
  );
}

/**
 * Heads the list while it is narrowed to one collection. Dropping a thread on
 * it takes the thread out of the collection.
 */
export function SidebarCollectionScopeHeader(props: {
  collection: SidebarCollection;
  dropTarget: string | null;
  dragging: boolean;
  onExit: () => void;
  onNewThread: () => void;
  onContextMenu: (collection: SidebarCollection, position: { x: number; y: number }) => void;
  renaming: boolean;
  onRename: (collection: SidebarCollection, title: string) => void;
  onCancelRename: () => void;
}) {
  const isDropTarget = props.dropTarget === LEAVE_COLLECTION_DROP_TARGET;
  return (
    <div
      {...{ [COLLECTION_DROP_ATTRIBUTE]: LEAVE_COLLECTION_DROP_TARGET }}
      data-testid="sidebar-collection-scope"
      className={cn(
        "mx-0.5 mb-1 flex h-8 min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1",
        isDropTarget && dropOverClassName,
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(props.collection, { x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        aria-label="Show all threads"
        onClick={props.onExit}
        className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--sidebar-icon-color) hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <LayersIcon aria-hidden className="size-4 shrink-0" />
      {props.renaming ? (
        <CollectionTitleInput
          initialTitle={props.collection.title}
          onCommit={(title) => props.onRename(props.collection, title)}
          onCancel={props.onCancelRename}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-sidebar-foreground">
          {props.collection.title}
        </span>
      )}
      {props.dragging ? (
        <span
          className={cn("shrink-0 text-xs", isDropTarget ? "text-primary" : "text-secondary-label")}
        >
          Drop to remove
        </span>
      ) : (
        <>
          <span className="shrink-0 text-xs tabular-nums text-secondary-label">
            {props.collection.threadCount}{" "}
            {props.collection.threadCount === 1 ? "thread" : "threads"}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`New thread in ${props.collection.title}`}
                  onClick={props.onNewThread}
                  className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--sidebar-icon-color) hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                />
              }
            >
              <SquarePenIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">New thread in {props.collection.title}</TooltipPopup>
          </Tooltip>
        </>
      )}
    </div>
  );
}
