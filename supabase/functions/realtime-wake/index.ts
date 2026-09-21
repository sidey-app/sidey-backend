import { observedEdgeRegion } from "../_shared/realtime-region.mjs";
import { createPublishWakeHandler } from "../_shared/realtime-publish-wake.mjs";

declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };
// PostgREST verifies the JWT; runtime-managed publication has independent ownership/time limits.
Deno.serve(createPublishWakeHandler({ env: (name: string) => Deno.env.get(name),
  observe: (sample: Record<string, string | number | boolean>) => console.info(JSON.stringify({ origin: "wake", ...sample, ...observedEdgeRegion((name: string) => Deno.env.get(name)) })),
  defer: (work: Promise<unknown>) => EdgeRuntime.waitUntil(work) }));
