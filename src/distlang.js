import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runDistlang(args, options = {}) {
  return execFileAsync("distlang", args, {
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

export async function getAuthStatus() {
  const { stdout } = await runDistlang(["helpers", "auth", "status", "--json"]);
  return JSON.parse(stdout || "{}");
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
