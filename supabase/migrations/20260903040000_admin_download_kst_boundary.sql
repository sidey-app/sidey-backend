begin;

-- Correct the Seoul-day boundary while preserving the first-observation
-- baseline rule. A timestamp without time zone must be converted with AT TIME
-- ZONE so KST midnight resolves to 15:00 UTC on the previous calendar day.

create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  kst_today_start timestamptz := (timezone('Asia/Seoul', now())::date::timestamp at time zone 'Asia/Seoul');
  result jsonb;
begin
  perform private.require_admin_service_role();

  with download_counters as (
    select channel,
           collected_at,
           download_count,
           lag(download_count) over (
             partition by asset_id order by collected_at
           ) as previous_download_count
    from private.download_metric_snapshots
  ), download_deltas as (
    select channel,
           collected_at,
           download_count - coalesce(previous_download_count, 0) as total_delta,
           case
             when previous_download_count is null then 0
             else download_count - previous_download_count
           end as period_delta
    from download_counters
  ), download_totals as (
    select coalesce(sum(total_delta), 0)::bigint as total,
           coalesce(sum(period_delta) filter (where collected_at >= kst_today_start), 0)::bigint as today
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

create or replace function public.admin_downloads(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  kst_today date := timezone('Asia/Seoul', now())::date;
  kst_today_start timestamptz := (timezone('Asia/Seoul', now())::date::timestamp at time zone 'Asia/Seoul');
  result jsonb;
begin
  perform private.require_admin_service_role();
  if p_days not between 1 and 365 then
    raise exception using errcode = '22023', message = 'invalid_admin_download_days';
  end if;

  with counters as (
    select asset_id,
           asset_name,
           release_tag,
           version,
           channel,
           collected_at,
           download_count,
           lag(download_count) over (
             partition by asset_id order by collected_at
           ) as previous_download_count
    from private.download_metric_snapshots
  ), deltas as (
    select asset_id,
           asset_name,
           release_tag,
           version,
           channel,
           collected_at,
           download_count - coalesce(previous_download_count, 0) as total_delta,
           case
             when previous_download_count is null then 0
             else download_count - previous_download_count
           end as period_delta
    from counters
  ), channel_totals as (
    select channel,
           sum(total_delta)::bigint as total,
           coalesce(sum(period_delta) filter (where collected_at >= kst_today_start), 0)::bigint as today
    from deltas
    group by channel
  ), version_totals as (
    select asset_name,
           release_tag,
           version,
           channel,
           sum(total_delta)::bigint as total,
           max(collected_at) as collected_at
    from deltas
    group by asset_name, release_tag, version, channel
  ), dates as (
    select generate_series(kst_today - (p_days - 1), kst_today, interval '1 day')::date as day
  ), daily as (
    select dates.day,
           channels.channel,
           coalesce(sum(deltas.period_delta) filter (
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
