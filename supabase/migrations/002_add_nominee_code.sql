-- Adds a nominee_code field to event_contestants: a short code voters will be
-- able to dial/enter during a future USSD flow to pick a nominee to vote for.
-- Run this once via the Supabase SQL editor (schema.sql/policies.sql/functions.sql
-- were already applied on a prior pass, so this is an incremental follow-up).

alter table event_contestants add column nominee_code text;
alter table event_contestants add constraint event_contestants_event_id_nominee_code_key unique (event_id, nominee_code);
