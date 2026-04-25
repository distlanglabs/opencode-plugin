import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function defaultState() {
  return {
    enabled: true,
    updated_at: null,
  };
}

export function pluginStatePath() {
  const override = configuredValue(process.env.DISTLANG_OPENCODE_STATE_FILE, "");
  if (override) {
    return override;
  }
  return join(homedir(), ".config", "opencode", "distlang-plugin.json");
}

export async function readPluginState() {
  const filePath = pluginStatePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed && parsed.enabled === false ? false : true,
      updated_at: typeof parsed?.updated_at === "string" && parsed.updated_at.trim() !== "" ? parsed.updated_at : null,
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return defaultState();
    }
    return defaultState();
  }
}

export async function writePluginState(enabled) {
  const filePath = pluginStatePath();
  await fs.mkdir(dirname(filePath), { recursive: true });
  const payload = {
    enabled: enabled !== false,
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}
