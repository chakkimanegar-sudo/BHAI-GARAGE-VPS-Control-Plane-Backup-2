import assert from "node:assert/strict";
import { test } from "node:test";
import { exhaustedOperationStatus } from "../src/lib/operation-recovery.ts";

test("an exhausted create operation is marked failed", () => {
  assert.equal(exhaustedOperationStatus("create", { sshPublicKey: "ssh-ed25519 AAAA" }), "failed");
});

test("an exhausted lifecycle operation restores its recorded running state", () => {
  for (const action of ["start", "stop", "restart", "delete"]) {
    assert.equal(exhaustedOperationStatus(action, { previousStatus: "running" }), "running");
  }
});

test("an exhausted lifecycle operation restores its recorded stopped state", () => {
  for (const action of ["start", "stop", "restart", "delete"]) {
    assert.equal(exhaustedOperationStatus(action, { previousStatus: "stopped" }), "stopped");
  }
});

test("untrusted or missing prior state fails closed", () => {
  assert.equal(exhaustedOperationStatus("restart", null), "failed");
  assert.equal(exhaustedOperationStatus("delete", { previousStatus: "provisioning" }), "failed");
  assert.equal(exhaustedOperationStatus("unknown-action", { previousStatus: "running" }), "failed");
});
