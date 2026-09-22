#!/usr/bin/env node
"use strict";

const {initializeApp} = require("firebase-admin/app");
const {getDatabase} = require("firebase-admin/database");
const {configureRealtimeRollout} = require("../lib/rollout-control");

const PROJECT_ID = "sidey-realtime";
const DATABASE_URL = "https://sidey.asia-southeast1.firebasedatabase.app";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  const mode = values.get("--mode");
  const confirm = values.get("--confirm-project");
  const cohort = Number(values.get("--cohort-basis-points") || "0");
  if (!['enable', 'disable'].includes(mode) || confirm !== PROJECT_ID ||
      !Number.isInteger(cohort) || (mode === "enable" && cohort < 1) ||
      (mode === "disable" && cohort !== 0)) {
    throw new Error(
      "usage: --mode enable|disable --confirm-project sidey-realtime " +
      "[--cohort-basis-points 1..10000]",
    );
  }
  return {enabled: mode === "enable", cohortBasisPoints: cohort};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let config;
  try {
    config = JSON.parse(process.env.SIDEY_SUPABASE_CONFIG || "");
  } catch {
    throw new Error("SIDEY_SUPABASE_CONFIG must be valid JSON");
  }
  initializeApp({projectId: PROJECT_ID, databaseURL: DATABASE_URL});
  const state = await configureRealtimeRollout({
    database: getDatabase(),
    config,
    ...args,
  });
  process.stdout.write(JSON.stringify({projectId: PROJECT_ID, ...state}) + "\n");
}

main().catch((error) => {
  process.stderr.write(`rollout configuration failed: ${error.message}\n`);
  process.exitCode = 1;
});
