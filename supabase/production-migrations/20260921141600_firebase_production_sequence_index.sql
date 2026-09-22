-- Supabase migrations are executed without a surrounding transaction when the
-- file does not open one. Keep this statement isolated so PostgreSQL can build
-- the production index concurrently without blocking message inserts. DROP is
-- also concurrent and makes a create-success/history-write-failure or an
-- invalid interrupted build safely resumable under the same migration name.
set lock_timeout = '5s';
set statement_timeout = '10min';
drop index concurrently if exists public.messages_room_sequence_unique;
create unique index concurrently messages_room_sequence_unique
  on public.messages(room_id, sequence);
reset statement_timeout;
reset lock_timeout;
