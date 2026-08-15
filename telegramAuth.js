const crypto = require("crypto");

// Validates the initData string Telegram Mini Apps send with every request, per the
// algorithm Telegram documents at https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Returns the parsed Telegram user object if valid, or null if the signature doesn't match
// (either tampered, or signed with a different bot token) or the payload has expired.
function validateInitData(initData, botToken, maxAgeSeconds) {
  maxAgeSeconds = maxAgeSeconds || 24 * 3600;
  if (!initData || !botToken) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (e) {
    return null;
  }

  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Constant-time compare to avoid a timing side-channel on the hash check.
  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null; // stale / replayed

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (e) {
    return null;
  }
  if (!user || !user.id) return null;

  return user;
}

module.exports = { validateInitData };
