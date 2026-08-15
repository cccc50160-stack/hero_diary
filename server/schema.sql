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

-- Дата (по МСК) последнего отправленного пуша — отдельная колонка, а не поле внутри `state`,
-- сознательно: `state` целиком перезаписывается клиентским PUT /api/state, и если бы отметка
-- жила там, любое сохранение из мини-аппа могло затереть её версией без отметки — и человек
-- получил бы второе напоминание за тот же вечер. Колонка снаружи JSONB от этой гонки защищена.
ALTER TABLE user_states ADD COLUMN IF NOT EXISTS last_reminder_date DATE;

-- Кому ещё не слали сегодня — основной запрос крона, поэтому индекс именно по этой колонке.
CREATE INDEX IF NOT EXISTS idx_user_states_last_reminder_date ON user_states (last_reminder_date);

-- ---------------------------------------------------------------------------
-- Мировой босс: одна строка на всю игру, общая для всех игроков.
-- CHECK (id = 1) — дешёвая страховка от появления второй «параллельной» строки:
-- любая попытка вставить другой id упадёт на уровне БД, а не тихо разъедет логику.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS world_boss (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hp            INT NOT NULL,
  max_hp        INT NOT NULL,
  defeat_count  INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Стартовые 5000 HP. ON CONFLICT DO NOTHING — чтобы перезапуск сервера (initSchema идемпотентен)
-- не сбрасывал уже идущий бой обратно на полное здоровье.
INSERT INTO world_boss (id, hp, max_hp, defeat_count)
VALUES (1, 5000, 5000, 0)
ON CONFLICT (id) DO NOTHING;
