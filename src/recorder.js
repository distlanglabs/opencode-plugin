import { basename, extname } from "node:path";

const extensionLanguages = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".md": "markdown",
  ".mjs": "javascript",
  ".php": "php",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "shell",
  ".sql": "sql",
  ".svg": "svg",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".txt": "text",
  ".yaml": "yaml",
  ".yml": "yaml",
};

export function createRecorder({ project, directory, initialPrompt = "" }) {
  const projectName = deriveProjectName(project, directory);
  const configuredInitialPrompt = sanitizeDebuggerText(initialPrompt);
  const sessions = new Map();

  function activeSessionID() {
    if (sessions.size === 1) {
      return Array.from(sessions.keys())[0] || "";
    }
    return "";
  }

  function ensureSession(sessionID, startedAtMs = Date.now()) {
    if (sessions.has(sessionID)) {
      return sessions.get(sessionID);
    }
    const recorder = {
      id: sessionID,
      source: "opencode",
      project: projectName,
      startedAtMs,
      endedAtMs: 0,
      status: "success",
      summary: "",
      title: "",
      initialPrompt: configuredInitialPrompt,
      interactions: [],
      currentInteractionID: "",
      interactionCounter: 0,
      stepCounter: 0,
      assistantStates: new Map(),
      messageRoles: new Map(),
      messageTextParts: new Map(),
      messageInteractions: new Map(),
      toolStarts: new Map(),
      seenUserMessages: new Set(),
    };
    sessions.set(sessionID, recorder);
    return recorder;
  }

  function createInteraction(recorder, prompt, timestampMs) {
    recorder.interactionCounter += 1;
    const interaction = {
      id: `${recorder.id}:int:${recorder.interactionCounter}`,
      index: recorder.interactionCounter,
      prompt: configuredValue(prompt, `OpenCode interaction ${recorder.interactionCounter}`),
      mode: "build",
      startedAtMs: timestampMs,
      endedAtMs: 0,
      status: "success",
      summary: "",
      steps: [],
    };
    recorder.interactions.push(interaction);
    recorder.currentInteractionID = interaction.id;
    return interaction;
  }

  function findInteraction(recorder, interactionID) {
    return recorder.interactions.find((interaction) => interaction.id === interactionID) || null;
  }

  function ensureInteraction(recorder, timestampMs, prompt = "") {
    const current = findInteraction(recorder, recorder.currentInteractionID);
    if (current) {
      if (prompt && (!current.prompt || isGenericInteractionLabel(current.prompt))) {
        current.prompt = prompt;
      }
      return current;
    }
    return createInteraction(recorder, configuredValue(prompt, recorder.initialPrompt), timestampMs);
  }

  function observeUserPrompt(recorder, messageID, prompt, timestampMs) {
    const cleanPrompt = sanitizeDebuggerText(prompt);
    const existingID = recorder.messageInteractions.get(messageID);
    const existing = existingID ? findInteraction(recorder, existingID) : null;
    if (existing) {
      existing.prompt = cleanPrompt;
      existing.summary = summarizePrompt(cleanPrompt, existing.summary || `Interaction ${existing.index}`);
      return existing;
    }
    const current = findInteraction(recorder, recorder.currentInteractionID);
    const currentHasMessage = Array.from(recorder.messageInteractions.values()).includes(current?.id);
    if (current && isGenericInteractionLabel(current.prompt) && !currentHasMessage) {
      current.prompt = cleanPrompt;
      current.summary = summarizePrompt(cleanPrompt, `Interaction ${current.index}`);
      recorder.messageInteractions.set(messageID, current.id);
      recorder.seenUserMessages.add(messageID);
      return current;
    }
    if (recorder.seenUserMessages.has(messageID)) {
      return current || createInteraction(recorder, cleanPrompt, timestampMs);
    }
    recorder.seenUserMessages.add(messageID);
    const interaction = createInteraction(recorder, cleanPrompt, timestampMs);
    recorder.messageInteractions.set(messageID, interaction.id);
    return interaction;
  }

  function addStep(recorder, interaction, step) {
    recorder.stepCounter += 1;
    const normalized = {
      id: `${recorder.id}:step:${recorder.stepCounter}`,
      index: recorder.stepCounter,
      kind: step.kind,
      phase: configuredValue(step.phase, "build"),
      title: configuredValue(step.title, step.kind),
      started_at: normalizeDateTime(step.started_at, new Date().toISOString()),
      ended_at: step.ended_at ? normalizeDateTime(step.ended_at, new Date().toISOString()) : null,
      duration_ms: Math.max(0, Math.floor(finiteNumber(step.duration_ms))),
      status: configuredValue(step.status, "success"),
      provider: configuredValue(step.provider, "") || null,
      model: configuredValue(step.model, "") || null,
      tool_name: configuredValue(step.tool_name, "") || null,
      input_tokens: Math.max(0, Math.floor(finiteNumber(step.input_tokens))),
      output_tokens: Math.max(0, Math.floor(finiteNumber(step.output_tokens))),
      reasoning_tokens: Math.max(0, Math.floor(finiteNumber(step.reasoning_tokens))),
      cached_tokens: Math.max(0, Math.floor(finiteNumber(step.cached_tokens))),
      context_size_tokens: Math.max(0, Math.floor(finiteNumber(step.context_size_tokens))),
      cost_usd: finiteNumber(step.cost_usd),
      first_token_at: step.first_token_at ? normalizeDateTime(step.first_token_at, new Date().toISOString()) : null,
      first_token_latency_ms: Math.max(0, Math.floor(finiteNumber(step.first_token_latency_ms))),
      payload_json: step.payload_json ?? null,
    };
    interaction.steps.push(normalized);
    interaction.endedAtMs = Math.max(interaction.endedAtMs || 0, Date.parse(normalized.ended_at || normalized.started_at));
    recorder.summary = configuredValue(recorder.summary, summarizePrompt(interaction.prompt, interaction.summary || `OpenCode session ${recorder.id}`));
    return normalized;
  }

  function observeSessionCreated(event) {
    const sessionInfo = event.info && typeof event.info === "object" ? event.info : {};
    const sessionID = configuredValue(event.sessionID, configuredValue(sessionInfo.id, ""));
    if (!sessionID) {
      return null;
    }
    const recorder = ensureSession(sessionID, parseTimestamp(sessionInfo.time, Date.now()));
    updateSessionTitle(recorder, event);
    return { sessionID };
  }

  function observeSessionUpdated(event) {
    const sessionInfo = event.info && typeof event.info === "object" ? event.info : event.properties && typeof event.properties === "object" ? event.properties : {};
    const sessionID = configuredValue(event.sessionID, configuredValue(sessionInfo.id, ""));
    if (!sessionID) {
      return null;
    }
    const recorder = ensureSession(sessionID, parseTimestamp(sessionInfo.time, Date.now()));
    const title = updateSessionTitle(recorder, event);
    return { sessionID, title };
  }

  function setSessionTitle(sessionID, title) {
    if (!sessionID) {
      return null;
    }
    const recorder = ensureSession(sessionID, Date.now());
    return updateSessionTitle(recorder, { title });
  }

  function observeFileEdited(event) {
    const filePath = configuredValue(event.file, configuredValue(event.properties && event.properties.file, ""));
    const sessionID = configuredValue(event.sessionID, activeSessionID());
    if (!filePath || !sessionID) {
      return null;
    }
    const recorder = ensureSession(sessionID, Date.now());
    const interaction = ensureInteraction(recorder, Date.now());
    addStep(recorder, interaction, {
      kind: "file_edit",
      phase: "build",
      title: `Edit ${filePath}`,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      status: "success",
      payload_json: { file_path: filePath, language: inferLanguage(filePath) },
    });
    return { sessionID, filePath, language: inferLanguage(filePath) };
  }

  function observeUserMessage(event) {
    const info = extractMessageInfo(event);
    const sessionID = messageSessionID(info, event) || activeSessionID();
    if (!sessionID || !isUserMessage(info)) {
      return null;
    }
    const recorder = ensureSession(sessionID, Date.now());
    const id = messageID(info) || `${sessionID}:user:${Date.now()}`;
    recorder.messageRoles.set(id, "user");
    const prompt = extractMessageText(info) || storedMessageText(recorder, id);
    if (!prompt) {
      return { sessionID, messageID: id, prompt: "" };
    }
    const interaction = observeUserPrompt(recorder, id, prompt, parseMessageTime(info, Date.now()));
    return { sessionID, messageID: id, prompt: interaction.prompt };
  }

  function observeMessagePartUpdated(event) {
    const part = extractMessagePart(event);
    if (!part || part.type !== "text") {
      return null;
    }
    const sessionID = configuredValue(part.sessionID, activeSessionID());
    const messageID = configuredValue(part.messageID, "");
    const partID = configuredValue(part.id, "");
    const text = sanitizeDebuggerText(configuredValue(part.text, configuredValue(event?.properties?.delta, "")));
    if (!sessionID || !messageID || !partID || !text) {
      return null;
    }
    const recorder = ensureSession(sessionID, Date.now());
    storeMessageTextPart(recorder, messageID, partID, text);
    const role = recorder.messageRoles.get(messageID);
    if (role !== "user") {
      return { sessionID, messageID, role: configuredValue(role, "unknown"), text };
    }
    const interaction = observeUserPrompt(recorder, messageID, storedMessageText(recorder, messageID), parsePartTime(part, Date.now()));
    return { sessionID, messageID, role, text: interaction.prompt };
  }

  function observeAssistantMessage(event) {
    const info = extractMessageInfo(event);
    const sessionID = messageSessionID(info, event) || activeSessionID();
    if (!sessionID || !isAssistantMessage(info)) {
      return null;
    }
    const id = messageID(info);
    if (!id) {
      return null;
    }
    const recorder = ensureSession(sessionID, Date.now());
    recorder.messageRoles.set(id, "assistant");
    const interaction = ensureInteraction(recorder, Date.now());
    const now = Date.now();
    const existing = recorder.assistantStates.get(id) || {
      firstSeenAt: parseTimestamp(info && info.time, now),
      firstTokenAt: null,
      interactionID: interaction.id,
      provider: assistantProvider(info),
      model: assistantModel(info),
      finalized: false,
    };
    const tokens = tokensFromMessage(info);
    if (existing.firstTokenAt == null && tokens.output > 0) {
      existing.firstTokenAt = now;
    }
    existing.provider = assistantProvider(info);
    existing.model = assistantModel(info);
    const finalState = assistantFinalState(info);
    if (finalState.isFinal && !existing.finalized) {
      existing.finalized = true;
      const targetInteraction = findInteraction(recorder, existing.interactionID) || interaction;
      const assistantText = extractMessageText(info) || storedMessageText(recorder, id);
      addStep(recorder, targetInteraction, {
        kind: "llm_call",
        phase: targetInteraction.mode,
        title: summarizePrompt(assistantText, `Assistant response ${targetInteraction.index}`),
        started_at: new Date(existing.firstSeenAt).toISOString(),
        ended_at: new Date(now).toISOString(),
        duration_ms: Math.max(0, now - existing.firstSeenAt),
        status: finalState.result,
        provider: existing.provider,
        model: existing.model,
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        reasoning_tokens: tokens.reasoning,
        cached_tokens: tokens.cached,
        context_size_tokens: tokens.context,
        cost_usd: finiteNumber(info && info.cost),
        first_token_at: existing.firstTokenAt != null ? new Date(existing.firstTokenAt).toISOString() : null,
        first_token_latency_ms: existing.firstTokenAt != null ? Math.max(0, existing.firstTokenAt - existing.firstSeenAt) : 0,
        payload_json: { message_id: id },
      });
    }
    recorder.assistantStates.set(id, existing);
    return {
      sessionID,
      messageID: id,
      provider: existing.provider,
      model: existing.model,
      tokens,
      cost: finiteNumber(info && info.cost),
      finalized: existing.finalized,
    };
  }

  function observeToolBefore(input) {
    const sessionID = configuredValue(input && input.sessionID, activeSessionID());
    const callID = configuredValue(input && input.callID, "");
    if (!sessionID || !callID) {
      return null;
    }
    const recorder = ensureSession(sessionID, Date.now());
    recorder.toolStarts.set(callID, {
      startedAt: Date.now(),
      tool: configuredValue(input && input.tool, "unknown"),
    });
    return { sessionID, callID, tool: configuredValue(input && input.tool, "unknown") };
  }

  function observeToolAfter(input, output) {
    const sessionID = configuredValue(input && input.sessionID, activeSessionID());
    const callID = configuredValue(input && input.callID, "");
    if (!sessionID) {
      return null;
    }
    const recorder = ensureSession(sessionID, Date.now());
    const toolState = callID && recorder.toolStarts.has(callID)
      ? recorder.toolStarts.get(callID)
      : { startedAt: Date.now(), tool: configuredValue(input && input.tool, "unknown") };
    const interaction = ensureInteraction(recorder, Date.now());
    addStep(recorder, interaction, {
      kind: "tool_call",
      phase: interaction.mode,
      title: `Run ${configuredValue(toolState.tool, "unknown")}`,
      started_at: new Date(toolState.startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: Math.max(0, Date.now() - toolState.startedAt),
      status: output && output.error ? "error" : "success",
      tool_name: configuredValue(toolState.tool, "unknown"),
      payload_json: output && output.metadata && typeof output.metadata === "object" ? output.metadata : null,
    });
    if (callID) {
      recorder.toolStarts.delete(callID);
    }
    return { sessionID, callID, tool: configuredValue(toolState.tool, "unknown"), result: output && output.error ? "error" : "success" };
  }

  function finalizeSession(sessionID, result, endedAtMs) {
    const recorder = sessions.get(sessionID);
    if (!recorder) {
      return null;
    }
    recorder.status = result;
    recorder.endedAtMs = endedAtMs;
    for (const interaction of recorder.interactions) {
      if (!interaction.endedAtMs || interaction.endedAtMs < interaction.startedAtMs) {
        interaction.endedAtMs = endedAtMs;
      }
      interaction.status = inferResultStatus(interaction.steps.map((step) => step.status), result);
      interaction.summary = configuredValue(interaction.summary, summarizePrompt(interaction.prompt, `Interaction ${interaction.index}`));
    }
    const payload = buildSessionPayload(recorder);
    sessions.delete(sessionID);
    return payload;
  }

  function snapshotSession(sessionID, result = "success", endedAtMs = Date.now()) {
    const recorder = sessions.get(sessionID);
    if (!recorder) {
      return null;
    }
    recorder.status = result;
    recorder.endedAtMs = endedAtMs;
    for (const interaction of recorder.interactions) {
      if (!interaction.endedAtMs || interaction.endedAtMs < interaction.startedAtMs) {
        interaction.endedAtMs = endedAtMs;
      }
      interaction.status = inferResultStatus(interaction.steps.map((step) => step.status), result);
      interaction.summary = configuredValue(interaction.summary, summarizePrompt(interaction.prompt, `Interaction ${interaction.index}`));
    }
    return buildSessionPayload(recorder);
  }

  return {
    activeSessionID,
    observeSessionCreated,
    observeSessionUpdated,
    setSessionTitle,
    observeFileEdited,
    observeUserMessage,
    observeMessagePartUpdated,
    observeAssistantMessage,
    observeToolBefore,
    observeToolAfter,
    finalizeSession,
    snapshotSession,
  };
}

function storeMessageTextPart(recorder, messageID, partID, text) {
  const parts = recorder.messageTextParts.get(messageID) || new Map();
  parts.set(partID, sanitizeDebuggerText(text));
  recorder.messageTextParts.set(messageID, parts);
}

function storedMessageText(recorder, messageID) {
  const parts = recorder.messageTextParts.get(messageID);
  if (!parts) {
    return "";
  }
  return sanitizeDebuggerText(Array.from(parts.values()).filter(Boolean).join("\n"));
}

function buildSessionPayload(recorder) {
  const sessionTitle = sanitizeDebuggerText(recorder.title);
  const interactions = recorder.interactions.map((interaction) => buildInteractionPayload(interaction, sessionTitle));
  const allSteps = interactions.flatMap((interaction) => interaction.steps);
  const llmSteps = allSteps.filter((step) => step.kind === "llm_call");
  const contextValues = llmSteps.map((step) => step.context_size_tokens).filter((value) => value > 0);
  const modelsUsed = Array.from(new Set(llmSteps.map((step) => step.model).filter(Boolean)));
  return {
    source: recorder.source,
    project: recorder.project,
    session: {
      id: recorder.id,
      started_at: new Date(recorder.startedAtMs).toISOString(),
      ended_at: new Date(recorder.endedAtMs || Date.now()).toISOString(),
      duration_ms: Math.max(0, (recorder.endedAtMs || Date.now()) - recorder.startedAtMs),
      status: inferResultStatus(interactions.map((interaction) => interaction.status), recorder.status),
      summary: bestSessionSummary(recorder, interactions),
      total_cost_usd: allSteps.reduce((total, step) => total + finiteNumber(step.cost_usd), 0),
      input_tokens: allSteps.reduce((total, step) => total + finiteNumber(step.input_tokens), 0),
      output_tokens: allSteps.reduce((total, step) => total + finiteNumber(step.output_tokens), 0),
      reasoning_tokens: allSteps.reduce((total, step) => total + finiteNumber(step.reasoning_tokens), 0),
      cached_tokens: allSteps.reduce((total, step) => total + finiteNumber(step.cached_tokens), 0),
      llm_call_count: llmSteps.length,
      context_size_tokens_p50: percentile(contextValues, 50),
      context_size_tokens_p95: percentile(contextValues, 95),
      context_size_tokens_max: contextValues.length > 0 ? Math.max(...contextValues) : 0,
      models_used: modelsUsed,
      files_changed_count: allSteps.filter((step) => step.kind === "file_edit").length,
      retry_count: allSteps.filter((step) => step.kind === "retry").length,
    },
    interactions,
  };
}

function buildInteractionPayload(interaction, sessionTitle = "") {
  const llmSteps = interaction.steps.filter((step) => step.kind === "llm_call");
  const contextValues = llmSteps.map((step) => step.context_size_tokens).filter((value) => value > 0);
  const promptFallback = configuredValue(sessionTitle, `Interaction ${interaction.index}`);
  const rawPrompt = sanitizeDebuggerText(interaction.prompt);
  const rawSummary = sanitizeDebuggerText(interaction.summary);
  const prompt = isGenericInteractionLabel(rawPrompt) ? promptFallback : configuredValue(rawPrompt, promptFallback);
  const summaryFallback = summarizePrompt(prompt, promptFallback);
  return {
    id: interaction.id,
    index: interaction.index,
    prompt,
    mode: interaction.mode,
    started_at: new Date(interaction.startedAtMs || Date.now()).toISOString(),
    ended_at: interaction.endedAtMs > 0 ? new Date(interaction.endedAtMs).toISOString() : new Date(Date.now()).toISOString(),
    duration_ms: Math.max(0, (interaction.endedAtMs || Date.now()) - interaction.startedAtMs),
    status: inferResultStatus(interaction.steps.map((step) => step.status), interaction.status),
    summary: isGenericInteractionLabel(rawSummary) ? summaryFallback : configuredValue(rawSummary, summaryFallback),
    llm_call_count: llmSteps.length,
    cost_usd: interaction.steps.reduce((total, step) => total + finiteNumber(step.cost_usd), 0),
    input_tokens: interaction.steps.reduce((total, step) => total + finiteNumber(step.input_tokens), 0),
    output_tokens: interaction.steps.reduce((total, step) => total + finiteNumber(step.output_tokens), 0),
    reasoning_tokens: interaction.steps.reduce((total, step) => total + finiteNumber(step.reasoning_tokens), 0),
    cached_tokens: interaction.steps.reduce((total, step) => total + finiteNumber(step.cached_tokens), 0),
    context_size_tokens_p50: percentile(contextValues, 50),
    context_size_tokens_p95: percentile(contextValues, 95),
    context_size_tokens_max: contextValues.length > 0 ? Math.max(...contextValues) : 0,
    step_count: interaction.steps.length,
    steps: interaction.steps,
  };
}

function isGenericInteractionLabel(value) {
  const label = String(value || "").trim();
  return /^OpenCode interaction \d+$/i.test(label) || /^Interaction \d+$/i.test(label);
}

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function deriveProjectName(project, directory) {
  const explicit = configuredValue(project && project.name, "");
  if (explicit !== "") {
    return explicit;
  }
  return configuredValue(basename(directory || ""), "unknown");
}

function inferLanguage(filePath) {
  const extension = extname(String(filePath || "")).toLowerCase();
  return extensionLanguages[extension] || "unknown";
}

function finiteNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function parseTimestamp(value, fallback) {
  if (typeof value === "string" && value.trim() !== "") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function normalizeDateTime(value, fallback = new Date().toISOString()) {
  const timestamp = parseTimestamp(value, Number.NaN);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return fallback;
}

function extractMessageInfo(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  if (event.info && typeof event.info === "object") {
    return event.info;
  }
  if (event.properties && event.properties.info && typeof event.properties.info === "object") {
    return event.properties.info;
  }
  return null;
}

function extractMessagePart(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  if (event.part && typeof event.part === "object") {
    return event.part;
  }
  if (event.properties && event.properties.part && typeof event.properties.part === "object") {
    return event.properties.part;
  }
  return null;
}

function parseMessageTime(info, fallback) {
  const time = info && info.time;
  if (time && typeof time === "object") {
    return parseTimestamp(time.created, fallback);
  }
  return parseTimestamp(time, fallback);
}

function parsePartTime(part, fallback) {
  const time = part && part.time;
  if (time && typeof time === "object") {
    return parseTimestamp(time.start ?? time.created, fallback);
  }
  return parseTimestamp(time, fallback);
}

function isAssistantMessage(info) {
  if (!info || typeof info !== "object") {
    return false;
  }
  if (info.role === "assistant" || info.type === "assistant") {
    return true;
  }
  if (configuredValue(info.providerID, "") !== "" || configuredValue(info.modelID, "") !== "") {
    return true;
  }
  if (info.tokens || typeof info.cost !== "undefined" || info.finish || info.error) {
    return true;
  }
  return false;
}

function isUserMessage(info) {
  if (!info || typeof info !== "object") {
    return false;
  }
  return info.role === "user" || info.type === "user";
}

function messageID(info) {
  return configuredValue(info && info.id, "");
}

function messageSessionID(info, event) {
  return configuredValue(info && info.sessionID, configuredValue(event && event.sessionID, ""));
}

function assistantProvider(info) {
  return configuredValue(info && info.providerID, configuredValue(info && info.model && info.model.providerID, "unknown"));
}

function assistantModel(info) {
  return configuredValue(info && info.modelID, configuredValue(info && info.model && info.model.modelID, "unknown"));
}

function assistantFinalState(info) {
  const hasError = Boolean(info && info.error);
  const status = configuredValue(info && info.status, "").toLowerCase();
  const finish = info && info.finish;
  const done = info && info.done;
  const isFinal = hasError || finish != null || done === true || status === "completed" || status === "error" || status === "failed";
  return {
    isFinal,
    result: hasError || status === "error" || status === "failed" ? "error" : "success",
  };
}

function tokensFromMessage(info) {
  const sources = tokenSources(info);
  const cacheValue = firstNumber(sources, ["cache", "cached", "cached_tokens", "cachedTokens", "cacheReadInputTokens", "cachedInput", "cachedInputTokens"]);
  const input = firstNumber(sources, ["input", "input_tokens", "inputTokens", "prompt", "prompt_tokens", "promptTokens"]);
  const output = firstNumber(sources, ["output", "output_tokens", "outputTokens", "completion", "completion_tokens", "completionTokens"]);
  const reasoning = firstNumber(sources, ["reasoning", "reasoning_tokens", "reasoningTokens"]);
  const explicitContext = firstNumber(sources, ["context", "context_tokens", "contextTokens", "context_size", "contextSize", "context_size_tokens", "contextSizeTokens"]);
  return {
    input,
    output,
    reasoning,
    cached: cacheValue,
    context: explicitContext > 0 ? explicitContext : input + cacheValue + reasoning,
  };
}

function tokenSources(info) {
  if (!info || typeof info !== "object") {
    return [];
  }
  return [
    info.tokens,
    info.usage,
    info.usageTokens,
    info.metadata && info.metadata.tokens,
    info.metadata && info.metadata.usage,
    info.response && info.response.tokens,
    info.response && info.response.usage,
    info.model && info.model.tokens,
    info.model && info.model.usage,
    info,
  ].filter((source) => source && typeof source === "object");
}

function firstNumber(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "undefined" || value === null) {
        continue;
      }
      const parsed = finiteNumber(value);
      if (parsed > 0) {
        return parsed;
      }
    }
  }
  return 0;
}

