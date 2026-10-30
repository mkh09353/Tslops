import { describe, expect, it } from "vite-plus/test";

import { buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("names the broader effort for a collection instead of the thread's task", () => {
    const { prompt } = buildThreadTitlePrompt({
      message: "Thread title: Form renderer field types\n\nRender all nine field types.",
      subject: "collection",
    });
    expect(prompt).toContain("Name a new collection in T3 Code.");
    expect(prompt).toContain("Render all nine field types.");
    expect(prompt).not.toContain("recognize this T3 Code thread");
  });
});
