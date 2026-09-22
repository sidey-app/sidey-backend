import { json } from './realtime.mjs';

// Supabase's runtime path includes the function name. The external prefix is
// also explicit for local invocation/test adapters. No suffix or decoded route.
const directPaths = new Set(['/realtime-event', '/functions/v1/realtime-event']);
const wakePaths = new Set(['/realtime-event/wake', '/functions/v1/realtime-event/wake']);
export function createRealtimeEventRouter({ direct, wake }) {
  return request => {
    const path = new URL(request.url).pathname;
    if (directPaths.has(path)) return direct(request);
    if (wakePaths.has(path)) return wake(request);
    return json({ error: 'not_found' }, 404);
  };
}
