const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

test("Vercel can import the entire Express app without duplicate model registration", () => {
  const output = execFileSync(process.execPath, ["-e", "const app = require('./index'); if (typeof app !== 'function') process.exit(1); console.log('APP_IMPORT_OK');"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, NODE_ENV: "test", VERCEL: "1" },
    encoding: "utf8", timeout: 15000
  });
  assert.match(output, /APP_IMPORT_OK/);
});
