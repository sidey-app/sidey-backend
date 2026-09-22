begin;
set local lock_timeout = '5s';
set local statement_timeout = '1min';

-- Transient wake traffic has an independent credential so enabling this
-- bridge never requires reading or rotating the established access/chat wake
-- credential used by other production workers.
create or replace function private.wake_firebase_transient_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  wake_secret text;
begin
  select config.wake_url into endpoint
  from private.firebase_transient_bridge_config as config
  where config.singleton and config.enabled;
  if endpoint is null then return null; end if;
  begin
    select decrypted_secret into wake_secret
    from vault.decrypted_secrets
    where name = 'sidey_transient_wake_token';
    if length(wake_secret) >= 32 then
      perform net.http_post(
        url := endpoint,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Sidey-Wake-Token', wake_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 1000
      );
    end if;
  exception when others then
    raise warning 'firebase_transient_wake_failed';
  end;
  return null;
end;
$$;
revoke all on function private.wake_firebase_transient_publication()
  from public, anon, authenticated, service_role;

commit;
