import assert from "node:assert/strict";
import test from "node:test";
import { createRecorder, extractSessionTitle } from "../src/recorder.js";

test("captures OpenCode title, token usage, context, and sanitized text", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({
    type: "session.created",
    sessionID: "session-1",
    info: { id: "session-1", title: "Implement billing fix", time: "2026-04-25T00:00:00.000Z" },
  });
  recorder.observeUserMessage({
    type: "message.updated",
    info: {
      id: "user-1",
      sessionID: "session-1",
      role: "user",
      time: "2026-04-25T00:00:01.000Z",
      content: "Fix billing totals <system-reminder>SECRET</system-reminder>",
    },
  });
  recorder.observeAssistantMessage({
    type: "message.updated",
    info: {
      id: "assistant-1",
      sessionID: "session-1",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.5",
      time: "2026-04-25T00:00:02.000Z",
      status: "completed",
      content: "Updated totals",
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        reasoningTokens: 50,
        cachedInputTokens: 200,
      },
      cost: 0.01,
    },
  });

  const payload = recorder.finalizeSession("session-1", "success", Date.parse("2026-04-25T00:00:03.000Z"));
  assert.equal(payload.session.summary, "Implement billing fix");
  assert.equal(payload.session.input_tokens, 1200);
  assert.equal(payload.session.output_tokens, 300);
  assert.equal(payload.session.reasoning_tokens, 50);
  assert.equal(payload.session.cached_tokens, 200);
  assert.equal(payload.session.context_size_tokens_p95, 1450);
  assert.equal(payload.interactions[0].context_size_tokens_p95, 1450);
  assert.equal(payload.interactions[0].prompt, "Fix billing totals");
  const llmStep = payload.interactions[0].steps.find((step) => step.kind === "llm_call");
  assert.ok(llmStep);
  assert.equal(llmStep.context_size_tokens, 1450);
  assert.equal(llmStep.model, "gpt-5.5");
});

test("uses explicit context token field when OpenCode provides it", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({ type: "session.created", sessionID: "session-2", info: { id: "session-2" } });
  recorder.setSessionTitle("session-2", "OpenCode generated title");
  recorder.observeUserMessage({ type: "message.updated", info: { id: "user-2", sessionID: "session-2", role: "user", content: "hello" } });
  recorder.observeAssistantMessage({
    type: "message.updated",
    info: {
      id: "assistant-2",
      sessionID: "session-2",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.5",
      done: true,
      text: "hi",
      tokens: { input: 10, output: 5, contextSizeTokens: 999 },
    },
  });

  const payload = recorder.finalizeSession("session-2", "success", Date.now());
  assert.equal(payload.session.summary, "OpenCode generated title");
  assert.equal(payload.session.context_size_tokens_max, 999);
});

test("uses the session title when an interaction prompt is only the generic fallback", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({
    type: "session.created",
    sessionID: "session-3",
    info: { id: "session-3", title: "Explain interaction naming" },
  });
  recorder.observeAssistantMessage({
    type: "message.updated",
    info: {
      id: "assistant-3",
      sessionID: "session-3",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.5",
      content: "Explained the timeline label",
    },
  });

  const payload = recorder.finalizeSession("session-3", "success", Date.now());
  assert.equal(payload.interactions[0].prompt, "Explain interaction naming");
  assert.equal(payload.interactions[0].summary, "Explain interaction naming");
});

test("extracts nested OpenCode session titles", () => {
  assert.equal(extractSessionTitle({ data: { session: { title: "High-level overview of distlang and dash" } } }), "High-level overview of distlang and dash");
  assert.equal(extractSessionTitle({ properties: { metadata: { name: "Review dashboard telemetry" } } }), "Review dashboard telemetry");
  assert.equal(extractSessionTitle({ title: "OpenCode interaction 1", data: { summary: "Useful session title" } }), "Useful session title");
});

test("uses nested event title as session summary", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({
    type: "session.created",
    sessionID: "session-4",
    info: { id: "session-4" },
    properties: { session: { title: "High-level overview of distlang and dash" } },
  });
  recorder.observeAssistantMessage({
    type: "message.updated",
    info: {
      id: "assistant-4",
      sessionID: "session-4",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.5",
      content: "Overview complete",
    },
  });

  const payload = recorder.finalizeSession("session-4", "success", Date.now());
  assert.equal(payload.session.summary, "High-level overview of distlang and dash");
  assert.equal(payload.interactions[0].prompt, "High-level overview of distlang and dash");
});

