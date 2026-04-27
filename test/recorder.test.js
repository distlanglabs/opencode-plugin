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
