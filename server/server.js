require("./loadEnv").loadEnv();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { validateInitData } = require("./telegramAuth");
const reminders = require("./reminders");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const DEV_BYPASS = process.env.ALLOW_UNAUTHENTICATED_DEV === "true";
const CRON_SECRET = process.env.CRON_SECRET;

if (!BOT_TOKEN) {
  console.warn("WARNING: BOT_TOKEN is not set — every real Telegram request will be rejected.");
}
if (!CRON_SECRET) {
  console.warn("WARNING: CRON_SECRET is not set — /api/cron/reminders will reject every call, so no push reminders will go out.");
}

const app = express();
app.use(express.json({ limit: "512kb" })); // one user's dashboard state is a few KB; this is generous headroom

// Every /api/* route requires a valid, freshly-signed Telegram initData string, sent as
// `Authorization: tma <initData>` (the header convention Telegram's own docs recommend).
// This is what stands in for a login system — there's no password, the signature IS the auth.
function requireTelegramUser(req, res, next) {
  const header = req.get("Authorization") || "";
  const initData = header.startsWith("tma ") ? header.slice(4) : null;

  if (!initData) {
    if (DEV_BYPASS) {
      // Local-only escape hatch so you can hit the API from a plain browser while developing,
      // without a real Telegram session. ALLOW_UNAUTHENTICATED_DEV must be unset/false in prod.
      req.telegramUser = { id: 999999, first_name: "Dev", username: "dev_local" };
      return next();
    }
    return res.status(401).json({ error: "missing_init_data" });
  }

  const user = validateInitData(initData, BOT_TOKEN);
  if (!user) return res.status(401).json({ error: "invalid_init_data" });

  req.telegramUser = user;
  next();
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/state", requireTelegramUser, async (req, res) => {
  try {
    const state = await db.getState(req.telegramUser.id);
    res.json({ state }); // state is null for a brand-new user — frontend falls back to defaultState()
  } catch (err) {
    console.error("GET /api/state failed:", err);
    res.status(500).json({ error: "server_error" });
  }
});

app.put("/api/state", requireTelegramUser, async (req, res) => {
  const state = req.body && req.body.state;
  if (!state || typeof state !== "object") {
    return res.status(400).json({ error: "missing_state" });
  }
  try {
    await db.saveState(req.telegramUser.id, state, {
      firstName: req.telegramUser.first_name,
      username: req.telegramUser.username
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/state failed:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* ------------------------------- Мировой босс -------------------------------
   Общий на всех игроков: любое задание категории «боссы» бьёт не только по личному
   боссу в списке, но и по одной общей туше. Урон складывается со всеми остальными
   игроками, так что «Долгий Штиль» из личной метафоры становится ещё и чем-то, что
   валят сообща.
--------------------------------------------------------------------------- */

app.get("/api/worldboss", requireTelegramUser, async (req, res) => {
  try {
    res.json({ boss: await db.getWorldBoss() });
  } catch (err) {
    console.error("GET /api/worldboss failed:", err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/worldboss/damage", requireTelegramUser, async (req, res) => {
  const amount = req.body && Number(req.body.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: "bad_amount" });
  }
  // Клэмп симметричный, [-200..200] без нуля: положительное — урон, отрицательное —
  // возврат урона, когда игрок снял галочку с задания. Сам клэмп живёт в db.js, здесь
  // только отсечка заведомого мусора, чтобы не открывать транзакцию впустую.
  if (Math.abs(amount) > db.WORLD_BOSS_MAX_HIT * 10) {
    return res.status(400).json({ error: "bad_amount" });
  }
  try {
    const result = await db.damageWorldBoss(amount);
    if (!result) return res.status(500).json({ error: "server_error" });
    res.json({ boss: result });
  } catch (err) {
    console.error("POST /api/worldboss/damage failed:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* ----------------------------- Крон напоминаний -----------------------------
   Дёргается снаружи (cron-job.org или любой аналог) раз в час — см. DEPLOY.md.
   Намеренно НЕ под requireTelegramUser: у крона нет и не может быть Telegram-сессии,
   вместо неё — общий секрет в query. Сравнение постоянное по времени, чтобы секрет
   нельзя было подобрать по времени ответа.
--------------------------------------------------------------------------- */

function cronKeyValid(given) {
  if (!CRON_SECRET || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(CRON_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.get("/api/cron/reminders", async (req, res) => {
  if (!cronKeyValid(req.query.key)) return res.status(403).json({ error: "forbidden" });
  if (!BOT_TOKEN) return res.status(500).json({ error: "no_bot_token" });

  const today = reminders.mskDateStr();
  const force = req.query.force === "1" && DEV_BYPASS; // ручная проверка вне окна, только в деве

  if (!reminders.isWithinSendWindow() && !force) {
    return res.json({
      ok: true,
      skipped: "outside_window",
      mskHour: reminders.mskHour(),
      window: reminders.SEND_HOUR_FROM + "–" + reminders.SEND_HOUR_TO
    });
  }

  try {
    const users = await db.listUsersNeedingReminder(today, 300);
    let sent = 0, skipped = 0, failed = 0;

    for (const row of users) {
      const decision = reminders.decideReminder(row.state, today);
      if (!decision) { skipped += 1; continue; } // нечего сказать — и отметку не ставим, вечер ещё не кончился

      const result = await reminders.sendTelegramMessage(BOT_TOKEN, row.telegram_id, decision.text);
      if (result.ok || result.blocked) {
        // blocked — человек заблокировал бота: отмечаем как обработанного, чтобы не долбиться
        // в него каждый час до конца окна.
        await db.markReminderSent(row.telegram_id, today);
      }
      if (result.ok) sent += 1;
      else failed += 1;
    }

    res.json({ ok: true, date: today, candidates: users.length, sent, skipped, failed });
  } catch (err) {
    console.error("GET /api/cron/reminders failed:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// Serves the mini app itself (public/index.html + assets) from the same origin as the API,
// so there's no CORS to configure and only one URL to register with @BotFather.
app.use(express.static(path.join(__dirname, "..", "public")));

db.initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`life-rpg-miniapp server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize database schema:", err);
    process.exit(1);
  });
