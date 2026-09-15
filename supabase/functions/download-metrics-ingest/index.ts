import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

type Snapshot = {
  asset_id: number;
  asset_name: string;
  release_tag: string;
  version: string;
  channel: "direct_dmg" | "homebrew_dmg" | "windows_msi" | "legacy_unclassified";
  download_count: number;
};

type Payload = {
  collectedAt: string;
  snapshots: Snapshot[];
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function secretsMatch(received: string, expected: string): Promise<boolean> {
  const [receivedDigest, expectedDigest] = await Promise.all([
    digest(received),
    digest(expected),
  ]);
  return receivedDigest.every((byte, index) => byte === expectedDigest[index]);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });

  const expectedKey = Deno.env.get("DOWNLOAD_METRICS_INGEST_KEY") ?? "";
  const receivedKey = request.headers.get("x-sidey-ingest-key") ?? "";
  if (!expectedKey || !receivedKey || !(await secretsMatch(receivedKey, expectedKey))) {
    return json(401, { error: "unauthorized" });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 128_000) return json(413, { error: "payload_too_large" });

  let payload: Payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (
    typeof payload?.collectedAt !== "string" ||
    !Array.isArray(payload?.snapshots) ||
    payload.snapshots.length === 0 ||
    payload.snapshots.length > 200
  ) {
    return json(400, { error: "invalid_payload" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json(503, { error: "server_not_configured" });

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.rpc("admin_ingest_download_metrics", {
    p_collected_at: payload.collectedAt,
    p_snapshots: payload.snapshots,
  });

  if (error) {
    console.error("download metrics ingest failed", error.code, error.message);
    return json(502, { error: "ingest_failed" });
  }

  return json(200, { insertedCount: data });
});
