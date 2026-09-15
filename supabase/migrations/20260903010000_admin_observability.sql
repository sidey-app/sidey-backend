begin;

-- Read-only operational data for the local SIDEY admin. These functions are
-- exposed through PostgREST only to the service role and never return message
-- bodies, invite material, checkout tokens, or provider secret identifiers.

create table private.download_metric_snapshots (
  id bigint generated always as identity primary key,
  asset_id bigint not null,
  asset_name text not null,
  release_tag text not null,
  version text not null,
  channel text not null,
  download_count bigint not null,
  collected_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint download_metric_asset_name_length check (char_length(asset_name) between 1 and 255),
  constraint download_metric_release_tag_length check (char_length(release_tag) between 1 and 100),
  constraint download_metric_version_length check (char_length(version) between 1 and 80),
  constraint download_metric_channel check (
    channel in ('direct_dmg', 'homebrew_dmg', 'windows_msi', 'legacy_unclassified')
  ),
  constraint download_metric_count_nonnegative check (download_count >= 0),
  unique (asset_id, collected_at)
);

create index download_metric_snapshots_asset_time_idx
on private.download_metric_snapshots (asset_id, collected_at desc);

create index download_metric_snapshots_channel_time_idx
on private.download_metric_snapshots (channel, collected_at desc);

revoke all on private.download_metric_snapshots from public, anon, authenticated;

create or replace function private.require_admin_service_role()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') != 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
end;
$$;

revoke all on function private.require_admin_service_role() from public, anon, authenticated;
grant execute on function private.require_admin_service_role() to service_role;

create or replace function public.admin_ingest_download_metrics(
  p_collected_at timestamptz,
  p_snapshots jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  perform private.require_admin_service_role();

  if p_collected_at > now() + interval '5 minutes'
     or p_collected_at < now() - interval '24 hours'
     or jsonb_typeof(p_snapshots) != 'array'
     or jsonb_array_length(p_snapshots) = 0
     or jsonb_array_length(p_snapshots) > 200 then
    raise exception using errcode = '22023', message = 'invalid_download_snapshot_batch';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_snapshots) as item(
      asset_id bigint,
      asset_name text,
      release_tag text,
      version text,
      channel text,
      download_count bigint
    )
    where item.asset_id is null
       or char_length(coalesce(item.asset_name, '')) not between 1 and 255
       or char_length(coalesce(item.release_tag, '')) not between 1 and 100
       or char_length(coalesce(item.version, '')) not between 1 and 80
       or item.channel not in ('direct_dmg', 'homebrew_dmg', 'windows_msi', 'legacy_unclassified')
       or item.download_count < 0
  ) then
    raise exception using errcode = '22023', message = 'invalid_download_snapshot';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_snapshots) as item(asset_id bigint, download_count bigint)
    join lateral (
      select snapshots.download_count
      from private.download_metric_snapshots snapshots
      where snapshots.asset_id = item.asset_id
      order by snapshots.collected_at desc
      limit 1
    ) previous on true
    where item.download_count < previous.download_count
  ) then
    raise exception using errcode = '22023', message = 'download_counter_regressed';
  end if;

  insert into private.download_metric_snapshots (
    asset_id, asset_name, release_tag, version, channel, download_count, collected_at
  )
  select item.asset_id,
         item.asset_name,
         item.release_tag,
         item.version,
         item.channel,
         item.download_count,
         p_collected_at
  from jsonb_to_recordset(p_snapshots) as item(
    asset_id bigint,
    asset_name text,
    release_tag text,
    version text,
    channel text,
    download_count bigint
  )
  on conflict (asset_id, collected_at) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.admin_ingest_download_metrics(timestamptz, jsonb)
from public, anon, authenticated;
grant execute on function public.admin_ingest_download_metrics(timestamptz, jsonb)
to service_role;

create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  kst_today_start timestamptz := timezone('Asia/Seoul', timezone('Asia/Seoul', now())::date);
  result jsonb;
