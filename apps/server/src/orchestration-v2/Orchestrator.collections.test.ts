import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for collections"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "collections" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId, collection?: { id: string; title: string }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:collections"),
      title: "Form renderer field types",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(collection === undefined ? {} : { collection }),
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("threads join, rename, and leave a collection through their shells", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const first = ThreadId.make("thread:collection-first");
    const second = ThreadId.make("thread:collection-second");
    yield* createThread(first);

    yield* orchestrator.dispatch({
      type: "thread.collection.set",
      commandId: CommandId.make("start-collection"),
      threadId: first,
      collection: { id: "collection:forms", title: "Form renderer field types" },
      generateTitle: true,
    });
    assert.deepStrictEqual((yield* projections.getThreadShell(first))?.collection, {
      id: "collection:forms",
      title: "Form renderer field types",
    });
    const titleEffects = yield* sql<{ readonly effectType: string }>`
      SELECT effect_type AS "effectType" FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${first} AND effect_type = 'collection-title.generate'`;
    assert.equal(titleEffects.length, 1);

    // A thread launched into the collection carries it from creation.
    yield* createThread(second, { id: "collection:forms", title: "Intake Forms" });
    assert.equal((yield* projections.getThreadShell(second))?.collection?.title, "Intake Forms");

    // A rename without generateTitle queues no title work.
    yield* orchestrator.dispatch({
      type: "thread.collection.set",
      commandId: CommandId.make("rename-collection"),
      threadId: first,
      collection: { id: "collection:forms", title: "Intake Forms" },
    });
    const allTitleEffects = yield* sql<{ readonly effectType: string }>`
      SELECT effect_type AS "effectType" FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'collection-title.generate'`;
    assert.equal(allTitleEffects.length, 1);

    yield* orchestrator.dispatch({
      type: "thread.collection.set",
      commandId: CommandId.make("leave-collection"),
      threadId: second,
      collection: null,
    });
    assert.equal((yield* projections.getThreadShell(second))?.collection, null);
    assert.equal(
      (yield* projections.getThreadProjection(first)).thread.collection?.title,
      "Intake Forms",
    );
  }).pipe(Effect.provide(layerTest)),
);
