begin;

drop function public.firebase_access_pending(integer);

create function public.firebase_access_pending(p_limit integer default 100)
returns table(user_id uuid, revision text)
language sql stable security definer set search_path = '' as $$
  select o.user_id, lpad(o.revision::text, 20, '0')
  from private.firebase_access_outbox o
  where o.pending_since is not null or o.reconcile_requested
  order by o.pending_since nulls last, o.user_id
  limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;

revoke all on function public.firebase_access_pending(integer)
  from public, anon, authenticated;
grant execute on function public.firebase_access_pending(integer) to service_role;

commit;;