begin
  perform private.require_admin_service_role();

  with download_deltas as (
    select channel,
           collected_at,
           download_count - lag(download_count, 1, 0) over (
             partition by asset_id order by collected_at
           ) as delta
    from private.download_metric_snapshots
  ), download_totals as (
    select coalesce(sum(delta), 0)::bigint as total,
           coalesce(sum(delta) filter (where collected_at >= kst_today_start), 0)::bigint as today
    from download_deltas
  ), payment_totals as (
    select coalesce(sum(amount_krw) filter (where approved_at is not null), 0)::bigint as approved,
           coalesce(sum(amount_krw) filter (where refunded_at is not null), 0)::bigint as refunded
    from public.commerce_orders
  )
  select jsonb_build_object(
    'authUsers', (select count(*) from auth.users),
    'profileUsers', (select count(*) from public.profiles),
    'anonymousUsers', (select count(*) from auth.users where coalesce(is_anonymous, false)),
    'permanentUsers', (select count(*) from auth.users where not coalesce(is_anonymous, false)),
    'rooms', (select count(*) from public.rooms),
    'memberships', (select count(*) from public.room_members),
    'joinedToday', (select count(*) from auth.users where created_at >= kst_today_start),
    'approvedRevenueKrw', payment_totals.approved,
    'refundedRevenueKrw', payment_totals.refunded,
    'netRevenueKrw', payment_totals.approved - payment_totals.refunded,
    'downloadsToday', download_totals.today,
    'downloadsTotal', download_totals.total,
    'generatedAt', now()
  ) into result
  from download_totals cross join payment_totals;

  return result;
end;
$$;

revoke all on function public.admin_overview() from public, anon, authenticated;
grant execute on function public.admin_overview() to service_role;

create or replace function public.admin_rooms(
  p_search text default '',
  p_sort text default 'created_at',
  p_direction text default 'desc',
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform private.require_admin_service_role();
  if p_sort not in ('name', 'created_at', 'member_count', 'last_message_at', 'messages_7d')
     or p_direction not in ('asc', 'desc')
     or p_page < 1 or p_page_size not between 1 and 100
     or char_length(p_search) > 100 then
    raise exception using errcode = '22023', message = 'invalid_admin_rooms_query';
  end if;

  with member_counts as (
    select room_id, count(*)::integer as member_count
    from public.room_members
    group by room_id
  ), message_counts as (
    select room_id,
           max(created_at) as last_message_at,
           count(*) filter (where created_at >= now() - interval '7 days')::integer as messages_7d
    from public.messages
    group by room_id
  ), room_rows as (
    select rooms.id,
           rooms.name,
           rooms.owner_id,
           owner_profile.nickname as owner_nickname,
           owner_user.email as owner_email,
           rooms.created_at,
           coalesce(member_counts.member_count, 0) as member_count,
           message_counts.last_message_at,
           coalesce(message_counts.messages_7d, 0) as messages_7d
    from public.rooms rooms
    left join public.profiles owner_profile on owner_profile.id = rooms.owner_id
    left join auth.users owner_user on owner_user.id = rooms.owner_id
    left join member_counts on member_counts.room_id = rooms.id
    left join message_counts on message_counts.room_id = rooms.id
    where p_search = ''
       or rooms.name ilike '%' || p_search || '%'
       or rooms.id::text ilike '%' || p_search || '%'
       or coalesce(owner_profile.nickname, '') ilike '%' || p_search || '%'
       or coalesce(owner_user.email, '') ilike '%' || p_search || '%'
  ), counted as (
    select room_rows.*, count(*) over()::integer as total_count
    from room_rows
  ), paged as (
    select * from counted
    order by
      case when p_sort = 'name' and p_direction = 'asc' then name end asc,
      case when p_sort = 'name' and p_direction = 'desc' then name end desc,
      case when p_sort = 'created_at' and p_direction = 'asc' then created_at end asc,
      case when p_sort = 'created_at' and p_direction = 'desc' then created_at end desc,
      case when p_sort = 'member_count' and p_direction = 'asc' then member_count end asc,
      case when p_sort = 'member_count' and p_direction = 'desc' then member_count end desc,
      case when p_sort = 'last_message_at' and p_direction = 'asc' then last_message_at end asc nulls last,
      case when p_sort = 'last_message_at' and p_direction = 'desc' then last_message_at end desc nulls last,
      case when p_sort = 'messages_7d' and p_direction = 'asc' then messages_7d end asc,
      case when p_sort = 'messages_7d' and p_direction = 'desc' then messages_7d end desc,
      id asc
    limit p_page_size offset ((p_page - 1) * p_page_size)
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'name', name,
      'ownerId', owner_id,
      'ownerNickname', owner_nickname,
      'ownerEmail', owner_email,
      'memberCount', member_count,
      'createdAt', created_at,
      'lastMessageAt', last_message_at,
      'messages7d', messages_7d
    )), '[]'::jsonb),
    'page', p_page,
    'pageSize', p_page_size,
    'total', coalesce(max(total_count), 0)
  ) into result
  from paged;

  return result;
