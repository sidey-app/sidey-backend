begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
begin
  if exists (select 1 from public.messages where sequence is null) then
    raise exception using errcode = 'P0001', message = 'firebase_message_backfill_incomplete';
  end if;
  if exists (
    select 1
    from public.messages as messages
    left join private.firebase_chat_sequences as sequences
      on sequences.room_id = messages.room_id
    group by messages.room_id, sequences.high_water
    having sequences.high_water is null
      or max(messages.sequence) > sequences.high_water
  ) then
    raise exception using errcode = 'P0001', message = 'firebase_message_high_water_invalid';
  end if;
end;
$$;

-- The prior phase committed all heap validation before this transaction. The
-- validated explicit not-null proof lets SET NOT NULL use only a brief metadata
-- lock; body validation is likewise already complete.
alter table public.messages
  alter column sequence set not null,
  drop constraint messages_body_length,
  drop constraint messages_sequence_not_null;

drop function private.backfill_firebase_message_sequences(integer);
drop table private.firebase_message_backfill_rooms;

commit;
