import { createRecorder } from "./recorder.js";
import { distlangCommandInfo, getAuthStatus, uploadAIDebuggerPayload } from "./distlang.js";
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
  let authChecked = false;
  let authAvailable = false;
  let authWarningLogged = false;
  let distlangMissingLogged = false;

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
      distlang: distlangCommandInfo(),
    });
  }

  async function ensureAuthStatus() {
    if (authChecked) {
      return authAvailable;
    }
    authChecked = true;
    try {
      const payload = await getAuthStatus();
      authAvailable = payload && payload.ok === true && payload.logged_in === true;
      await debugLog("Distlang auth status resolved", { authAvailable, payload });
      if (!authAvailable && !authWarningLogged) {
        authWarningLogged = true;
        await log("warn", "Distlang AI Debugger upload disabled: run `distlang helpers login` first", { auth: payload });
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
      authAvailable = false;
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
