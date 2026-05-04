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

## Distlang commands

OpenCode commands are configured separately from plugins, so add command files to make the Distlang controls available in the TUI:

`~/.config/opencode/commands/distlang-start.md`

```md
---
description: Sign in and enable Distlang AI Debugger uploads
---
```

`~/.config/opencode/commands/distlang-stop.md`

```md
---
description: Disable Distlang AI Debugger uploads and sign out
---
```

`~/.config/opencode/commands/distlang-status.md`

```md
---
description: Show Distlang AI Debugger upload status
---
```

The plugin watches for these commands:

- `/distlang-start`
- `/distlang-stop`
- `/distlang-status`

The legacy compact command also remains supported:

- `/distlang status`
- `/distlang start`
- `/distlang stop`
- `/distlang login`
- `/distlang logout`

Command results are written to the OpenCode app log, and also to the debug log file when enabled.

If `/distlang-start` finds that Distlang auth is missing, the plugin starts `distlang helpers login`, which opens the browser login flow.

### Command usage

Run these inside the OpenCode TUI:

```text
/distlang-start
/distlang-status
```

Commands:

- `/distlang-status`: show whether uploads are enabled, whether auth is available, and whether recent AI Debugger sessions are visible
- `/distlang-start`: sign in if needed and enable AI Debugger uploads
- `/distlang-stop`: disable AI Debugger uploads and sign out of Distlang

Legacy aliases remain available: `/distlang status`, `/distlang start`, `/distlang stop`, `/distlang login`, and `/distlang logout`.

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

### Local OpenCode integration test

The repository includes a live local integration harness. It is not included in the published npm package.

The harness uses your existing local OpenCode auth to run the requested model. It does not read, copy, or print OpenCode credential files. It writes only a temporary OpenCode config that loads this local plugin source.

```bash
npm run test:opencode -- --model openai/gpt-5.5
```

If `--model` and `OPENCODE_MODEL` are omitted, the harness defaults to `openai/gpt-5.5`. Use any provider-qualified model ID shown by `opencode models`.

Useful flags:

- `--require-upload` fails unless Distlang auth is available and the uploaded AI Debugger session validates.
- `--keep-session` keeps the uploaded AI Debugger session for dashboard inspection.
- `--keep-temp` keeps temporary logs and fixtures for debugging. Do not commit those files.
- `--verbose` prints redacted command output.

The default test validates local plugin capture from the plugin debug log. If `distlang` is authenticated, it also validates the uploaded session and deletes it unless `--keep-session` is set.

For upload validation, the harness resolves Distlang from `DISTLANG_BIN`, `distlang` on `PATH`, or the plugin-managed binary at `~/.cache/distlang/opencode-plugin/bin/distlang`.

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
npm run publish:public
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
