"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {BootstrapContractError, parseBootstrapRequest} = require("../lib/bootstrap-contract");

test("bootstrap remains backward compatible without a grant barrier", () => {
  for (const value of [undefined, null, {}]) {
    assert.deepEqual(parseBootstrapRequest(value), {minimumAccessRevision: null});
  }
});

test("bootstrap accepts one fixed-width minimum access revision", () => {
  assert.deepEqual(parseBootstrapRequest({
    minimumAccessRevision: "00000000000000000042",
  }), {minimumAccessRevision: "00000000000000000042"});
});

test("bootstrap rejects unknown, malformed and numeric barrier values", () => {
  for (const value of [[], "", {unknown: "00000000000000000001"},
    {minimumAccessRevision: 1}, {minimumAccessRevision: "1"},
    {minimumAccessRevision: "00000000000000000001", extra: true}]) {
    assert.throws(() => parseBootstrapRequest(value),
      (error) => error instanceof BootstrapContractError && error.code === "invalid_argument");
  }
});
