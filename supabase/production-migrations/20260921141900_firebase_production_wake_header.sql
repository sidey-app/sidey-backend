begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';
-- Cloud Run may consume Authorization as platform identity metadata before the
-- public function handler sees it. Use a dedicated application header for the
-- optional wake signal; the durable outbox and one-minute scheduler remain the
-- source of retry truth.
create or replace function private.wake_firebase_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  wake_secret text;
begin
  if current_setting('sidey.access_reconciling', true) = 'on' then return null; end if;
  select wake_url into endpoint
  from private.firebase_access_dispatch
  where singleton;
  if endpoint is null then return null; end if;
  begin
    select decrypted_secret into wake_secret
    from vault.decrypted_secrets
    where name = 'sidey_access_wake_token';
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
    raise warning 'firebase_access_wake_failed';
  end;
  return null;
end;
$$;
revoke all on function private.wake_firebase_access()
  from public, anon, authenticated, service_role;
commit;
