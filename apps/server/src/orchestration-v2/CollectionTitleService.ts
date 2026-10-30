import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { CommandId, type ServerSettingsError, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Names a collection from the thread that started it. Members still carrying
 * the placeholder title take the generated one; a rename in the meantime wins.
 */
export class CollectionTitleService extends Context.Service<
  CollectionTitleService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly collectionId: string;
      readonly requestId: CommandId;
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/CollectionTitleService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const execute: CollectionTitleService["Service"]["execute"] = Effect.fn(
    "CollectionTitleService.execute",
  )(function* (input) {
    const projection = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageRoles: ["user", "assistant"],
    });
    const placeholder = projection.thread.collection;
    if (placeholder == null || placeholder.id !== input.collectionId) return;
    const project = yield* projects.get(projection.thread.projectId);
    if (Option.isNone(project)) return;

    const context = formatThreadTitleContext(
      projection.messages.filter((message) => !message.streaming),
    );
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      projection.thread.projectId,
    ).settings;
    const title = yield* textGeneration
      .generateThreadTitle({
        cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
        message: `Thread title: ${projection.thread.title}\n\n${context.message}`,
        attachments: context.attachments,
        subject: "collection",
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(
        Effect.map((result) => result.title.trim()),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Collection title generation failed", {
                threadId: input.threadId,
                collectionId: input.collectionId,
                cause,
              }).pipe(Effect.as("")),
        ),
      );
    if (title === "" || title === "New thread" || title === placeholder.title) return;

    const snapshot = yield* threads.getShellSnapshot();
    const members = snapshot.threads.filter(
      (thread) =>
        thread.collection?.id === placeholder.id && thread.collection.title === placeholder.title,
    );
    yield* Effect.forEach(
      members,
      (thread) =>
        threads.dispatch({
          type: "thread.collection.set",
          commandId: CommandId.make(`${input.requestId}:collection-title:${thread.id}`),
          threadId: thread.id,
          collection: { id: placeholder.id, title },
        }),
      { discard: true },
    );
  });

  return CollectionTitleService.of({ execute });
});

export const layer = Layer.effect(CollectionTitleService, make);