end;
$$;

revoke all on function public.admin_rooms(text, text, text, integer, integer)
from public, anon, authenticated;
grant execute on function public.admin_rooms(text, text, text, integer, integer)
to service_role;

create or replace function public.admin_room_members(p_room_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform private.require_admin_service_role();
  if not exists (select 1 from public.rooms where id = p_room_id) then
    raise exception using errcode = 'P0002', message = 'room_not_found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', members.user_id,
    'nickname', profiles.nickname,
    'email', users.email,
    'characterId', profiles.character_id,
    'joinedAt', members.joined_at,
    'isOwner', rooms.owner_id = members.user_id
  ) order by rooms.owner_id = members.user_id desc, members.joined_at), '[]'::jsonb)
  into result
  from public.room_members members
  join public.rooms rooms on rooms.id = members.room_id
  left join public.profiles profiles on profiles.id = members.user_id
  join auth.users users on users.id = members.user_id
  where members.room_id = p_room_id;

  return result;
end;
$$;

revoke all on function public.admin_room_members(uuid) from public, anon, authenticated;
grant execute on function public.admin_room_members(uuid) to service_role;

create or replace function public.admin_users(
  p_search text default '',
  p_kind text default 'all',
  p_profile text default 'all',
  p_sort text default 'created_at',
  p_direction text default 'desc',
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform private.require_admin_service_role();
  if p_kind not in ('all', 'anonymous', 'google', 'permanent')
     or p_profile not in ('all', 'complete', 'incomplete')
     or p_sort not in ('created_at', 'email', 'nickname', 'room_count', 'last_sign_in_at')
     or p_direction not in ('asc', 'desc')
     or p_page < 1 or p_page_size not between 1 and 100
     or char_length(p_search) > 100 then
    raise exception using errcode = '22023', message = 'invalid_admin_users_query';
  end if;

  with user_rows as (
    select users.id,
           users.email,
           users.created_at,
           users.last_sign_in_at,
           profiles.nickname,
           profiles.character_id,
           profiles.id is not null as profile_complete,
           coalesce(users.is_anonymous, false) as is_anonymous,
           exists (
             select 1 from auth.identities identities
             where identities.user_id = users.id and identities.provider = 'google'
           ) as has_google,
           count(distinct members.room_id)::integer as room_count
    from auth.users users
    left join public.profiles profiles on profiles.id = users.id
    left join public.room_members members on members.user_id = users.id
    where (p_search = ''
       or users.id::text ilike '%' || p_search || '%'
       or coalesce(users.email, '') ilike '%' || p_search || '%'
       or coalesce(profiles.nickname, '') ilike '%' || p_search || '%')
      and (p_profile = 'all'
       or (p_profile = 'complete' and profiles.id is not null)
       or (p_profile = 'incomplete' and profiles.id is null))
      and (p_kind = 'all'
       or (p_kind = 'anonymous' and coalesce(users.is_anonymous, false))
       or (p_kind = 'google' and exists (
         select 1 from auth.identities identities
         where identities.user_id = users.id and identities.provider = 'google'
       ))
       or (p_kind = 'permanent' and not coalesce(users.is_anonymous, false)))
    group by users.id, profiles.id
  ), counted as (
    select user_rows.*, count(*) over()::integer as total_count
    from user_rows
  ), paged as (
    select * from counted
    order by
      case when p_sort = 'created_at' and p_direction = 'asc' then created_at end asc,
      case when p_sort = 'created_at' and p_direction = 'desc' then created_at end desc,
      case when p_sort = 'email' and p_direction = 'asc' then email end asc nulls last,
      case when p_sort = 'email' and p_direction = 'desc' then email end desc nulls last,
      case when p_sort = 'nickname' and p_direction = 'asc' then nickname end asc nulls last,
      case when p_sort = 'nickname' and p_direction = 'desc' then nickname end desc nulls last,
      case when p_sort = 'room_count' and p_direction = 'asc' then room_count end asc,
      case when p_sort = 'room_count' and p_direction = 'desc' then room_count end desc,
      case when p_sort = 'last_sign_in_at' and p_direction = 'asc' then last_sign_in_at end asc nulls last,
      case when p_sort = 'last_sign_in_at' and p_direction = 'desc' then last_sign_in_at end desc nulls last,
      id asc
    limit p_page_size offset ((p_page - 1) * p_page_size)
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'email', email,
      'createdAt', created_at,
      'lastSignInAt', last_sign_in_at,
      'nickname', nickname,
      'characterId', character_id,
      'profileComplete', profile_complete,
      'accountKind', case when has_google then 'google' when is_anonymous then 'anonymous' else 'permanent' end,
      'roomCount', room_count
    )), '[]'::jsonb),
    'page', p_page,
    'pageSize', p_page_size,
    'total', coalesce(max(total_count), 0)
  ) into result
  from paged;

  return result;
