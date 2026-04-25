import { createRecorder } from "./recorder.js";
import { extractDistlangInvocation } from "./command.js";
import { distlangCommandInfo, fetchAIDebuggerSessions, getAuthStatus, loginWithDistlang, resolveDistlangBinary, uploadAIDebuggerPayload } from "./distlang.js";
import { pluginStatePath, readPluginState, writePluginState } from "./state.js";
import { appendFile } from "node:fs/promises";

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

export const DistlangAIDebugger = async ({ project, directory, client }) => {
  const debug = debugEnabled();
  const recorder = createRecorder({ project, directory });
  let loggedInit = false;
  let authWarningLogged = false;
  let distlangMissingLogged = false;
  let commandHandledAt = 0;

  async function log(level, message, extra = undefined) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      service: "distlang-ai-debugger",
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
        service: "distlang-ai-debugger",
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
    await log(debug ? "debug" : "info", "Distlang OpenCode AI Debugger plugin initialized", {
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

  async function handleDistlangCommand(invocation, source) {
    const now = Date.now();
    if (now - commandHandledAt < 250) {
      return;
    }
    commandHandledAt = now;
    const action = configuredValue(invocation.args[0], "status").toLowerCase();
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
        auth = await getAuthStatus();
        if (!auth || auth.ok !== true || auth.logged_in !== true) {
          await maybeLogCommandResult("info", "Opening browser for Distlang login", { source, action, state, distlang: resolved });
          await loginWithDistlang();
          auth = await getAuthStatus();
        }
      } catch (error) {
        await maybeLogCommandResult("warn", "Distlang uploads enabled, but auth check failed", { source, action, state, distlang: resolved, error: String(error) });
        return;
      }
      await maybeLogCommandResult("info", "Distlang AI Debugger uploads enabled", {
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
      await maybeLogCommandResult("info", "Distlang AI Debugger uploads disabled", { source, action, state });
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
      sessions = await fetchAIDebuggerSessions();
    } catch (error) {
      resolutionError = String(error);
    }
    await maybeLogCommandResult("info", "Distlang AI Debugger status", {
      source,
      action,
      state,
      distlang: resolved,
      auth,
      sessions,
      error: resolutionError,
      command_hint: "/distlang status | /distlang start | /distlang stop",
    });
  }

  async function ensureAuthStatus() {
    if (!(await uploadEnabled())) {
      await debugLog("Distlang AI Debugger uploads are disabled", { state: await readPluginState() });
      return false;
    }
    try {
      const resolved = await resolveDistlangBinary({ installIfMissing: true });
      const payload = await getAuthStatus();
      const authAvailable = payload && payload.ok === true && payload.logged_in === true;
      await debugLog("Distlang auth status resolved", { authAvailable, payload, distlang: resolved });
      if (!authAvailable && !authWarningLogged) {
        authWarningLogged = true;
        await log("warn", "Distlang AI Debugger upload disabled: run `distlang helpers login` first", { auth: payload });
      } else if (authAvailable) {
        authWarningLogged = false;
      }
      return authAvailable;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        if (!distlangMissingLogged) {
          distlangMissingLogged = true;
          await log("warn", "distlang CLI not found; AI Debugger upload disabled", { distlang: distlangCommandInfo() });
        }
      } else if (!authWarningLogged) {
        authWarningLogged = true;
        await log("warn", "Distlang AI Debugger auth check failed; upload disabled", { error: String(error) });
      }
      return false;
    }
  }

  async function finalizeSession(sessionID, result) {
    let payload;
    try {
      payload = recorder.finalizeSession(sessionID, result, Date.now());
    } catch (error) {
      await log("error", "AI Debugger session finalization failed", { sessionID, result, error: String(error) });
      return;
    }
    if (!payload) {
      await debugLog("No payload produced during session finalization", { sessionID, result });
      return;
    }
    await debugLog("Finalized AI Debugger session payload", {
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
      const response = await uploadAIDebuggerPayload(payload);
      await debugLog("AI Debugger upload response received", { sessionID, response });
      if (!response.ok) {
        await log("warn", "AI Debugger upload failed", { sessionID, response });
        return;
      }
      await debugLog("AI Debugger session uploaded", { sessionID, response });
    } catch (error) {
      await log("warn", "AI Debugger upload failed", { sessionID, error: String(error) });
    }
  }

  async function uploadSessionSnapshot(sessionID, result = "success") {
    let payload;
    try {
      payload = recorder.snapshotSession(sessionID, result, Date.now());
    } catch (error) {
      await log("error", "AI Debugger session snapshot failed", { sessionID, result, error: String(error) });
      return;
    }
    if (!payload) {
      await debugLog("No payload produced during session snapshot", { sessionID, result });
      return;
    }
    await debugLog("Prepared AI Debugger session snapshot", {
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
      const response = await uploadAIDebuggerPayload(payload);
      await debugLog("AI Debugger snapshot upload response received", { sessionID, response });
      if (!response.ok) {
        await log("warn", "AI Debugger snapshot upload failed", { sessionID, response });
        return;
      }
      await debugLog("AI Debugger session snapshot uploaded", { sessionID, response });
    } catch (error) {
      await log("warn", "AI Debugger snapshot upload failed", { sessionID, error: String(error) });
    }
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


      if (event.type === "session.idle" || event.type === "session.error") {
	      const sessionID = configuredValue(event.sessionID, recorder.activeSessionID());
	      if (!sessionID) {
	        await debugLog("Session terminal event missing sessionID", { type: event.type, eventKeys: Object.keys(event) });
	        return;
	      }
	      const result = event.type === "session.error" ? "error" : "success";
	      await debugLog(`${event.type} observed`, { sessionID, result });
	      await finalizeSession(sessionID, result);
	      return;
	    }

	    if (event.type === "file.edited") {
	      const observed = recorder.observeFileEdited(event);
	      if (observed) {
	        await debugLog("file.edited observed", observed);
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
	      await debugLog("assistant message update observed", assistantMessage);
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
  };
};

export default DistlangAIDebugger;
