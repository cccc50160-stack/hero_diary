// Standalone test for telegramAuth.js — uses only Node built-ins (no npm deps needed),
// so it runs even in environments without registry access. Simulates the exact
// Telegram-side signing algorithm to build valid initData, then checks validateInitData().
const crypto = require("crypto");
const { validateInitData } = require("./telegramAuth");

const BOT_TOKEN = "123456789:TEST_TOKEN_FOR_LOCAL_VALIDATION_ONLY";

function signInitData(params, botToken) {
  const pairs = Object.keys(params).sort().map(k => `${k}=${params[k]}`);
  const dataCheckString = pairs.join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name); }
}

// 1. Valid, freshly-signed initData should validate and return the user.
const now = Math.floor(Date.now() / 1000);
const validParams = {
  auth_date: String(now),
  query_id: "AAExample",
  user: JSON.stringify({ id: 42, first_name: "Степа", username: "stepa_test" })
};
const validInitData = signInitData(validParams, BOT_TOKEN);
const user = validateInitData(validInitData, BOT_TOKEN);
check("valid signature accepted", user && user.id === 42 && user.first_name === "Степа");

// 2. Tampered payload (user id changed after signing) must be rejected.
const tamperedInitData = validInitData.replace("%22id%22%3A42", "%22id%22%3A999");
check("tampered payload rejected", validateInitData(tamperedInitData, BOT_TOKEN) === null);

// 3. Wrong bot token (e.g. someone else's bot, or a typo) must be rejected.
check("wrong bot token rejected", validateInitData(validInitData, "999:WRONG_TOKEN") === null);

// 4. Missing hash entirely must be rejected, not crash.
const noHash = new URLSearchParams(validParams).toString();
check("missing hash rejected", validateInitData(noHash, BOT_TOKEN) === null);

// 5. Expired auth_date (25 hours old) must be rejected — replay protection.
const staleParams = { ...validParams, auth_date: String(now - 25 * 3600) };
const staleInitData = signInitData(staleParams, BOT_TOKEN);
check("stale auth_date rejected", validateInitData(staleInitData, BOT_TOKEN) === null);

// 6. Empty / garbage input must not throw.
let threw = false;
try { validateInitData("", BOT_TOKEN); validateInitData("not=validAtAll", BOT_TOKEN); }
catch (e) { threw = true; }
check("garbage input does not throw", !threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
