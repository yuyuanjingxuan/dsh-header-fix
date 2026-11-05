#!/usr/bin/env node
/**
 * Removes stale dsh-auth-* cookies without touching any application file.
 *
 * This is the conservative option. It brings the Cookie request header back
 * under Node's 16 KiB limit, but the problem returns after roughly 70 more
 * launches because a new cookie is issued every time. Use fix.bat to fix it
 * for good.
 *
 * Usage:
 *   node clean-cookies.mjs             clean
 *   node clean-cookies.mjs --dry-run   report only
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const COOKIE_PREFIX = "dsh-auth-";
const COOKIE_HOST = "127.0.0.1";
const dryRun = process.argv.includes("--dry-run");

function cookieDbPath() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is not set");
  return join(appData, "@deepseek-ai", "dsh-desktop", "Network", "Cookies");
}

async function main() {
  const dbPath = cookieDbPath();
  if (!existsSync(dbPath)) {
    console.error(`cookie database not found:\n  ${dbPath}`);
    console.error("DeepSeek Harness needs to have run at least once.");
    process.exitCode = 1;
    return;
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    console.error("this Node build has no node:sqlite; Node.js >= 22.5 is required");
    console.error("tip: run this with the node.exe bundled with DeepSeek Harness");
    process.exitCode = 1;
    return;
  }

  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    console.error(`cannot open the cookie database: ${err.message}`);
    console.error("");
    console.error("Most likely DeepSeek Harness is still running and holds the file.");
    console.error("Quit it from the tray icon, or end DeepSeek Harness.exe in Task Manager.");
    process.exitCode = 1;
    return;
  }

  try {
    const where = `host_key='${COOKIE_HOST}' AND name LIKE '${COOKIE_PREFIX}%'`;
    const total = db.prepare("SELECT COUNT(*) AS n FROM cookies").get().n;
    const stale = db.prepare(`SELECT COUNT(*) AS n FROM cookies WHERE ${where}`).get().n;

    console.log(`database  : ${dbPath}`);
    console.log(`cookies   : ${total} total`);
    console.log(`stale     : ${stale} ${COOKIE_PREFIX}* on ${COOKIE_HOST}`);

    if (stale === 0) {
      console.log("");
      console.log("Nothing to clean.");
      return;
    }

    if (dryRun) {
      console.log("");
      console.log("--dry-run, nothing changed.");
      return;
    }

    db.exec(`DELETE FROM cookies WHERE ${where}`);
    db.exec("VACUUM");

    const left = db.prepare(`SELECT COUNT(*) AS n FROM cookies WHERE ${where}`).get().n;
    console.log("");
    console.log(`removed ${stale}, ${left} left.`);
    console.log("DeepSeek Harness should start normally now.");
    console.log("");
    console.log("This is temporary. It comes back after about 70 launches.");
    console.log("Run fix.bat to patch app.asar and stop it from recurring.");
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("failed: " + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
