#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const defaultModel = "openai/gpt-5.5";

const opts = parseArgs(process.argv.slice(2));
const model = opts.model || process.env.OPENCODE_MODEL || defaultModel;

const opencodePath = findCommand("opencode");
if (!opencodePath) {
  fail("opencode is not installed or not on PATH.");
}

class CleanupOnly extends Error {}

const tempRoot = await mkdtemp(join(tmpdir(), "distlang-opencode-plugin-it-"));
let uploadedSessionID = "";
let shouldExitAfterCleanup = false;

try {
  const projectDir = join(tempRoot, "project");
  const configDir = join(tempRoot, "opencode-config");
  const pluginsDir = join(configDir, "plugins");
  const pluginLogPath = join(tempRoot, "plugin.log");
  const pluginStatePath = join(tempRoot, "plugin-state.json");
  const pluginInstallDir = join(tempRoot, "distlang-plugin-bin");
  await mkdir(projectDir, { recursive: true });
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(join(projectDir, "README.md"), "# Distlang OpenCode integration fixture\n", "utf8");
  await writeFile(join(configDir, "opencode.json"), "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n", "utf8");
  await writeFile(join(pluginsDir, "distlang-local.mjs"), `export { default, DistlangAgentDebugger } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "index.js")).href)};\n`, "utf8");

  runCommand("git", ["init", "-b", "main"], { cwd: projectDir, verbose: opts.verbose });

  const runID = newRunID();
  const targetFile = `distlang-opencode-local-${runID}.txt`;
  const prompt = `Create a file named ${targetFile} containing the exact text ${runID}, then explain what changed in one sentence.`;
  const distlangPath = findDistlangCommand();
  const env = {
    ...process.env,
    OPENCODE_CONFIG: join(configDir, "opencode.json"),
    OPENCODE_CONFIG_DIR: configDir,
    DISTLANG_OPENCODE_DEBUG: "1",
    DISTLANG_OPENCODE_LOG_FILE: pluginLogPath,
    DISTLANG_OPENCODE_STATE_FILE: pluginStatePath,
    DISTLANG_OPENCODE_INSTALL_DIR: pluginInstallDir,
  };
  if (distlangPath) {
    env.DISTLANG_BIN = distlangPath;
  }

  const args = ["run", "--dangerously-skip-permissions", "--model", model, prompt];
  info(`running opencode with model ${model}`);
  runCommand(opencodePath, args, { cwd: projectDir, env, verbose: opts.verbose, redact: true });

  const pluginLog = await safeRead(pluginLogPath);
  assertIncludes(pluginLog, "Distlang OpenCode Agent Debugger plugin initialized", "plugin did not initialize");
  assertIncludes(pluginLog, "message.part.updated observed", "plugin did not observe OpenCode text parts");
  assertIncludes(pluginLog, "assistant message update observed", "plugin did not observe assistant message updates");
  assertIncludes(pluginLog, "tool.execute.after observed", "plugin did not observe tool execution steps");
  assertIncludes(pluginLog, targetFile, "plugin log did not include the unique prompt target");
  assertNoCredentialMarkers(pluginLog, "plugin log");

  if (!distlangPath) {
    if (opts.requireUpload) {
      fail("--require-upload was set, but distlang is not on PATH and DISTLANG_BIN is unset.");
    }
    info("local prompt capture passed; upload validation skipped because distlang is unavailable");
    shouldExitAfterCleanup = true;
    throw new CleanupOnly();
  }

  const auth = distlangAuthStatus(distlangPath, opts.verbose);
  if (!auth.loggedIn) {
    if (opts.requireUpload) {
      fail("--require-upload was set, but distlang is not logged in.");
    }
    info("local prompt capture passed; upload validation skipped because distlang is not logged in");
    shouldExitAfterCleanup = true;
    throw new CleanupOnly();
  }

  const detail = await pollUploadedSession({ distlangPath, project: basename(projectDir), targetFile, startedAt: Date.now() - 5000, verbose: opts.verbose });
  uploadedSessionID = detail.session.id;
  assertUploadedPrompt(detail, targetFile);
  assertUploadedTelemetry(detail);
  info(`upload validation passed for session ${uploadedSessionID}`);
} catch (error) {
  if (!(error instanceof CleanupOnly)) {
    throw error;
  }
} finally {
  if (uploadedSessionID && !opts.keepSession) {
    const distlangPath = findDistlangCommand();
    if (distlangPath) {
      distlangRequest(distlangPath, "DELETE", `/agent-debugger/v1/sessions/${encodeURIComponent(uploadedSessionID)}`, opts.verbose);
      info(`deleted uploaded session ${uploadedSessionID}`);
    }
  }
  if (opts.keepTemp) {
    info(`kept temp directory ${tempRoot}`);
    info("temp logs include prompt text and local paths; do not commit them");
  } else {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (shouldExitAfterCleanup) {
  process.exit(0);
}

function parseArgs(args) {
  const parsed = { model: "", requireUpload: false, keepSession: false, keepTemp: false, verbose: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      parsed.model = args[++index] || "";
    } else if (arg.startsWith("--model=")) {
      parsed.model = arg.slice("--model=".length);
    } else if (arg === "--require-upload") {
      parsed.requireUpload = true;
    } else if (arg === "--keep-session") {
      parsed.keepSession = true;
    } else if (arg === "--keep-temp") {
      parsed.keepTemp = true;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printUsage() {
  process.stdout.write(`Usage: npm run test:opencode -- [--model <model>] [--require-upload] [--keep-session] [--keep-temp] [--verbose]\nDefault model: ${defaultModel}\n`);
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = redact(String(result.stdout || ""));
  const stderr = redact(String(result.stderr || ""));
  if (options.verbose) {
    if (stdout.trim()) {
      info(`${basename(command)} stdout:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      info(`${basename(command)} stderr:\n${stderr.trim()}`);
    }
  }
  if (result.status !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    fail(`${basename(command)} failed with exit ${result.status}${detail ? `\n${detail}` : ""}`);
  }
  if (/ProviderModelNotFoundError|Model not found|ProviderAuthError/i.test(stderr)) {
    fail(`${basename(command)} reported a provider/model error\n${stderr.trim()}`);
  }
  return stdout;
}

function distlangAuthStatus(distlangPath, verbose) {
  const output = runCommand(distlangPath, ["helpers", "auth", "status", "--json"], { verbose: false });
  const payload = parseJSON(output, "distlang auth status");
  if (verbose) {
    info(`distlang auth status: ${payload && payload.ok === true && payload.logged_in === true ? "logged in" : "not logged in"}`);
  }
  return { loggedIn: payload && payload.ok === true && payload.logged_in === true };
}

function distlangRequest(distlangPath, method, path, verbose) {
  const output = runCommand(distlangPath, ["helpers", "request", method, path, "--json"], { verbose });
  const envelope = parseJSON(output, `distlang ${method} ${path}`);
  if (!envelope || envelope.ok !== true) {
    fail(`distlang ${method} ${path} failed: ${redact(envelope?.message || envelope?.error || "unknown error")}`);
  }
  return envelope.body;
}

async function pollUploadedSession({ distlangPath, project, targetFile, startedAt, verbose }) {
  const deadline = Date.now() + 65000;
  while (Date.now() < deadline) {
    const list = distlangRequest(distlangPath, "GET", `/agent-debugger/v1/sessions?source=opencode&project=${encodeURIComponent(project)}&limit=10`, verbose);
    for (const session of list.sessions || []) {
      const started = Date.parse(session.started_at || "");
      if (Number.isFinite(started) && started < startedAt) {
        continue;
      }
      const detail = distlangRequest(distlangPath, "GET", `/agent-debugger/v1/sessions/${encodeURIComponent(session.id)}`, verbose);
      if (JSON.stringify(detail).includes(targetFile)) {
        return detail;
      }
    }
    await sleep(2000);
  }
  fail(`uploaded Agent Debugger session containing ${targetFile} did not appear before timeout`);
}

function assertUploadedPrompt(detail, targetFile) {
  const interactions = Array.isArray(detail.interactions) ? detail.interactions : [];
  assert.ok(interactions.length > 0, "uploaded session has no interactions");
  const match = interactions.find((interaction) => String(interaction.prompt || "").includes(targetFile));
  assert.ok(match, "uploaded interactions did not include the typed OpenCode prompt");
  for (const interaction of interactions) {
    const prompt = String(interaction.prompt || "").trim();
    assert.ok(prompt, "uploaded interaction prompt is empty");
    assert.ok(!/^OpenCode interaction \d+$/i.test(prompt), `uploaded interaction prompt is generic: ${prompt}`);
    assert.ok(!/^Interaction \d+$/i.test(prompt), `uploaded interaction prompt is generic: ${prompt}`);
  }
}

function assertUploadedTelemetry(detail) {
  const session = detail.session || {};
  assert.ok((session.input_tokens || 0) + (session.output_tokens || 0) + (session.reasoning_tokens || 0) + (session.cached_tokens || 0) > 0, "uploaded session token totals are zero");
  const interactions = Array.isArray(detail.interactions) ? detail.interactions : [];
  const steps = Array.isArray(detail.steps) ? detail.steps : [];
  const llmStep = steps.find((step) => step.kind === "llm_call");
  assert.ok(llmStep, "uploaded session has no llm_call step");
  assert.ok(String(llmStep.model || "").trim(), "uploaded llm_call step has no model");
  const multiStepInteraction = interactions.find((interaction) => {
    const interactionSteps = steps.filter((step) => step.interaction_id === interaction.id);
    const kinds = new Set(interactionSteps.map((step) => step.kind));
    return interactionSteps.length >= 2 && kinds.has("llm_call") && (kinds.has("tool_call") || kinds.has("file_edit"));
  });
  assert.ok(multiStepInteraction, "uploaded session has no multi-step interaction with llm_call and tool/file steps");
}

function assertIncludes(value, expected, message) {
  assert.ok(String(value).includes(expected), message);
}

function assertNoCredentialMarkers(value, label) {
  const text = String(value).toLowerCase();
  for (const marker of ["authorization:", "bearer ", "api_key", "apikey", "access_token", "refresh_token", "id_token", "client_secret"]) {
    assert.ok(!text.includes(marker), `${label} includes credential-like marker ${marker}`);
  }
}

async function safeRead(path) {
  if (!existsSync(path)) {
    return "";
  }
  return readFile(path, "utf8");
}

function parseJSON(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`failed to parse ${label} JSON: ${error.message}`);
  }
}

function findCommand(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(command)}`], { encoding: "utf8" });
  if (result.status !== 0) {
    return "";
  }
  return String(result.stdout || "").trim();
}

function findDistlangCommand() {
  if (process.env.DISTLANG_BIN) {
    return process.env.DISTLANG_BIN;
  }
  const pathCommand = findCommand("distlang");
  if (pathCommand) {
    return pathCommand;
  }
  const managed = join(process.env.HOME || "", ".cache", "distlang", "opencode-plugin", "bin", "distlang");
  return existsSync(managed) ? managed : "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function redact(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:access|refresh|id)_token\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(client_secret\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/usr_[A-Za-z0-9]+/g, "usr_[REDACTED]");
}

function newRunID() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function info(message) {
  process.stdout.write(`[opencode-it] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[opencode-it] ${message}\n`);
  process.exit(1);
}
