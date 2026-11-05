#!/usr/bin/env node
/**
 * dsh-header-fix
 *
 * Works around a startup failure in DeepSeek Harness:
 *
 *   Error: desktop welcome: Web authentication failed
 *
 * The desktop shell spawns a local host process on 127.0.0.1:<random port> and
 * authenticates to it with a dsh-auth-* cookie. A new cookie is issued on every
 * launch because the port changes, and the old ones are never removed. After
 * roughly 70 launches the accumulated cookies push the Cookie request header
 * past Node's default http.maxHeaderSize of 16384 bytes. The host answers 431,
 * the shell treats that as an auth failure, and the app never opens.
 *
 * This script raises the host's header limit to 64 KiB and clears the stale
 * cookies. See docs/ROOT-CAUSE.md for the full write-up.
 *
 * Usage:
 *   node patch.mjs apply  "<install dir>"   patch app.asar and clean cookies
 *   node patch.mjs revert "<install dir>"   restore the original app.asar
 *   node patch.mjs check  "<install dir>"   report state, change nothing
 *   node patch.mjs verify "<install dir>"   check asar integrity
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const TARGET = "/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js";
const MARKER = "maxHeaderSize:65536";
const PATCH_RE = /createServer\(([A-Za-z_$][\w$]*)\)/g;
const REPLACE = "createServer({maxHeaderSize:65536},$1)";
const COOKIE_PREFIX = "dsh-auth-";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- asar format

// Header layout is 16 bytes: [4, headerSize, headerSize + 4, jsonLength].
// File data starts at 16 + jsonLength, not at 8 + headerSize.
function readAsar(path) {
  const buf = readFileSync(path);
  if (buf.length < 16) throw new Error("file too small to be an asar archive");
  const f0 = buf.readUInt32LE(0);
  const jsonLen = buf.readUInt32LE(12);
  if (f0 !== 4) throw new Error(`unexpected asar header (field0=${f0})`);
  if (16 + jsonLen > buf.length) throw new Error("asar header length out of range");
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString("utf8"));
  return { buf, header, dataBase: 16 + jsonLen, jsonLen };
}

function walk(node, prefix, out) {
  const files = node.files;
  if (!files) return;
  for (const name of Object.keys(files)) {
    const child = files[name];
    const p = prefix + "/" + name;
    if (child.files) walk(child, p, out);
    else out.set(p, child);
  }
}

// The header JSON must stay 4-byte aligned. Padding goes in a throwaway key.
function buildHeader(header) {
  delete header._pad;
  let js = Buffer.from(JSON.stringify(header), "utf8");
  const need = (4 - (js.length % 4)) % 4;
  if (need) {
    header._pad = "x".repeat(need);
    js = Buffer.from(JSON.stringify(header), "utf8");
  }
  return js;
}

// offset and size are sometimes strings and sometimes numbers in the header.
// Keep whatever type was there so the JSON round-trips cleanly.
const setNum = (obj, key, value) => {
  obj[key] = typeof obj[key] === "string" ? String(value) : value;
};

function verifyAsarFile(path) {
  const { buf, header, dataBase } = readAsar(path);
  const files = new Map();
  walk(header, "", files);
  let checked = 0;
  let bad = 0;
  for (const [p, e] of files) {
    if (!e.integrity || e.offset === undefined) continue;
    const off = Number(e.offset);
    const size = Number(e.size);
    const content = buf.subarray(dataBase + off, dataBase + off + size);
    checked++;
    if (sha256(content) !== e.integrity.hash) {
      bad++;
      if (bad <= 5) console.log(`  hash mismatch: ${p}`);
    }
  }
  return { checked, bad };
}

// -------------------------------------------------------------------- inspect

function isRunning() {
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/NH"],
      { encoding: "utf8", windowsHide: true }
    );
    return out.toLowerCase().includes("deepseek harness.exe");
  } catch {
    return false;
  }
}

function inspect(asarPath) {
  const { buf, header, dataBase } = readAsar(asarPath);
  const files = new Map();
  walk(header, "", files);
  const ent = files.get(TARGET);
  if (!ent) return { supported: false, reason: "dsh-host-webserver not found in asar" };
  const off = Number(ent.offset);
  const size = Number(ent.size);
  const text = buf.subarray(dataBase + off, dataBase + off + size).toString("utf8");
  const patched = text.includes(MARKER);
  const anchors = [...text.matchAll(PATCH_RE)].length;
  return { supported: patched || anchors === 1, patched, anchors, size };
}

// ---------------------------------------------------------------------- patch

function patchAsar(asarPath) {
  const { buf, header, dataBase } = readAsar(asarPath);
  const files = new Map();
  walk(header, "", files);
  const ent = files.get(TARGET);
  if (!ent) throw new Error("dsh-host-webserver not found in asar; unsupported version");

  const off = Number(ent.offset);
  const size = Number(ent.size);
  const text = buf.subarray(dataBase + off, dataBase + off + size).toString("utf8");

  if (text.includes(MARKER)) return { already: true };

  const anchors = [...text.matchAll(PATCH_RE)].length;
  if (anchors !== 1) {
    throw new Error(
      `found ${anchors} patch anchors, expected exactly 1; unsupported version`
    );
  }

  const newContent = Buffer.from(text.replace(PATCH_RE, REPLACE), "utf8");
  const delta = newContent.length - size;

  setNum(ent, "size", newContent.length);
  if (ent.integrity) {
    const bs = Number(ent.integrity.blockSize) || 4194304;
    ent.integrity.hash = sha256(newContent);
    const blocks = [];
    for (let i = 0; i < newContent.length; i += bs) {
      blocks.push(sha256(newContent.subarray(i, i + bs)));
    }
    ent.integrity.blocks = blocks;
  }

  // Only entries stored after the patched file move.
  for (const e of files.values()) {
    if (e === ent || e.offset === undefined) continue;
    if (Number(e.offset) > off) setNum(e, "offset", Number(e.offset) + delta);
  }

  // Changing the header JSON length shifts every offset, so iterate to a fixed point.
  let curBase = dataBase;
  for (let i = 0; i < 16; i++) {
    const js = buildHeader(header);
    const newBase = 16 + js.length;
    if (newBase === curBase) break;
    const d = newBase - curBase;
    for (const e of files.values()) {
      if (e.offset !== undefined) setNum(e, "offset", Number(e.offset) + d);
    }
    curBase = newBase;
  }
  const js = buildHeader(header);
  if (16 + js.length !== curBase) throw new Error("asar header length did not converge");

  const data = buf.subarray(dataBase);
  const newData = Buffer.concat([
    data.subarray(0, off),
    newContent,
    data.subarray(off + size),
  ]);

  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + js.length, 4);
  head.writeUInt32LE(4 + js.length, 8);
  head.writeUInt32LE(js.length, 12);

  const out = Buffer.concat([head, js, newData]);
  const tmp = asarPath + ".new";
  writeFileSync(tmp, out);

  // Verify before touching the real file. A bad write here bricks the install.
  const { checked, bad } = verifyAsarFile(tmp);
  if (bad > 0) {
    unlinkSync(tmp);
    throw new Error(`integrity check failed: ${bad}/${checked} files, nothing written`);
  }

  renameSync(tmp, asarPath);
  return { already: false, size, newSize: newContent.length, checked, bad };
}

// --------------------------------------------------------------------- cookie

async function cleanCookies() {
  const appData = process.env.APPDATA;
  if (!appData) return { skipped: "APPDATA not set" };
  const dbPath = join(appData, "@deepseek-ai", "dsh-desktop", "Network", "Cookies");
  if (!existsSync(dbPath)) return { skipped: "cookie database not found" };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { skipped: "this Node build has no node:sqlite" };
  }

  const db = new DatabaseSync(dbPath);
  try {
    const where = `host_key='127.0.0.1' AND name LIKE '${COOKIE_PREFIX}%'`;
    const before = db.prepare(`SELECT COUNT(*) AS n FROM cookies WHERE ${where}`).get().n;
    if (before > 0) db.exec(`DELETE FROM cookies WHERE ${where}`);
    return { removed: before };
  } finally {
    db.close();
  }
}

// ----------------------------------------------------------------------- main

function resolveAsar(home) {
  const asar = join(home, "resources", "app.asar");
  if (!existsSync(asar)) throw new Error(`not found: ${asar}`);
  return asar;
}

async function main() {
  const [cmd = "apply", home] = process.argv.slice(2);
  if (!home) {
    console.error('usage: node patch.mjs <apply|revert|check|verify> "<install dir>"');
    process.exitCode = 2;
    return;
  }

  const asar = resolveAsar(home);
  const backup = asar + ".orig";

  if (cmd === "check") {
    const st = inspect(asar);
    console.log(`install dir : ${home}`);
    console.log(`app.asar    : ${statSync(asar).size} bytes`);
    console.log(`backup      : ${existsSync(backup) ? statSync(backup).size + " bytes" : "none"}`);
    console.log(`state       : ${st.patched ? "patched" : "not patched"}`);
    if (!st.supported) console.log(`note        : ${st.reason}`);
    return;
  }

  if (cmd === "verify") {
    const { checked, bad } = verifyAsarFile(asar);
    console.log(`checked ${checked} files, ${bad} hash mismatches`);
    process.exitCode = bad === 0 ? 0 : 1;
    return;
  }

  if (cmd === "revert") {
    if (!existsSync(backup)) {
      console.error("no app.asar.orig backup, cannot revert");
      process.exitCode = 1;
      return;
    }
    if (isRunning()) {
      console.error("DeepSeek Harness is running. Quit it completely first.");
      process.exitCode = 1;
      return;
    }
    copyFileSync(backup, asar);
    console.log(`restored app.asar (${statSync(asar).size} bytes)`);
    return;
  }

  if (cmd !== "apply") {
    console.error(`unknown command: ${cmd}`);
    process.exitCode = 2;
    return;
  }

  if (isRunning()) {
    console.error("DeepSeek Harness is running.");
    console.error("Quit it from the tray icon, or end DeepSeek Harness.exe in Task Manager.");
    process.exitCode = 1;
    return;
  }

  const st = inspect(asar);
  if (st.patched) {
    console.log("[1/2] app.asar is already patched, skipping");
  } else {
    if (!st.supported) throw new Error(st.reason);
    // An unpatched asar is the original, so it is safe to (re)create the backup.
    if (!existsSync(backup) || statSync(backup).size !== statSync(asar).size) {
      copyFileSync(asar, backup);
      console.log("[1/2] backed up app.asar -> app.asar.orig");
    }
    const r = patchAsar(asar);
    console.log(
      `[1/2] patched dsh-host-webserver ${r.size} -> ${r.newSize} bytes, ` +
        `${r.checked} files verified`
    );
  }

  const c = await cleanCookies();
  if (c.skipped) console.log(`[2/2] skipped cookie cleanup (${c.skipped})`);
  else console.log(`[2/2] removed ${c.removed} stale dsh-auth-* cookies`);

  console.log("");
  console.log("Done. DeepSeek Harness should start normally now.");
  console.log("Note: auto-update replaces app.asar, so re-run this after updating.");
}

main().catch((err) => {
  console.error("");
  console.error("failed: " + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