function updateSessionTitle(recorder, info) {
  const title = extractSessionTitle(info);
  if (title) {
    recorder.title = title;
    recorder.summary = title;
  }
  return recorder.title;
}

export function extractSessionTitle(info) {
  const title = findSessionTitle(info, new Set());
  return isGenericInteractionLabel(title) ? "" : title;
}

function findSessionTitle(value, seen) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return "";
  }
  seen.add(value);
  for (const key of ["title", "name", "summary"]) {
    const candidate = sanitizeDebuggerText(configuredValue(value[key], ""));
    if (candidate && !isGenericInteractionLabel(candidate)) {
      return candidate;
    }
  }
  for (const key of ["session", "metadata", "info", "properties", "data"]) {
    const candidate = findSessionTitle(value[key], seen);
    if (candidate) {
      return candidate;
    }
  }
  return "";
}

function bestSessionSummary(recorder, interactions) {
  for (const candidate of [recorder.title, recorder.summary, interactions[0]?.prompt, interactions[0]?.summary]) {
    const cleaned = sanitizeDebuggerText(configuredValue(candidate, ""));
    if (cleaned && !isGenericInteractionLabel(cleaned)) {
      return cleaned;
    }
  }
  return `OpenCode session ${recorder.id}`;
}

function extractMessageText(info) {
  const direct = sanitizeDebuggerText(configuredValue(info && (info.text ?? info.prompt ?? info.message ?? info.body), ""));
  if (direct !== "") {
    return direct;
  }
  if (typeof info?.content === "string") {
    return sanitizeDebuggerText(info.content);
  }
  if (Array.isArray(info?.content)) {
    return sanitizeDebuggerText(info.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          return configuredValue(part.text ?? part.content ?? part.value, "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim());
  }
  return "";
}

function sanitizeDebuggerText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system>[\s\S]*?<\/system>/gi, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("# Plan Mode - System Reminder"))
    .join("\n")
    .trim();
}

function summarizePrompt(prompt, fallback) {
  const trimmed = configuredValue(prompt, fallback);
  if (trimmed.length <= 80) {
    return trimmed;
  }
  return `${trimmed.slice(0, 77)}...`;
}

function inferResultStatus(values, fallback = "success") {
  return values.some((value) => value === "error" || value === "failed") ? "error" : fallback;
}

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
