-- organizer-dashboard.html shows vote/ticket payment history for the
-- organizer's own events. The original payment_transactions policy only
-- allowed admin reads; this adds an organizer-scoped read so an organizer
-- can see payments tied to events they own.

create policy "payment_transactions_organizer_read" on payment_transactions
  for select using (
    event_id in (select id from events where organizer_id = auth.uid())
  );
