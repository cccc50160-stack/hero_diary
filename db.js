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

/* ------------------------------- Мировой босс -------------------------------
   Одна строка на всех игроков. Каждый респавн — сильнее предыдущего, формула
   ниже. Единственное место, где HP меняется, — damageWorldBoss(), и оно всегда
   под транзакцией с блокировкой строки: без неё два одновременных удара читали
   бы одинаковое «до» и один из них потерялся бы.
--------------------------------------------------------------------------- */

const WORLD_BOSS_BASE_HP = 5000;
const WORLD_BOSS_HP_STEP = 1500;
const WORLD_BOSS_MAX_HIT = 200; // потолок одного запроса, симметрично в обе стороны

function worldBossMaxHpFor(defeatCount) {
  return WORLD_BOSS_BASE_HP + defeatCount * WORLD_BOSS_HP_STEP;
}

function shapeWorldBoss(row) {
  return {
    hp: row.hp,
    maxHp: row.max_hp,
    defeatCount: row.defeat_count,
    // Номер текущей волны — то, что видит игрок: первый бой это «волна 1», а не «0 побед».
    wave: row.defeat_count + 1
  };
}

async function getWorldBoss() {
  const { rows } = await pool.query(
    "SELECT hp, max_hp, defeat_count FROM world_boss WHERE id = 1"
  );
  if (!rows.length) {
    // Строки нет только если кто-то удалил её руками — восстанавливаем, а не падаем.
    await pool.query(
      "INSERT INTO world_boss (id, hp, max_hp, defeat_count) VALUES (1, $1, $1, 0) ON CONFLICT (id) DO NOTHING",
      [WORLD_BOSS_BASE_HP]
    );
    return { hp: WORLD_BOSS_BASE_HP, maxHp: WORLD_BOSS_BASE_HP, defeatCount: 0, wave: 1 };
  }
  return shapeWorldBoss(rows[0]);
}

/* amount > 0 — урон, amount < 0 — «лечение» (игрок снял галочку с задания и урон нужно
   вернуть обратно). Симметрия важна: иначе снять/поставить галочку было бы бесплатным
   способом фармить урон по общему боссу.

   Возвращает { hp, maxHp, defeatCount, wave, defeated, applied }, где applied — сколько
   урона реально прошло после клэмпа и упора в границы (0..maxHp). */
async function damageWorldBoss(amount) {
  const raw = Math.trunc(Number(amount) || 0);
  if (raw === 0) return null;
  const delta = Math.max(-WORLD_BOSS_MAX_HIT, Math.min(WORLD_BOSS_MAX_HIT, raw));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT hp, max_hp, defeat_count FROM world_boss WHERE id = 1 FOR UPDATE"
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return null;
    }

    const before = rows[0];
    let hp = before.hp - delta;
    let maxHp = before.max_hp;
    let defeatCount = before.defeat_count;
    let defeated = false;

    if (hp <= 0) {
      // Повержен: считаем победу и тут же поднимаем следующего, уже крепче.
      defeated = true;
      defeatCount += 1;
      maxHp = worldBossMaxHpFor(defeatCount);
      hp = maxHp;
    } else if (hp > maxHp) {
      // «Лечение» не может поднять HP выше максимума текущей волны — иначе отмена заданий
      // накачивала бы босса сверх его же шкалы и бар уезжал бы за 100%.
      hp = maxHp;
    }

    await client.query(
      "UPDATE world_boss SET hp = $1, max_hp = $2, defeat_count = $3, updated_at = now() WHERE id = 1",
      [hp, maxHp, defeatCount]
    );
    await client.query("COMMIT");

    return {
      hp,
      maxHp,
      defeatCount,
      wave: defeatCount + 1,
      defeated,
      applied: defeated ? before.hp : before.hp - hp
    };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (e) { /* соединение уже мертво — глотаем */ }
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------ Напоминания -------------------------------- */

// Все, кому сегодня (по МСК) ещё не слали пуш. Лимит — чтобы один тик крона не превращался
// в бесконечную рассылку, если пользователей станет много: остаток догонит следующий пинг.
async function listUsersNeedingReminder(todayMsk, limit) {
  const { rows } = await pool.query(
    `SELECT telegram_id, first_name, state
       FROM user_states
      WHERE last_reminder_date IS DISTINCT FROM $1
      ORDER BY updated_at DESC
      LIMIT $2`,
    [todayMsk, limit || 300]
  );
  return rows;
}

async function markReminderSent(telegramId, todayMsk) {
  await pool.query(
    "UPDATE user_states SET last_reminder_date = $2 WHERE telegram_id = $1",
    [telegramId, todayMsk]
  );
}

module.exports = {
  pool,
  initSchema,
  getState,
  saveState,
  getWorldBoss,
  damageWorldBoss,
  listUsersNeedingReminder,
  markReminderSent,
  WORLD_BOSS_MAX_HIT
};