end;
$$;

revoke all on function public.admin_users(text, text, text, text, text, integer, integer)
from public, anon, authenticated;
grant execute on function public.admin_users(text, text, text, text, text, integer, integer)
to service_role;

create or replace function public.admin_payments(
  p_search text default '',
  p_status text default 'all',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_sort text default 'created_at',
  p_direction text default 'desc',
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform private.require_admin_service_role();
  if p_status not in ('all', 'pending', 'approved', 'failed', 'canceled', 'refunded')
     or p_sort not in ('created_at', 'amount_krw', 'approved_at', 'refunded_at', 'last_verified_at')
     or p_direction not in ('asc', 'desc')
     or p_page < 1 or p_page_size not between 1 and 100
     or char_length(p_search) > 100
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception using errcode = '22023', message = 'invalid_admin_payments_query';
  end if;

  with payment_rows as (
    select orders.id,
           orders.user_id,
           users.email,
           profiles.nickname,
           products.display_name as product_name,
           orders.amount_krw,
           orders.currency,
           coalesce(payments.provider, 'unknown') as provider,
           orders.status as order_status,
           payments.provider_status,
           orders.created_at,
           orders.approved_at,
           orders.refunded_at,
           payments.last_verified_at
    from public.commerce_orders orders
    join auth.users users on users.id = orders.user_id
    left join public.profiles profiles on profiles.id = orders.user_id
    join public.commerce_products products on products.id = orders.product_id
    left join private.commerce_payments payments on payments.order_id = orders.id
    where (p_search = ''
       or orders.id::text ilike '%' || p_search || '%'
       or coalesce(users.email, '') ilike '%' || p_search || '%'
       or coalesce(profiles.nickname, '') ilike '%' || p_search || '%'
       or products.display_name ilike '%' || p_search || '%')
      and (p_status = 'all' or orders.status = p_status)
      and (p_from is null or orders.created_at >= p_from)
      and (p_to is null or orders.created_at < p_to)
  ), totals as (
    select coalesce(sum(amount_krw) filter (where approved_at is not null), 0)::bigint as approved,
           coalesce(sum(amount_krw) filter (where refunded_at is not null), 0)::bigint as refunded,
           count(*)::integer as total_count
    from payment_rows
  ), paged as (
    select * from payment_rows
    order by
      case when p_sort = 'created_at' and p_direction = 'asc' then created_at end asc,
      case when p_sort = 'created_at' and p_direction = 'desc' then created_at end desc,
      case when p_sort = 'amount_krw' and p_direction = 'asc' then amount_krw end asc,
      case when p_sort = 'amount_krw' and p_direction = 'desc' then amount_krw end desc,
      case when p_sort = 'approved_at' and p_direction = 'asc' then approved_at end asc nulls last,
      case when p_sort = 'approved_at' and p_direction = 'desc' then approved_at end desc nulls last,
      case when p_sort = 'refunded_at' and p_direction = 'asc' then refunded_at end asc nulls last,
      case when p_sort = 'refunded_at' and p_direction = 'desc' then refunded_at end desc nulls last,
      case when p_sort = 'last_verified_at' and p_direction = 'asc' then last_verified_at end asc nulls last,
      case when p_sort = 'last_verified_at' and p_direction = 'desc' then last_verified_at end desc nulls last,
      id asc
    limit p_page_size offset ((p_page - 1) * p_page_size)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id,
      'userId', user_id,
      'email', email,
      'nickname', nickname,
      'productName', product_name,
      'amountKrw', amount_krw,
      'currency', currency,
      'provider', provider,
      'orderStatus', order_status,
      'providerStatus', provider_status,
      'createdAt', created_at,
      'approvedAt', approved_at,
      'refundedAt', refunded_at,
      'lastVerifiedAt', last_verified_at
    )) from paged), '[]'::jsonb),
    'page', p_page,
    'pageSize', p_page_size,
    'total', totals.total_count,
    'approvedRevenueKrw', totals.approved,
    'refundedRevenueKrw', totals.refunded,
    'netRevenueKrw', totals.approved - totals.refunded
  ) into result
  from totals;

  return result;
