begin;

-- Run only against the isolated SIDEY-staging project after every migration
-- has succeeded. Production deliberately keeps the migration default: locked.
do $$
begin
  if current_setting('app.settings.sidey_environment', true) is distinct from 'staging' then
    raise exception using
      errcode = '42501',
      message = 'SIDEY staging marker is missing';
  end if;
end;
$$;

update private.commerce_runtime_settings
set sales_enabled = true,
    payment_environment = 'test',
    updated_at = now()
where singleton is true;

commit;
