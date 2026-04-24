# @distlang/opencode-plugin

OpenCode plugin for capturing coding sessions and uploading them to Distlang AI Debugger.

## Install

Add the plugin to your global OpenCode config:

`~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@distlang/opencode-plugin"]
}
```

OpenCode installs npm plugins automatically with Bun at startup.

## Auth

The plugin does not manage tokens directly.

It relies on Distlang CLI for auth and authenticated requests:

```bash
distlang helpers auth status
distlang helpers login
```

The plugin uses:

- `distlang helpers auth status --json`
- `distlang helpers request POST /ai-debugger/v1/ingest ...`

If you are not logged in, the plugin logs one warning and continues without uploading.

## Debugging

```bash
DISTLANG_OPENCODE_DEBUG=1 opencode
```

## Captured Model

The plugin builds a session-batch payload for Distlang AI Debugger:

- `session`
- `interaction`
- `step`

Step kinds currently emitted when observable:

- `llm_call`
- `tool_call`
- `file_edit`

## Development

```bash
npm test
npm run pack:check
```
