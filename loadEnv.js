// Tiny dependency-free .env loader (avoids pulling in the `dotenv` package for something this
// small). Reads KEY=VALUE lines from .env into process.env, skipping blanks/comments, and never
// overwrites a variable the host platform (Render/Railway/Fly/...) already injected — those
// should always win over a local .env file.
const fs = require("fs");
const path = require("path");

function loadEnv(file) {
  const envPath = path.join(__dirname, file || ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

module.exports = { loadEnv };
