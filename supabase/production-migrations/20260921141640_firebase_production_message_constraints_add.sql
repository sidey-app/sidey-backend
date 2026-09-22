begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Supabase records migration history after executing a file. If the database
-- commits but the client loses the connection before that record is written,
-- retry only an exact previously-created constraint and reject every drifted
-- same-name object.
do $$
declare
  definition text;
begin
  select pg_get_constraintdef(constraints.oid, true)
  into definition
  from pg_constraint as constraints
  where constraints.conrelid = 'public.messages'::regclass
    and constraints.conname = 'messages_sequence_safe_integer';
  if definition is null then
    alter table public.messages
      add constraint messages_sequence_safe_integer
      check (sequence between 1 and 9007199254740991) not valid;
  elsif definition <>
    'CHECK (sequence >= 1 AND sequence <= ''9007199254740991''::bigint) NOT VALID' then
    raise exception using errcode = 'P0001',
      message = 'firebase_message_sequence_constraint_drift';
  end if;

  select pg_get_constraintdef(constraints.oid, true)
  into definition
  from pg_constraint as constraints
  where constraints.conrelid = 'public.messages'::regclass
    and constraints.conname = 'messages_sequence_not_null';
  if definition is null then
    alter table public.messages
      add constraint messages_sequence_not_null
      check (sequence is not null) not valid;
  elsif definition <> 'CHECK (sequence IS NOT NULL) NOT VALID' then
    raise exception using errcode = 'P0001',
      message = 'firebase_message_not_null_constraint_drift';
  end if;

  select pg_get_constraintdef(constraints.oid, true)
  into definition
  from pg_constraint as constraints
  where constraints.conrelid = 'public.messages'::regclass
    and constraints.conname = 'messages_body_payload';
  if definition is null then
    alter table public.messages
      add constraint messages_body_payload check (
        char_length(body) >= 1 and octet_length(body) <= 16384
      ) not valid;
  elsif definition <>
    'CHECK (char_length(body) >= 1 AND octet_length(body) <= 16384) NOT VALID' then
    raise exception using errcode = 'P0001',
      message = 'firebase_message_body_constraint_drift';
  end if;
end;
$$;

commit;
