import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {EventStreamParser, firebaseRedirect} from "../../../scripts/realtime-tests/staging-load-core.mjs";

const contract = JSON.parse(fs.readFileSync(
  new URL("../../contract-v2.fixture.json", import.meta.url),
  "utf8",
));
const room = "20000000-0000-4000-8000-000000000001";

test("Windows REST fixture uses the canonical .json auth URL", () => {
  const url = new URL(`${contract.databaseURL}/v2/l/${room}.json`);
  url.searchParams.set("auth", "firebase-id-token");
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "sidey.asia-southeast1.firebasedatabase.app");
  assert.equal(url.pathname, `/v2/l/${room}.json`);
  assert.deepEqual([...url.searchParams.keys()], ["auth"]);
});

test("Windows SSE fixture accepts fragmented compact put and patch frames", () => {
  const events = [];
  const parser = new EventStreamParser((event) => events.push(event));
  const frames = new TextEncoder().encode(
    "event: put\r\ndata: {\"path\":\"/\",\"data\":{\"e\":{\"i\":\"30000000-0000-4000-8000-000000000001\",\"s\":\"10000000-0000-4000-8000-000000000001\",\"b\":\"hi\",\"t\":1,\"n\":1}}}\r\n\r\n" +
    "event: patch\ndata: {\"path\":\"/c\",\"data\":{\"10000000-0000-4000-8000-000000000001\":2}}\n\n",
  );
  for (const byte of frames) parser.push(new Uint8Array([byte]));
  assert.deepEqual(events.map((event) => event.name), ["put", "patch"]);
  assert.equal(events[0].data.path, "/");
  assert.equal(events[0].data.data.e.n, 1);
  assert.equal(events[1].data.path, "/c");
});

test("Windows 307 fixture only forwards auth to an HTTPS Firebase host", () => {
  const original = `${contract.databaseURL}/v2/l/${room}.json?auth=secret`;
  assert.equal(
    firebaseRedirect(`https://s-1.firebaseio.com/v2/l/${room}.json?auth=secret`, original).hostname,
    "s-1.firebaseio.com",
  );
  for (const destination of [
    "https://firebaseio.com.evil.test/v2/l.json?auth=secret",
    "http://s-1.firebaseio.com/v2/l.json?auth=secret",
    "https://evil.test/v2/l.json?auth=secret",
    "https://user@s-1.firebaseio.com/v2/l.json?auth=secret",
  ]) assert.throws(() => firebaseRedirect(destination, original));
});
