const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "logs");
if (process.env.VERCEL !== "1" && !fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logFilePath = () => {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${date}.log`);
};

const writeLine = (level, message) => {
  if (process.env.VERCEL === "1") return;
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  fs.appendFile(logFilePath(), line, (err) => {
    if (err) console.error("Failed to write log file:", err.message);
  });
};

const info = (message) => {
  console.log(message);
  writeLine("INFO", message);
};

const error = (message, err) => {
  const full = err ? `${message} ${err.stack || err.message || err}` : message;
  console.error(message, err ?? "");
  writeLine("ERROR", full);
};

module.exports = { info, error };
