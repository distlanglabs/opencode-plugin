function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function splitCommandText(value) {
  const trimmed = configuredValue(value, "");
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const parts = trimmed.slice(1).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return {
    name: parts[0].toLowerCase(),
    args: parts.slice(1),
    raw: trimmed,
  };
}

function normalizeArgs(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => configuredValue(entry, "")).filter(Boolean);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

function commandLike(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const directName = configuredValue(entry.name, configuredValue(entry.command, configuredValue(entry.id, configuredValue(entry.slug, "")))).replace(/^\//, "").toLowerCase();
  const args = normalizeArgs(entry.args ?? entry.arguments ?? entry.argv);
  if (directName) {
    return {
      name: directName,
      args,
      raw: configuredValue(entry.raw, args.length > 0 ? `/${directName} ${args.join(" ")}` : `/${directName}`),
    };
  }
  const text = splitCommandText(configuredValue(entry.text, configuredValue(entry.input, configuredValue(entry.value, configuredValue(entry.prompt, "")))));
  if (text) {
    return text;
  }
  return null;
}

export function extractDistlangInvocation(input) {
  const candidates = [
    input,
    input?.event,
    input?.properties,
    input?.command,
    input?.info,
    input?.properties,
    input?.payload,
  ];
  for (const candidate of candidates) {
    const parsed = commandLike(candidate);
    const invocation = distlangInvocation(parsed);
    if (invocation) {
      return invocation;
    }
  }

  const directText = splitCommandText(configuredValue(input?.commandLine, configuredValue(input?.text, configuredValue(input?.input, configuredValue(input?.raw, "")))));
  return distlangInvocation(directText);
}

function distlangInvocation(parsed) {
  if (!parsed) {
    return null;
  }
  if (parsed.name === "distlang") {
    return parsed;
  }
  const action = parsed.name.startsWith("distlang-") ? parsed.name.slice("distlang-".length) : "";
  if (action === "start" || action === "stop" || action === "status") {
    return {
      ...parsed,
      name: "distlang",
      action,
      raw: parsed.raw || `/${parsed.name}`,
    };
  }
  return null;
}
