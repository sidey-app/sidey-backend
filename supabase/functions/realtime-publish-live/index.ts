import { createBackgroundPublishHandler } from "../_shared/realtime-publish-background.mjs";
import { observedEdgeRegion } from "../_shared/realtime-region.mjs";
import { createLivePublishHandler } from "../_shared/realtime-live-dispatch.mjs";

// No public/client token authorizes this staging-only scheduler endpoint.
const handler = createLivePublishHandler({ env: (name: string) => Deno.env.get(name),
  observe: (sample: Record<string, string | number | boolean>) => console.info(JSON.stringify({ origin: "scheduler", ...sample, ...observedEdgeRegion((name: string) => Deno.env.get(name)) })) });
declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };
// 202 acknowledges runtime registration, never database ownership or delivery.
Deno.serve(createBackgroundPublishHandler({ env: (name: string) => Deno.env.get(name), publish: handler,
  defer: (work: Promise<unknown>) => EdgeRuntime.waitUntil(work) }));
