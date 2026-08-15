-- Run automatically on server startup (db.js calls this idempotently), but you can also
-- run it by hand: psql "$DATABASE_URL" -f schema.sql

CREATE TABLE IF NOT EXISTS user_states (
  telegram_id   BIGINT PRIMARY KEY,
  first_name    TEXT,
  username      TEXT,
  state         JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Speeds up any future "leaderboard" / admin-style queries across all users.
CREATE INDEX IF NOT EXISTS idx_user_states_updated_at ON user_states (updated_at);
