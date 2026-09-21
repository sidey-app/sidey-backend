import { createDirectEventHandler } from "../_shared/realtime-direct-event.mjs";
import { createRealtimeEventRouter } from "../_shared/realtime-event-router.mjs";
import { createPublishWakeHandler } from "../_shared/realtime-publish-wake.mjs";
import { observedEdgeRegion } from "../_shared/realtime-region.mjs";

declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };
// The forwarded Supabase JWT is verified by PostgREST; no redundant /auth/v1/user request.
// Both handlers are created once per isolate, retaining their independent caches.
const env = (name: string) => Deno.env.get(name);
const direct = createDirectEventHandler({ env });
const wake = createPublishWakeHandler({ env,
  observe: (sample: Record<string, string | number | boolean>) => console.info(JSON.stringify({ origin: "wake", ...sample, ...observedEdgeRegion(env) })),
  defer: (work: Promise<unknown>) => EdgeRuntime.waitUntil(work) });
Deno.serve(createRealtimeEventRouter({ direct, wake }));
