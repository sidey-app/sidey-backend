-- Explicit staging comparison only. NULL preserves automatic regional routing.
-- Does not enable dispatch, modify run ownership, or deploy any function.
begin;
alter table private.firebase_live_dispatch_config add column edge_region text
  constraint firebase_live_dispatch_edge_region_check
  check(edge_region is null or edge_region in ('ap-northeast-2','ap-southeast-1'));

create or replace function private.enqueue_firebase_live_dispatch(p_dispatch uuid,p_secret text)
returns bigint language sql set search_path='' as $$
 select net.http_post(
   url:='https://fjglrvhvdthntkvrduyi.supabase.co/functions/v1/realtime-publish-live',
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||p_secret)
     ||coalesce((select jsonb_build_object('x-region',c.edge_region)
       from private.firebase_live_dispatch_config c where c.id and c.edge_region is not null),'{}'::jsonb),
   body:=jsonb_build_object('dispatchId',p_dispatch),timeout_milliseconds:=25000)
$$;
revoke all on function private.enqueue_firebase_live_dispatch(uuid,text) from public,anon,authenticated;

alter function public.prepare_firebase_live_lease() set schema private;
alter function private.prepare_firebase_live_lease() rename to prepare_firebase_live_lease_before_region;
revoke all on function private.prepare_firebase_live_lease_before_region() from public,anon,authenticated,service_role;
create function public.prepare_firebase_live_lease()
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; region text;
begin
 result:=private.prepare_firebase_live_lease_before_region();
 select c.edge_region into region from private.firebase_live_dispatch_config c
   where c.id and c.enabled and c.owner_run_id is not null and c.run_deadline_at>clock_timestamp();
 if result->>'enabled'='true' and region is not null then
   if result?'directEvents' then
     result:=jsonb_set(result,'{directEvents}',result->'directEvents'||jsonb_build_object('region',region));
   end if;
   if result?'publisherWake' then
     result:=jsonb_set(result,'{publisherWake}',result->'publisherWake'||jsonb_build_object('region',region));
   end if;
 end if;
 return result;
end $$;
revoke all on function public.prepare_firebase_live_lease() from public,anon;
grant execute on function public.prepare_firebase_live_lease() to authenticated;
commit;
