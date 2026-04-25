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

## Local use

The plugin uses `distlang` only for two things:

- `distlang helpers auth status --json`
- `distlang helpers request ...`

If `distlang` is not already available, the plugin can install a managed copy automatically.

Managed install location:

```text
~/.cache/distlang/opencode-plugin/bin/distlang
```

Resolution order:

1. `DISTLANG_BIN`
2. `distlang` on `PATH`
3. managed plugin install
4. auto-install into the managed plugin path

## Auth

The plugin does not manage tokens directly.

It relies on Distlang CLI for auth and authenticated requests:

```bash
distlang helpers auth status
distlang helpers login
```

If the plugin installs a managed copy because `distlang` was missing, you can log in with that binary directly:

```bash
~/.cache/distlang/opencode-plugin/bin/distlang helpers login
```

The plugin uses:

- `distlang helpers auth status --json`
- `distlang helpers request POST /ai-debugger/v1/ingest ...`

If you are not logged in, the plugin logs one warning and continues without uploading.

## `/distlang` command

OpenCode commands are configured separately from plugins, so add a command file to make `/distlang` available in the TUI:

`~/.config/opencode/commands/distlang.md`

```md
---
description: Manage Distlang AI Debugger uploads
---

Handled locally by the Distlang OpenCode plugin.
Use `/distlang status`, `/distlang start`, or `/distlang stop`.
```

The plugin watches for this command and handles:

- `/distlang status`
- `/distlang start`
- `/distlang stop`

Command results are written to the OpenCode app log, and also to the debug log file when enabled.

## Debugging

```bash
DISTLANG_OPENCODE_DEBUG=1 opencode
```

Useful overrides:

```bash
DISTLANG_BIN=/path/to/distlang opencode
DISTLANG_STORE_BASE_URL=https://api-staging.distlang.com opencode
DISTLANG_AUTH_BASE_URL=https://auth-staging.distlang.com opencode
DISTLANG_OPENCODE_NO_INSTALL=1 opencode
DISTLANG_OPENCODE_INSTALL_DIR=/tmp/distlang-plugin-bin opencode
DISTLANG_OPENCODE_STATE_FILE=/tmp/distlang-plugin-state.json opencode
DISTLANG_OPENCODE_LOG_FILE=/tmp/distlang-opencode.log opencode
```

To inspect whether uploads are visible after a run:

```bash
distlang helpers request GET /ai-debugger/v1/sessions --json
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

## Release

This repo uses a manual release flow.

1. Verify the package locally:

```bash
npm run release
```

2. Push the release commit:

```bash
git push origin main
```

3. Publish to npm:

```bash
npm run publish
```

4. Create and push the release tag:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

5. Optional GitHub release:

```bash
gh release create v0.1.0 --title "v0.1.0"
```