test("does not use generic interaction label as session summary", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({ type: "session.created", sessionID: "session-5", info: { id: "session-5" } });
  recorder.observeAssistantMessage({
    type: "message.updated",
    info: {
      id: "assistant-5",
      sessionID: "session-5",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.5",
      content: "Summarized state",
    },
  });

  const payload = recorder.finalizeSession("session-5", "success", Date.now());
  assert.equal(payload.session.summary, "OpenCode session session-5");
});

test("uses sanitized opencode run prompt for assistant-only interactions", () => {
  const recorder = createRecorder({
    project: { name: "fixture" },
    directory: "/tmp/fixture",
    initialPrompt: "Create a high-level overview <system-reminder>SECRET</system-reminder>",
  });
  recorder.observeSessionCreated({
    type: "session.created",
    sessionID: "session-6",
    info: { id: "session-6", title: "Generated OpenCode title" },
  });
  recorder.observeAssistantMessage({
    type: "message.updated",
    info: {
      id: "assistant-6",
      sessionID: "session-6",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.5",
      content: "Done",
    },
  });

  const payload = recorder.finalizeSession("session-6", "success", Date.now());
  assert.equal(payload.session.summary, "Generated OpenCode title");
  assert.equal(payload.interactions[0].prompt, "Create a high-level overview");
  assert.equal(payload.interactions[0].summary, "Create a high-level overview");
});

test("captures user prompt from OpenCode text part updates", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({ type: "session.created", sessionID: "session-7", info: { id: "session-7", title: "Generated overview title" } });
  recorder.observeUserMessage({
    type: "message.updated",
    properties: {
      info: {
        id: "user-7",
        sessionID: "session-7",
        role: "user",
        time: { created: Date.parse("2026-04-25T00:00:01.000Z") },
      },
    },
  });
  recorder.observeMessagePartUpdated({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-user-7",
        sessionID: "session-7",
        messageID: "user-7",
        type: "text",
        text: "Explain this repo <system-reminder>SECRET</system-reminder>",
        time: { start: Date.parse("2026-04-25T00:00:01.500Z") },
      },
    },
  });
  recorder.observeMessagePartUpdated({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-assistant-7",
        sessionID: "session-7",
        messageID: "assistant-7",
        type: "text",
        text: "This repository contains a dashboard and services.",
      },
    },
  });
  recorder.observeAssistantMessage({
    type: "message.updated",
    properties: {
      info: {
        id: "assistant-7",
        sessionID: "session-7",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.5",
        status: "completed",
        tokens: { input: 100, output: 20 },
      },
    },
  });

  const payload = recorder.finalizeSession("session-7", "success", Date.now());
  assert.equal(payload.session.summary, "Generated overview title");
  assert.equal(payload.interactions.length, 1);
  assert.equal(payload.interactions[0].prompt, "Explain this repo");
  assert.equal(payload.interactions[0].summary, "Explain this repo");
  assert.equal(payload.interactions[0].steps[0].title, "This repository contains a dashboard and services.");
});

test("updates user text part without duplicating interactions", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({ type: "session.created", sessionID: "session-8", info: { id: "session-8" } });
  recorder.observeUserMessage({ type: "message.updated", properties: { info: { id: "user-8", sessionID: "session-8", role: "user" } } });
  recorder.observeMessagePartUpdated({
    type: "message.part.updated",
    properties: { part: { id: "part-user-8", sessionID: "session-8", messageID: "user-8", type: "text", text: "First draft" } },
  });
  recorder.observeMessagePartUpdated({
    type: "message.part.updated",
    properties: { part: { id: "part-user-8", sessionID: "session-8", messageID: "user-8", type: "text", text: "Final prompt" } },
  });
  recorder.observeAssistantMessage({ type: "message.updated", properties: { info: { id: "assistant-8", sessionID: "session-8", role: "assistant", done: true, text: "Done" } } });

  const payload = recorder.finalizeSession("session-8", "success", Date.now());
  assert.equal(payload.interactions.length, 1);
  assert.equal(payload.interactions[0].prompt, "Final prompt");
});

