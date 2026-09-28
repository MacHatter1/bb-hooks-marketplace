-- Daily install counts per template and version. Apply with:
--   npx wrangler d1 execute bb-hooks-stats --remote --file schema.sql
CREATE TABLE IF NOT EXISTS installs (
  catalog TEXT NOT NULL,
  template TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (catalog, template, version, day)
);

-- Salted hashes, so one network address counts each template once a day and
-- at most DAILY_LIMIT templates a day. `client` is a salted hash of the
-- address (IPv6 per /64) and the day. No address is stored; the daily cron
-- deletes rows older than a day.
CREATE TABLE IF NOT EXISTS seen (
  key TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_day ON seen (day);
CREATE INDEX IF NOT EXISTS seen_client ON seen (client, day);
