-- admin.html needs payout_notes/payout_updated_at on events (payout tracking
-- tab), and deleting an event must not be blocked by its payment history —
-- the ledger tables' event_id/contestant_id FKs currently default to
-- RESTRICT, which would reject the delete. Switch them to SET NULL so
-- historical payment_transactions/pending_transactions rows survive as
-- orphaned records instead of blocking (or cascading into) the delete.

alter table events add column payout_notes text;
alter table events add column payout_updated_at timestamptz;

alter table payment_transactions drop constraint payment_transactions_event_id_fkey;
alter table payment_transactions add constraint payment_transactions_event_id_fkey
  foreign key (event_id) references events(id) on delete set null;

alter table payment_transactions drop constraint payment_transactions_contestant_id_fkey;
alter table payment_transactions add constraint payment_transactions_contestant_id_fkey
  foreign key (contestant_id) references event_contestants(id) on delete set null;

alter table pending_transactions drop constraint pending_transactions_event_id_fkey;
alter table pending_transactions add constraint pending_transactions_event_id_fkey
  foreign key (event_id) references events(id) on delete set null;

alter table pending_transactions drop constraint pending_transactions_contestant_id_fkey;
alter table pending_transactions add constraint pending_transactions_contestant_id_fkey
  foreign key (contestant_id) references event_contestants(id) on delete set null;
