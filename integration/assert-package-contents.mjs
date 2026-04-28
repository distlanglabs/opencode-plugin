#!/usr/bin/env node
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || "npm pack failed\n");
  process.exit(result.status || 1);
}

const payload = JSON.parse(result.stdout);
const files = payload[0]?.files?.map((file) => file.path) || [];

assert.ok(files.length > 0, "npm pack --dry-run returned no files");
for (const path of files) {
  assert.ok(!path.startsWith("integration/"), `integration file would be published: ${path}`);
  assert.ok(!path.startsWith("test/"), `unit test file would be published: ${path}`);
  assert.ok(!path.includes("auth"), `auth-looking file would be published: ${path}`);
}

for (const required of ["package.json", "README.md", "src/index.js", "src/recorder.js"]) {
  assert.ok(files.includes(required), `required package file missing: ${required}`);
}

process.stdout.write(`package contents ok: ${files.length} files\n`);
