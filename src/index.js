import { createRecorder, extractSessionTitle } from "./recorder.js";
import { extractDistlangInvocation } from "./command.js";
import { distlangCommandInfo, fetchAgentDebuggerSessions, getAuthStatus, loginWithDistlang, logoutWithDistlang, resolveDistlangBinary, uploadAgentDebuggerPayload } from "./distlang.js";
import { pluginStatePath, readPluginState, writePluginState } from "./state.js";
import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function debugEnabled() {
  const value = configuredValue(process.env.DISTLANG_OPENCODE_DEBUG, "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function debugLogFile() {
  return configuredValue(process.env.DISTLANG_OPENCODE_LOG_FILE, "");
}

export const DistlangAgentDebugger = async ({ project, directory, client }) => {
  const debug = debugEnabled();
  const recorder = createRecorder({ project, directory, initialPrompt: extractOpenCodeRunPrompt(process.argv) });
  let loggedInit = false;
  let authWarningLogged = false;
  let distlangMissingLogged = false;
  let commandHandledAt = 0;

  async function log(level, message, extra = undefined) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      service: "distlang-agent-debugger",
      level,
      message,
      extra,
    });
    const outputPath = debugLogFile();
    if (outputPath) {
      await appendFile(outputPath, `${line}\n`).catch(() => {});
    }
    if (!client || !client.app || typeof client.app.log !== "function") {
      return;
    }
    await client.app.log({
      body: {
        service: "distlang-agent-debugger",
        level,
        message,
        extra,
      },
    }).catch(() => {});
  }

  async function debugLog(message, extra = undefined) {
    if (!debug) {
      return;
    }
    await log("debug", message, extra);
  }

  async function logInit() {
    if (loggedInit) {
      return;
    }
    loggedInit = true;
    await log(debug ? "debug" : "info", "Distlang OpenCode Agent Debugger plugin initialized", {
      debug,
      statePath: pluginStatePath(),
      distlang: distlangCommandInfo(),
    });
  }

  async function uploadEnabled() {
    const state = await readPluginState();
    return state.enabled !== false;
  }

  async function maybeLogCommandResult(level, message, extra = undefined) {
    await log(level, message, extra);
    if (client?.tui && typeof client.tui.showToast === "function") {
      const variant = level === "error" ? "error" : level === "warn" ? "warning" : level === "info" ? "success" : "info";
      const detail = typeof extra?.error === "string" && extra.error.trim() !== "" ? extra.error.trim() : undefined;
      await client.tui.showToast({
        body: {
          title: "Distlang",
          message: detail ? `${message}: ${detail}` : message,
          variant,
          duration: 5000,
        },
      }).catch(() => {});
    }
  }

  function dashboardBaseUrl() {
    return configuredValue(process.env.DISTLANG_DASHBOARD_URL, "https://dash.distlang.com").replace(/\/+$/, "");
  }

  function sessionUrl(sessionID) {
    const id = configuredValue(sessionID, "");
    return id ? `${dashboardBaseUrl()}/agent-debugger/sessions/${encodeURIComponent(id)}` : "";
  }

  function agentDebuggerUrl() {
    return `${dashboardBaseUrl()}/agent-debugger`;
  }

  function openerCommand() {
    if (process.platform === "darwin") return { command: "open", args: [] };
    if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
    return { command: "xdg-open", args: [] };
  }

  function openUrl(url) {
    const { command, args } = openerCommand();
    return new Promise((resolve) => {
      try {
        const child = spawn(command, [...args, url], { detached: true, stdio: "ignore" });
        child.on("error", () => resolve(false));
        child.unref();
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  }

  function commandArgument(invocation, action) {
    const args = Array.isArray(invocation?.args) ? invocation.args : [];
    if (configuredValue(invocation?.action, "")) {
      return configuredValue(args[0], "");
    }
    return configuredValue(args[0], "").toLowerCase() === action ? configuredValue(args[1], "") : configuredValue(args[0], "");
  }

  function sessionsFromResponse(response) {
    const candidates = [
      response?.body?.sessions,
      response?.sessions,
      response?.body?.data?.sessions,
      response?.data?.sessions,
      response?.body?.items,
      response?.items,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  }

  function firstSessionID(response) {
    for (const session of sessionsFromResponse(response)) {
      const id = configuredValue(session?.id, configuredValue(session?.session_id, ""));
      if (id) return id;
    }
    return "";
  }

  async function ensureCommandAuth(source, action, state = null, resolved = null) {
    let auth = await getAuthStatus();
    if (!auth || auth.ok !== true || auth.logged_in !== true) {
      await maybeLogCommandResult("info", "Opening browser for Distlang login", { source, action, state, distlang: resolved });
      await loginWithDistlang();
      auth = await getAuthStatus();
    }
    return auth;
  }

  async function handleDistlangCommand(invocation, source) {
    const now = Date.now();
    if (now - commandHandledAt < 250) {
      return;
    }
    commandHandledAt = now;
    const requestedAction = configuredValue(invocation.action, configuredValue(invocation.args[0], "status")).toLowerCase();
    const action = requestedAction === "login" ? "start" : requestedAction === "logout" ? "stop" : requestedAction;
    if (!["status", "start", "stop", "view"].includes(action)) {
      await maybeLogCommandResult("warn", "Unknown Distlang command. Use /distlang-status, /distlang-start, /distlang-stop, or /distlang-view", {
        source,
        action: requestedAction,
        command_hint: "/distlang-status | /distlang-start | /distlang-stop | /distlang-view",
      });
      return;
    }
    if (action === "start") {
      const state = await writePluginState(true);
      authWarningLogged = false;
      let resolved = null;
      let auth = null;
      try {
        resolved = await resolveDistlangBinary({ installIfMissing: true });
      } catch (error) {
        await maybeLogCommandResult("warn", "Distlang uploads enabled, but distlang install/resolve failed", { source, action, error: String(error) });
        return;
      }
      try {
        auth = await ensureCommandAuth(source, action, state, resolved);
      } catch (error) {
        await maybeLogCommandResult("warn", "Distlang uploads enabled, but auth check failed", { source, action, state, distlang: resolved, error: String(error) });
        return;
      }
      await maybeLogCommandResult("info", "Distlang Agent Debugger uploads enabled", {
        source,
        action,
        state,
        distlang: resolved,
        auth,
      });
      return;
    }

    if (action === "stop") {
      const state = await writePluginState(false);
      authWarningLogged = false;
      try {
        const resolved = await resolveDistlangBinary({ installIfMissing: true });
        await logoutWithDistlang();
        await maybeLogCommandResult("info", "Distlang Agent Debugger uploads disabled and signed out", { source, action, state, distlang: resolved });
      } catch (error) {
        await maybeLogCommandResult("warn", "Distlang Agent Debugger uploads disabled, but sign out failed", { source, action, state, error: String(error) });
      }
      return;
    }

    if (action === "view") {
      const state = await readPluginState();
      let resolved = null;
      let auth = null;
      let sessions = null;
      try {
        resolved = await resolveDistlangBinary({ installIfMissing: true });
        auth = await ensureCommandAuth(source, action, state, resolved);
        sessions = await fetchAgentDebuggerSessions();
      } catch (error) {
        await maybeLogCommandResult("warn", "Unable to open Distlang Agent Debugger session", { source, action, state, distlang: resolved, error: String(error) });
        return;
      }
      const sessionID = commandArgument(invocation, action) || firstSessionID(sessions);
      const url = sessionID ? sessionUrl(sessionID) : agentDebuggerUrl();
      const opened = await openUrl(url);
      if (!sessionID) {
        await maybeLogCommandResult("info", `Open Distlang Agent Debugger: ${url}`, {
          source,
          action,
          state,
          distlang: resolved,
          auth,
          session_id: null,
          url,
          opened,
          fallback: "agent_debugger_overview",
          sessions,
        });
        return;
      }
      await maybeLogCommandResult("info", `Open Distlang Agent Debugger session: ${url}`, {
        source,
        action,
        state,
        distlang: resolved,
        auth,
        session_id: sessionID,
        url,
        opened,
        sessions,
      });
      return;
    }

    const state = await readPluginState();
    let resolved = null;
    let auth = null;
    let sessions = null;
    let resolutionError = null;
    try {
      resolved = await resolveDistlangBinary({ installIfMissing: true });
      auth = await getAuthStatus();
      sessions = await fetchAgentDebuggerSessions();
    } catch (error) {
      resolutionError = String(error);
    }
    await maybeLogCommandResult("info", "Distlang Agent Debugger status", {
      source,
      action,
      state,
      distlang: resolved,
      auth,
      sessions,
      error: resolutionError,
      command_hint: "/distlang-status | /distlang-start | /distlang-stop | /distlang-view",
    });
  }

  async function ensureAuthStatus() {
    if (!(await uploadEnabled())) {
      await debugLog("Distlang Agent Debugger uploads are disabled", { state: await readPluginState() });
      return false;
    }
    try {
      const resolved = await resolveDistlangBinary({ installIfMissing: true });
      const payload = await getAuthStatus();
      const authAvailable = payload && payload.ok === true && payload.logged_in === true;
      await debugLog("Distlang auth status resolved", { authAvailable, payload, distlang: resolved });
      if (!authAvailable && !authWarningLogged) {
        authWarningLogged = true;
        await maybeLogCommandResult("warn", "Distlang Agent Debugger upload disabled: run `/distlang-start` to sign in and enable uploads", {
          auth: payload,
          command_hint: "/distlang-start",
        });
      } else if (authAvailable) {
        authWarningLogged = false;
      }
      return authAvailable;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        if (!distlangMissingLogged) {
          distlangMissingLogged = true;
          await log("warn", "distlang CLI not found; Agent Debugger upload disabled", { distlang: distlangCommandInfo() });
        }
      } else if (!authWarningLogged) {
        authWarningLogged = true;
        await log("warn", "Distlang Agent Debugger auth check failed; upload disabled", { error: String(error) });
      }
      return false;
    }
  }

  async function finalizeSession(sessionID, result) {
    let payload;
    try {
      await refreshSessionMetadata(sessionID, { retry: true });
      payload = recorder.finalizeSession(sessionID, result, Date.now());
    } catch (error) {
      await log("error", "Agent Debugger session finalization failed", { sessionID, result, error: String(error) });
      return;
    }
    if (!payload) {
      await debugLog("No payload produced during session finalization", { sessionID, result });
      return;
    }
    await debugLog("Finalized Agent Debugger session payload", {
      sessionID,
      result,
      interactions: Array.isArray(payload.interactions) ? payload.interactions.length : 0,
      steps: Array.isArray(payload.interactions) ? payload.interactions.reduce((total, interaction) => total + (Array.isArray(interaction.steps) ? interaction.steps.length : 0), 0) : 0,
      project: payload.project,
    });
    if (!(await ensureAuthStatus())) {
      await debugLog("Skipping AI debugger upload because auth is unavailable", { sessionID });
      return;
    }
    try {
      const response = await uploadAgentDebuggerPayload(payload);
      await debugLog("Agent Debugger upload response received", { sessionID, response });
      if (!response.ok) {
        await log("warn", "Agent Debugger upload failed", { sessionID, response });
        return;
      }
      await debugLog("Agent Debugger session uploaded", { sessionID, response });
    } catch (error) {
      await log("warn", "Agent Debugger upload failed", { sessionID, error: String(error) });
    }
  }

  async function uploadSessionSnapshot(sessionID, result = "success") {
    let payload;
    try {
      await refreshSessionMetadata(sessionID, { retry: true });
      payload = recorder.snapshotSession(sessionID, result, Date.now());
    } catch (error) {
      await log("error", "Agent Debugger session snapshot failed", { sessionID, result, error: String(error) });
      return;
    }
    if (!payload) {
      await debugLog("No payload produced during session snapshot", { sessionID, result });
      return;
    }
    await debugLog("Prepared Agent Debugger session snapshot", {
      sessionID,
      result,
      interactions: Array.isArray(payload.interactions) ? payload.interactions.length : 0,
      steps: Array.isArray(payload.interactions) ? payload.interactions.reduce((total, interaction) => total + (Array.isArray(interaction.steps) ? interaction.steps.length : 0), 0) : 0,
      project: payload.project,
    });
    if (!(await ensureAuthStatus())) {
      await debugLog("Skipping AI debugger snapshot upload because auth is unavailable", { sessionID });
      return;
    }
    try {
      const response = await uploadAgentDebuggerPayload(payload);
      await debugLog("Agent Debugger snapshot upload response received", { sessionID, response });
      if (!response.ok) {
        await log("warn", "Agent Debugger snapshot upload failed", { sessionID, response });
        return;
      }
      await debugLog("Agent Debugger session snapshot uploaded", { sessionID, response });
    } catch (error) {
      await log("warn", "Agent Debugger snapshot upload failed", { sessionID, error: String(error) });
    }
  }

  async function refreshSessionMetadata(sessionID, options = {}) {
    if (!sessionID || !client?.session || typeof client.session.get !== "function") {
      return;
    }
    const attempts = options.retry ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await client.session.get({ path: { id: sessionID } });
        const session = response?.data ?? response;
        const title = extractSessionTitle(session);
        await debugLog("OpenCode session metadata inspected", { sessionID, attempt, sessionKeys: session && typeof session === "object" ? Object.keys(session) : [] });
        if (title) {
          recorder.setSessionTitle(sessionID, title);
          await debugLog("OpenCode session metadata refreshed", { sessionID, attempt, titleLength: title.length });
          return;
        }
      } catch (error) {
        await debugLog("OpenCode session metadata refresh failed", { sessionID, attempt, error: String(error) });
      }
      if (attempt < attempts) {
        await sleep(500);
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractOpenCodeRunPrompt(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const runIndex = args.findIndex((arg) => arg === "run");
    if (runIndex < 0) {
      return "";
    }
    const promptParts = [];
    for (let index = runIndex + 1; index < args.length; index += 1) {
      const arg = configuredValue(args[index], "");
      if (!arg) {
        continue;
      }
      if (arg === "--") {
        continue;
      }
      if (arg === "--dangerously-skip-permissions") {
        continue;
      }
      if (arg === "--model" || arg === "-m") {
        index += 1;
        continue;
      }
      if (arg.startsWith("--model=")) {
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
      promptParts.push(arg);
    }
    return promptParts.join(" ").trim();
  }

  function messageShape(event) {
    const info = event && typeof event === "object" ? event.info ?? event.properties?.info : null;
    if (!info || typeof info !== "object") {
      return { eventKeys: Object.keys(event || {}) };
    }
    return {
      eventKeys: Object.keys(event || {}),
      infoKeys: Object.keys(info),
      tokenKeys: info.tokens && typeof info.tokens === "object" ? Object.keys(info.tokens) : [],
      usageKeys: info.usage && typeof info.usage === "object" ? Object.keys(info.usage) : [],
      metadataKeys: info.metadata && typeof info.metadata === "object" ? Object.keys(info.metadata) : [],
      responseKeys: info.response && typeof info.response === "object" ? Object.keys(info.response) : [],
      hasTitle: Boolean(info.title || info.name || info.summary),
    };
  }

  return {
    event: async ({ event }) => {
      await logInit();
      if (!event || typeof event !== "object") {
        return;
      }

      if (event.type === "command.executed") {
        const invocation = extractDistlangInvocation(event);
        if (invocation) {
          await handleDistlangCommand(invocation, "command.executed");
        }
        return;
      }


      if (event.type === "session.created") {
	      const observed = recorder.observeSessionCreated(event);
	      if (observed) {
	        await debugLog("session.created observed", observed);
	      }
        return;
      }

      if (event.type === "session.updated") {
	      const observed = recorder.observeSessionUpdated(event);
	      if (observed) {
	        await debugLog("session.updated observed", observed);
	      }
        return;
      }



      if (event.type === "session.idle" || event.type === "session.error") {
	      const sessionID = configuredValue(event.sessionID, recorder.activeSessionID());
	      if (!sessionID) {
	        await debugLog("Session snapshot event missing sessionID", { type: event.type, eventKeys: Object.keys(event) });
	        return;
	      }
	      const result = event.type === "session.error" ? "error" : "success";
	      await debugLog(`${event.type} observed`, { sessionID, result });
	      await uploadSessionSnapshot(sessionID, result);
	      return;
	    }

	    if (event.type === "file.edited") {
	      const observed = recorder.observeFileEdited(event);
	      if (observed) {
	        await debugLog("file.edited observed", observed);
	      }
	      return;
	    }

	    if (event.type === "message.part.updated") {
	      const observed = recorder.observeMessagePartUpdated(event);
	      if (observed) {
	        await debugLog("message.part.updated observed", observed);
	      }
	      return;
	    }

	    if (event.type !== "message.updated") {
	      return;
	    }

	    const userMessage = recorder.observeUserMessage(event);
	    if (userMessage) {
	      await debugLog("user message observed", userMessage);
	      return;
	    }

	    const assistantMessage = recorder.observeAssistantMessage(event);
	    if (assistantMessage) {
	      await debugLog("assistant message update observed", { ...assistantMessage, shape: messageShape(event) });
	      if (assistantMessage.finalized) {
	        await uploadSessionSnapshot(assistantMessage.sessionID, "success");
	      }
	    }
    },

    "tui.command.execute": async (input) => {
      await logInit();
      const invocation = extractDistlangInvocation(input);
      if (!invocation) {
        return;
      }
      await handleDistlangCommand(invocation, "tui.command.execute");
    },

    "command.execute.before": async (input, output) => {
      await logInit();
      const invocation = extractDistlangInvocation(input);
      if (!invocation) {
        return;
      }
      await handleDistlangCommand(invocation, "command.execute.before");
      output.parts = [];
    },

    "tool.execute.before": async (input) => {
      await logInit();
      const observed = recorder.observeToolBefore(input);
      if (observed) {
        await debugLog("tool.execute.before observed", observed);
      }
    },

    "tool.execute.after": async (input, output) => {
      await logInit();
      const observed = recorder.observeToolAfter(input, output);
      if (observed) {
        await debugLog("tool.execute.after observed", observed);
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      await logInit();
      const sessionID = configuredValue(input && input.sessionID, recorder.activeSessionID());
      const observed = recorder.observeSystemPrompt(sessionID, output && output.system);
      if (observed) {
        await debugLog("experimental.chat.system.transform observed", observed);
      }
    },
  };
};

export default DistlangAgentDebugger;
