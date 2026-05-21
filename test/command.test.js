import assert from "node:assert/strict";
import test from "node:test";

import { extractDistlangInvocation } from "../src/command.js";

test("extracts explicit distlang slash commands", () => {
  assert.deepEqual(extractDistlangInvocation({ text: "/distlang-start" }), {
    name: "distlang",
    args: [],
    raw: "/distlang-start",
    action: "start",
  });
  assert.deepEqual(extractDistlangInvocation({ text: "/distlang-stop" }), {
    name: "distlang",
    args: [],
    raw: "/distlang-stop",
    action: "stop",
  });
  assert.deepEqual(extractDistlangInvocation({ text: "/distlang-status" }), {
    name: "distlang",
    args: [],
    raw: "/distlang-status",
    action: "status",
  });
  assert.deepEqual(extractDistlangInvocation({ text: "/distlang-view ses_123" }), {
    name: "distlang",
    args: ["ses_123"],
    raw: "/distlang-view ses_123",
    action: "view",
  });
  assert.deepEqual(extractDistlangInvocation({ text: "/distlang-view-local" }), {
    name: "distlang",
    args: [],
    raw: "/distlang-view-local",
    action: "view-local",
  });
});

test("keeps legacy distlang subcommand parsing", () => {
  assert.deepEqual(extractDistlangInvocation({ text: "/distlang start" }), {
    name: "distlang",
    args: ["start"],
    raw: "/distlang start",
  });
  assert.deepEqual(extractDistlangInvocation({ text: "/distlang view ses_123" }), {
    name: "distlang",
    args: ["view", "ses_123"],
    raw: "/distlang view ses_123",
  });
  assert.deepEqual(extractDistlangInvocation({ text: "/distlang view-local" }), {
    name: "distlang",
    args: ["view-local"],
    raw: "/distlang view-local",
  });
  assert.equal(extractDistlangInvocation({ text: "/distlang-restart" }), null);
});
