"use strict";

const REVISION_PATTERN = /^[0-9]{20}$/;

class BootstrapContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "BootstrapContractError";
    this.code = code;
  }
}

function parseBootstrapRequest(value) {
  if (value === undefined || value === null) return {minimumAccessRevision: null};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BootstrapContractError("invalid_argument");
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return {minimumAccessRevision: null};
  if (keys.length !== 1 || keys[0] !== "minimumAccessRevision" ||
      typeof value.minimumAccessRevision !== "string" ||
      !REVISION_PATTERN.test(value.minimumAccessRevision)) {
    throw new BootstrapContractError("invalid_argument");
  }
  return {minimumAccessRevision: value.minimumAccessRevision};
}

module.exports = {BootstrapContractError, parseBootstrapRequest, REVISION_PATTERN};
