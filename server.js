require("./loadEnv").loadEnv();
const path = require("path");
const express = require("express");
const { validateInitData } = require("./telegramAuth");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const DEV_BYPASS = process.env.ALLOW_UNAUTHENTICATED_DEV === "true";

if (!BOT_TOKEN) {
  console.warn("WARNING: BOT_TOKEN is not set — every real Telegram request will be rejected.");
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
