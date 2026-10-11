import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEnvironment } from "../src/lib/env.ts";

const validSessionSecret = "9bA2xQ7vPm4Kz8N1rT6yH3wF5cD0eG9jL2sU7aB4";
const validSetupToken = "vG6kR1mQ8zP3xT9nC5bH2wY7dF4sJ0aL6eU1iO8p";

test("startup accepts long, high-diversity authentication secrets", () => {
  assert.doesNotThrow(() => validateEnvironment({
    SESSION_SECRET: validSessionSecret,
    BHAI_SETUP_TOKEN: validSetupToken,
  }));
});

test("startup rejects the committed example placeholders", () => {
  assert.throws(() => validateEnvironment({
    SESSION_SECRET: "replace_with_a_different_random_hex_value",
    BHAI_SETUP_TOKEN: validSetupToken,
  }), /SESSION_SECRET.*placeholder/);
  assert.throws(() => validateEnvironment({
    SESSION_SECRET: validSessionSecret,
    BHAI_SETUP_TOKEN: "replace_with_another_random_hex_value",
  }), /BHAI_SETUP_TOKEN.*placeholder/);
});

test("startup rejects short or repetitive secrets without revealing their values", () => {
  assert.throws(() => validateEnvironment({
    SESSION_SECRET: "too-short",
    BHAI_SETUP_TOKEN: validSetupToken,
  }), /SESSION_SECRET.*32 characters/);
  assert.throws(() => validateEnvironment({
    SESSION_SECRET: "a".repeat(48),
    BHAI_SETUP_TOKEN: validSetupToken,
  }), /SESSION_SECRET.*placeholder/);
});
