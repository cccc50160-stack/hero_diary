const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most managed Postgres providers (Neon, Supabase, Render) require TLS but use a
  // certificate that isn't in Node's default trust store — this is the standard escape
  // hatch for that case. If you run your own Postgres with a real cert, you can drop this.
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
}

async function getState(telegramId) {
  const { rows } = await pool.query(
    "SELECT state FROM user_states WHERE telegram_id = $1",
    [telegramId]
  );
  return rows.length ? rows[0].state : null;
}

async function saveState(telegramId, state, meta) {
  meta = meta || {};
  await pool.query(
    `INSERT INTO user_states (telegram_id, first_name, username, state, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (telegram_id)
     DO UPDATE SET state = EXCLUDED.state,
                   first_name = COALESCE(EXCLUDED.first_name, user_states.first_name),
                   username = COALESCE(EXCLUDED.username, user_states.username),
                   updated_at = now()`,
    [telegramId, meta.firstName || null, meta.username || null, JSON.stringify(state)]
  );
}

module.exports = { pool, initSchema, getState, saveState };