end;
$$;

revoke all on function public.admin_payments(text, text, timestamptz, timestamptz, text, text, integer, integer)
from public, anon, authenticated;
grant execute on function public.admin_payments(text, text, timestamptz, timestamptz, text, text, integer, integer)
to service_role;

create or replace function public.admin_downloads(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  kst_today date := timezone('Asia/Seoul', now())::date;
  kst_today_start timestamptz := timezone('Asia/Seoul', timezone('Asia/Seoul', now())::date);
  result jsonb;
begin
  perform private.require_admin_service_role();
  if p_days not between 1 and 365 then
    raise exception using errcode = '22023', message = 'invalid_admin_download_days';
  end if;

  with deltas as (
    select asset_id,
           asset_name,
           release_tag,
           version,
           channel,
           collected_at,
           download_count - lag(download_count, 1, 0) over (
             partition by asset_id order by collected_at
           ) as delta
    from private.download_metric_snapshots
  ), channel_totals as (
    select channel,
           sum(delta)::bigint as total,
           coalesce(sum(delta) filter (where collected_at >= kst_today_start), 0)::bigint as today
    from deltas
    group by channel
  ), version_totals as (
    select asset_name,
           release_tag,
           version,
           channel,
           sum(delta)::bigint as total,
           max(collected_at) as collected_at
    from deltas
    group by asset_name, release_tag, version, channel
  ), dates as (
    select generate_series(kst_today - (p_days - 1), kst_today, interval '1 day')::date as day
  ), daily as (
    select dates.day,
           channels.channel,
           coalesce(sum(deltas.delta) filter (
             where timezone('Asia/Seoul', deltas.collected_at)::date = dates.day
           ), 0)::bigint as count
    from dates
    cross join (values
      ('direct_dmg'::text),
      ('homebrew_dmg'::text),
      ('windows_msi'::text),
      ('legacy_unclassified'::text)
    ) channels(channel)
    left join deltas on deltas.channel = channels.channel
    group by dates.day, channels.channel
  )
  select jsonb_build_object(
    'channels', coalesce((select jsonb_agg(jsonb_build_object(
      'channel', channel, 'today', today, 'total', total
    ) order by channel) from channel_totals), '[]'::jsonb),
    'versions', coalesce((select jsonb_agg(jsonb_build_object(
      'assetName', asset_name,
      'releaseTag', release_tag,
      'version', version,
      'channel', channel,
      'total', total
    ) order by collected_at desc) from version_totals), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'date', day,
      'channel', channel,
      'count', count
    ) order by day, channel) from daily), '[]'::jsonb),
    'lastCollectedAt', (select max(collected_at) from deltas),
    'isStale', coalesce((select max(collected_at) < now() - interval '35 minutes' from deltas), true),
    'homebrewAnalytics', jsonb_build_object(
      'available', false,
      'counts', jsonb_build_object('days30', null, 'days90', null, 'days365', null),
      'reason', '현재 sidey-app/tap은 third-party tap이라 homebrew/homebrew-cask 공식 익명 통계에 포함되지 않습니다.'
    ),
    'boundaryNote', '오늘 수치는 Asia/Seoul 자정 직전·직후 스냅샷 차이이며 최대 약 15분의 경계 오차가 있습니다.',
    'historicalNote', 'Homebrew 전용 자산 도입 전 DMG는 과거 경로 미분류로 보존됩니다.'
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_downloads(integer) from public, anon, authenticated;
grant execute on function public.admin_downloads(integer) to service_role;

commit;
