import assert from "node:assert/strict";
import test from "node:test";
import { createHostCommandEnv } from "./host-command-env.mts";

test("adds the user's local bin directory without discarding configured values", () => {
  const env = createHostCommandEnv({
    processEnv: { PATH: "/usr/bin", KEEP: "inherited" },
    configuredEnv: { CONFIGURED: "yes" },
    homeDirectory: "/home/agent",
  });

  assert.equal(env.PATH, "/home/agent/.local/bin:/usr/bin");
  assert.equal(env.KEEP, "inherited");
  assert.equal(env.CONFIGURED, "yes");
});

test("does not duplicate the user's local bin directory", () => {
  const env = createHostCommandEnv({
    processEnv: { PATH: "/home/agent/.local/bin:/usr/bin" },
    configuredEnv: {},
    homeDirectory: "/home/agent",
  });

  assert.equal(env.PATH, "/home/agent/.local/bin:/usr/bin");
});
