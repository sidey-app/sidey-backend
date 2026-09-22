// This transport deliberately does not import commerce handlers or mutate their lifecycle.
function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error("realtime_configuration_missing");
  return value;
}
function baseURL(): string { return required("SUPABASE_URL").replace(/\/$/, ""); }
function publicKey(): string {
  return Deno.env.get("SUPABASE_ANON_KEY")?.trim() || required("SIDEY_SUPABASE_PUBLISHABLE_KEY");
}
export async function authenticatedUser(authorization: string | null): Promise<{id: string}> {
  if (!authorization?.startsWith("Bearer ")) throw new Error("authentication_required");
  const response = await fetch(`${baseURL()}/auth/v1/user`, {
    headers: {authorization, apikey: publicKey()}, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("authentication_required");
  const user = await response.json();
  if (typeof user?.id !== "string") throw new Error("authentication_required");
  return {id: user.id};
}
async function rpc<T>(name: string, body: Record<string, unknown>, authorization: string, apikey: string): Promise<T> {
  if (!/^[a-z_]+$/.test(name)) throw new Error("invalid_rpc");
  const response = await fetch(`${baseURL()}/rest/v1/rpc/${name}`, {
    method: "POST", headers: {authorization,apikey,"content-type":"application/json"},
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("realtime_rpc_failed");
  // PostgreSQL void RPCs return JSON null. All provider error bodies stay private.
  return await response.json() as T;
}
export function userRPC<T>(name: string, body: Record<string,unknown>, authorization: string): Promise<T> {
  return rpc<T>(name,body,authorization,publicKey());
}
export function serviceRPC<T>(name: string, body: Record<string,unknown>): Promise<T> {
  const key = required("SUPABASE_SERVICE_ROLE_KEY");
  return rpc<T>(name,body,`Bearer ${key}`,key);
}
