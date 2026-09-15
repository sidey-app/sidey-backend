import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fetchAppleBackfill } from "../src/apple.js";

for (const stalledBody of [false, true]) {
  test(`backfill Apple fetch aborts a stalled ${stalledBody ? "body" : "connection"}`, async () => {
    const server = createServer((_request, response) => {
      if (stalledBody) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"signedTransactionInfo":"');
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      await assert.rejects(async () => {
        const response = await fetchAppleBackfill(`http://127.0.0.1:${address.port}`, {}, 30);
        await response.json();
      }, (error: unknown) => error instanceof Error && error.name === "AbortError");
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });
}
