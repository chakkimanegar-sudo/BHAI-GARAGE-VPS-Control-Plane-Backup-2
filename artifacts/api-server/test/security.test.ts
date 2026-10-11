import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRateLimit } from "../src/lib/security.ts";

test("rate limit buckets block over-limit attempts and reset after the window", () => {
  const now = Date.now() + 10_000;
  assert.deepEqual(checkRateLimit("security-window-test", 2, 60_000, now), {
    allowed: true,
    retryAfterSeconds: 0,
  });
  assert.equal(checkRateLimit("security-window-test", 2, 60_000, now + 1).allowed, true);
  const blocked = checkRateLimit("security-window-test", 2, 60_000, now + 2);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.equal(checkRateLimit("security-window-test", 2, 60_000, now + 60_001).allowed, true);
});

test("rate limit storage refuses new buckets at its capacity", () => {
  const now = Date.now() + 16 * 60_000;
  let denied = false;
  for (let index = 0; index < 12_000; index += 1) {
    const result = checkRateLimit(`security-capacity-${index}`, 2, 15 * 60_000, now);
    if (!result.allowed) {
      denied = true;
      break;
    }
  }
  assert.equal(denied, true, "new keys must be rejected rather than growing the map without bound");
});
