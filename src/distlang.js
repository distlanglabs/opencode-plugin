import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let managedInstallPromise = null;
let resolvedBinaryPromise = null;

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function autoInstallDisabled() {
  const value = configuredValue(process.env.DISTLANG_OPENCODE_NO_INSTALL, "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function managedInstallDir() {
  const override = configuredValue(process.env.DISTLANG_OPENCODE_INSTALL_DIR, "");
  if (override) {
    return override;
  }
  return join(homedir(), ".cache", "distlang", "opencode-plugin", "bin");
}

function managedBinaryPath() {
  return join(managedInstallDir(), process.platform === "win32" ? "distlang.exe" : "distlang");
}

async function pathHasExecutable(filePath) {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findDistlangOnPath() {
  const pathValue = configuredValue(process.env.PATH, "");
  if (!pathValue) {
    return "";
  }
  const executableNames = process.platform === "win32" ? ["distlang.exe", "distlang.cmd", "distlang.bat"] : ["distlang"];
  for (const part of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    const base = configuredValue(part, "");
    if (!base) {
      continue;
    }
    for (const executableName of executableNames) {
      const candidate = join(base, executableName);
      if (await pathHasExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return "";
}

async function verifyDistlangBinary(filePath) {
  const trimmed = configuredValue(filePath, "");
  if (!trimmed) {
    const error = new Error("distlang binary path is empty");
    error.code = "ENOENT";
    throw error;
  }
  await execFileAsync(trimmed, ["--version"], {
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return trimmed;
}

async function installManagedDistlang() {
  if (managedInstallPromise) {
    return managedInstallPromise;
  }
  managedInstallPromise = (async () => {
    const installDir = managedInstallDir();
    await fs.mkdir(installDir, { recursive: true });
    await execFileAsync("bash", ["-lc", "curl -fsSL https://distlang.com/install-main | bash"], {
      env: {
        ...process.env,
        DISTLANG_INSTALL_DIR: installDir,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    const binaryPath = managedBinaryPath();
    await verifyDistlangBinary(binaryPath);
    return binaryPath;
  })();
  try {
    return await managedInstallPromise;
  } finally {
    managedInstallPromise = null;
  }
}

function distlangBinary() {
  return process.env.DISTLANG_BIN && process.env.DISTLANG_BIN.trim() !== ""
    ? process.env.DISTLANG_BIN.trim()
    : "distlang";
}

export async function resolveDistlangBinary(options = {}) {
  const installIfMissing = options.installIfMissing !== false;
  const explicit = configuredValue(process.env.DISTLANG_BIN, "");
  if (explicit) {
    await verifyDistlangBinary(explicit);
    return { path: explicit, source: "env" };
  }

  if (resolvedBinaryPromise && installIfMissing) {
    return resolvedBinaryPromise;
  }

  const resolver = (async () => {
    const fromPath = await findDistlangOnPath();
    if (fromPath) {
      await verifyDistlangBinary(fromPath);
      return { path: fromPath, source: "path" };
    }

    const managedPath = managedBinaryPath();
    if (await pathHasExecutable(managedPath)) {
      await verifyDistlangBinary(managedPath);
      return { path: managedPath, source: "managed" };
    }

    if (!installIfMissing || autoInstallDisabled()) {
      const error = new Error("distlang CLI not found");
      error.code = "ENOENT";
      throw error;
    }

    const installed = await installManagedDistlang();
    return { path: installed, source: "installed" };
  })();

  if (installIfMissing) {
    resolvedBinaryPromise = resolver;
  }
  try {
    return await resolver;
  } catch (error) {
    if (installIfMissing) {
      resolvedBinaryPromise = null;
    }
    throw error;
  }
}

export async function runDistlang(args, options = {}) {
  const { installIfMissing, ...execOptions } = options;
  const resolved = await resolveDistlangBinary({ installIfMissing: installIfMissing !== false });
  return execFileAsync(resolved.path, args, {
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    ...execOptions,
  });
}

export function distlangCommandInfo() {
  return {
    bin: distlangBinary(),
    managed_bin: managedBinaryPath(),
    auto_install_disabled: autoInstallDisabled(),
  };
}

export async function getAuthStatus() {
  const { stdout } = await runDistlang(["helpers", "auth", "status", "--json"]);
  return JSON.parse(stdout || "{}");
}

export async function loginWithDistlang() {
  return runDistlang(["helpers", "login"]);
}

export async function uploadAIDebuggerPayload(payload) {
  const tempFile = join(tmpdir(), `distlang-ai-debugger-${randomUUID()}.json`);
  await fs.writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    const { stdout } = await runDistlang([
      "helpers",
      "request",
      "POST",
      "/ai-debugger/v1/ingest",
      `--body-file=${tempFile}`,
      "--content-type=application/json",
      "--json",
    ]);
    return JSON.parse(stdout || "{}");
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

export async function fetchAIDebuggerSessions() {
  const { stdout } = await runDistlang([
    "helpers",
    "request",
    "GET",
    "/ai-debugger/v1/sessions?source=opencode&limit=5",
    "--json",
  ]);
  return JSON.parse(stdout || "{}");
}
