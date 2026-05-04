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
});

test("keeps legacy distlang subcommand parsing", () => {
  assert.deepEqual(extractDistlangInvocation({ text: "/distlang start" }), {
    name: "distlang",
    args: ["start"],
    raw: "/distlang start",
  });
  assert.equal(extractDistlangInvocation({ text: "/distlang-restart" }), null);
});
