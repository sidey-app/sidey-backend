begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Service-role-only exact read-back for bounded deployment/smoke cleanup.
-- It exposes no customer payload and performs no mutation. A caller may remove
-- test-owned durable RTDB fences only after every source delivery is settled.
create function public.firebase_delivery_status(
  p_user_ids uuid[],
  p_room_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  expected_users integer;
  settled_users integer;
  access_pending integer;
  room_pending integer;
  chat_publish_pending integer;
  chat_cleanup_pending integer;
begin
  expected_users := cardinality(p_user_ids);
  if p_room_id is null or expected_users is null or expected_users < 1 or expected_users > 10
      or array_position(p_user_ids, null) is not null
      or (select count(distinct user_id) from unnest(p_user_ids) as users(user_id)) <> expected_users then
    raise exception 'invalid_delivery_status_scope';
  end if;

  select count(*)::integer
  into settled_users
  from private.firebase_access_outbox as access_outbox
  where access_outbox.user_id = any(p_user_ids)
    and access_outbox.pending_since is null
    and not access_outbox.reconcile_requested
    and access_outbox.delivered_revision = access_outbox.revision
    and access_outbox.delivered_at is not null;

  select count(*)::integer
  into access_pending
  from private.firebase_access_outbox as access_outbox
  where access_outbox.user_id = any(p_user_ids)
    and (access_outbox.pending_since is not null
      or access_outbox.reconcile_requested
      or access_outbox.delivered_revision <> access_outbox.revision
      or access_outbox.delivered_at is null);

  select count(*)::integer
  into room_pending
  from private.firebase_room_revision_outbox as room_outbox
  where room_outbox.room_id = p_room_id
    and (room_outbox.deleted_at is null
      or room_outbox.pending_since is not null
      or room_outbox.delivered_revision <> room_outbox.revision
      or room_outbox.delivered_at is null
      or room_outbox.claimed_by is not null
      or room_outbox.claim_until is not null);

  select count(*)::integer
  into chat_publish_pending
  from private.firebase_chat_publish_outbox as publish_outbox
  where publish_outbox.room_id = p_room_id
    and publish_outbox.delivered_at is null;

  select count(*)::integer
  into chat_cleanup_pending
  from private.firebase_chat_cleanup_outbox as cleanup_outbox
  where cleanup_outbox.room_id = p_room_id
    and cleanup_outbox.delivered_at is null;

  return jsonb_build_object(
    'ready', access_pending = 0 and room_pending = 0
      and chat_publish_pending = 0 and chat_cleanup_pending = 0,
    'expected_users', expected_users,
    'settled_users', settled_users,
    'access_pending', access_pending,
    'room_pending', room_pending,
    'chat_publish_pending', chat_publish_pending,
    'chat_cleanup_pending', chat_cleanup_pending
  );
end;
$$;

revoke all on function public.firebase_delivery_status(uuid[], uuid)
  from public, anon, authenticated;
grant execute on function public.firebase_delivery_status(uuid[], uuid)
  to service_role;

-- Remove only fully delivered queue tombstones for source objects that no
-- longer exist. This prevents daily reconciliation from recreating test-owned
-- RTDB mirrors after the smoke has reported zero residuals.
create function public.firebase_finalize_deleted_delivery(
  p_user_ids uuid[],
  p_room_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery jsonb;
begin
  -- Reuse the strict scope validation before acquiring exact row locks.
  delivery := public.firebase_delivery_status(p_user_ids, p_room_id);

  perform 1 from private.firebase_access_outbox
  where user_id = any(p_user_ids) for update;
  perform 1 from private.firebase_room_revision_outbox
  where room_id = p_room_id for update;
  perform 1 from private.firebase_chat_publish_outbox
  where room_id = p_room_id for update;
  perform 1 from private.firebase_chat_cleanup_outbox
  where room_id = p_room_id for update;
  perform 1 from private.firebase_chat_sequences
  where room_id = p_room_id for update;

  if exists (select 1 from auth.users where id = any(p_user_ids))
      or exists (select 1 from public.profiles where id = any(p_user_ids))
      or exists (select 1 from public.rooms where id = p_room_id)
      or exists (select 1 from public.room_members
        where room_id = p_room_id or user_id = any(p_user_ids))
      or exists (select 1 from public.commerce_entitlements
        where user_id = any(p_user_ids))
      or exists (select 1 from public.messages where room_id = p_room_id) then
    raise exception 'delivery_cleanup_source_exists';
  end if;

  -- Re-read after locking so reconciliation/ACK races cannot pass a stale
  -- readiness decision.
  delivery := public.firebase_delivery_status(p_user_ids, p_room_id);
  if delivery->>'ready' <> 'true' then
    raise exception 'delivery_cleanup_pending';
  end if;

  delete from private.firebase_chat_cleanup_outbox where room_id = p_room_id;
  delete from private.firebase_chat_publish_outbox where room_id = p_room_id;
  delete from private.firebase_chat_sequences where room_id = p_room_id;
  delete from private.firebase_room_revision_outbox where room_id = p_room_id;
  delete from private.firebase_access_outbox where user_id = any(p_user_ids);
  return true;
end;
$$;

revoke all on function public.firebase_finalize_deleted_delivery(uuid[], uuid)
  from public, anon, authenticated;
grant execute on function public.firebase_finalize_deleted_delivery(uuid[], uuid)
  to service_role;

commit;