test("uses OpenCode message lineage for stable multi-interaction sessions", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({ type: "session.created", sessionID: "session-9", info: { id: "session-9" } });

  recorder.observeUserMessage({ type: "message.updated", properties: { info: { id: "user-9a", sessionID: "session-9", role: "user", content: "First request" } } });
  recorder.observeAssistantMessage({
    type: "message.updated",
    properties: { info: { id: "assistant-9a", parentID: "user-9a", sessionID: "session-9", role: "assistant", status: "completed", text: "First answer", tokens: { input: 10, output: 5 } } },
  });

  recorder.observeUserMessage({ type: "message.updated", properties: { info: { id: "user-9b", sessionID: "session-9", role: "user", content: "Second request" } } });
  recorder.observeToolBefore({ sessionID: "session-9", messageID: "assistant-9b", callID: "tool-9b", tool: "bash" });
  recorder.observeAssistantMessage({
    type: "message.updated",
    properties: { info: { id: "assistant-9b", parentID: "user-9b", sessionID: "session-9", role: "assistant", status: "completed", text: "Second answer", tokens: { input: 20, output: 8 } } },
  });
  recorder.observeToolAfter({ sessionID: "session-9", messageID: "assistant-9b", callID: "tool-9b", tool: "bash" }, {});

  const payload = recorder.finalizeSession("session-9", "success", Date.now());
  assert.equal(payload.interactions.length, 2);
  assert.equal(payload.interactions[0].id, "session-9:int:user-9a");
  assert.equal(payload.interactions[1].id, "session-9:int:user-9b");
  assert.equal(payload.interactions[0].prompt, "First request");
  assert.equal(payload.interactions[1].prompt, "Second request");
  assert.equal(payload.interactions[0].steps.length, 1);
  assert.equal(payload.interactions[0].steps[0].title, "First answer");
  assert.equal(payload.interactions[1].steps.length, 2);
  assert.deepEqual(payload.interactions[1].steps.map((step) => step.kind).sort(), ["llm_call", "tool_call"]);
});

test("snapshot preserves at least ten prompt interactions", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({ type: "session.created", sessionID: "session-10", info: { id: "session-10" } });

  for (let index = 1; index <= 12; index += 1) {
    recorder.observeUserMessage({ type: "message.updated", properties: { info: { id: `user-10-${index}`, sessionID: "session-10", role: "user", content: `Prompt ${index}` } } });
    recorder.observeAssistantMessage({
      type: "message.updated",
      properties: { info: { id: `assistant-10-${index}`, parentID: `user-10-${index}`, sessionID: "session-10", role: "assistant", done: true, text: `Answer ${index}`, tokens: { input: 10 + index, output: index } } },
    });
  }

  const payload = recorder.snapshotSession("session-10", "success", Date.now());
  assert.equal(payload.interactions.length, 12);
  assert.equal(payload.interactions[0].prompt, "Prompt 1");
  assert.equal(payload.interactions[9].prompt, "Prompt 10");
  assert.equal(payload.interactions[11].prompt, "Prompt 12");
  assert.equal(payload.interactions.every((interaction) => interaction.steps.length === 1), true);
});

test("idle snapshots do not clear later interactions", () => {
  const recorder = createRecorder({ project: { name: "fixture" }, directory: "/tmp/fixture" });
  recorder.observeSessionCreated({ type: "session.created", sessionID: "session-11", info: { id: "session-11" } });

  recorder.observeUserMessage({ type: "message.updated", properties: { info: { id: "user-11a", sessionID: "session-11", role: "user", content: "Plan the fix" } } });
  recorder.observeAssistantMessage({
    type: "message.updated",
    properties: { info: { id: "assistant-11a", parentID: "user-11a", sessionID: "session-11", role: "assistant", done: true, text: "Plan done", tokens: { input: 15, output: 4 } } },
  });
  const firstSnapshot = recorder.snapshotSession("session-11", "success", Date.parse("2026-04-25T00:00:02.000Z"));
  assert.equal(firstSnapshot.interactions.length, 1);

  recorder.observeUserMessage({ type: "message.updated", properties: { info: { id: "user-11b", sessionID: "session-11", role: "user", content: "Build the fix" } } });
  recorder.observeAssistantMessage({
    type: "message.updated",
    properties: { info: { id: "assistant-11b", parentID: "user-11b", sessionID: "session-11", role: "assistant", done: true, text: "Build done", tokens: { input: 25, output: 6 } } },
  });
  const secondSnapshot = recorder.snapshotSession("session-11", "success", Date.parse("2026-04-25T00:00:04.000Z"));
  assert.equal(secondSnapshot.interactions.length, 2);
  assert.deepEqual(secondSnapshot.interactions.map((interaction) => interaction.prompt), ["Plan the fix", "Build the fix"]);
});
