-- The preceding migration committed all ADD NOT VALID metadata locks. These
-- scans use PostgreSQL's write-compatible validation lock in their own history
-- boundary and can be retried transactionally.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

alter table public.messages
  validate constraint messages_sequence_safe_integer;
alter table public.messages
  validate constraint messages_sequence_not_null;
alter table public.messages
  validate constraint messages_body_payload;

commit;
