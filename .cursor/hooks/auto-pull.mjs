/**
 * Auto-pull latest from GitHub (ff-only).
 * Used by Cursor sessionStart hook and `npm run pull`.
 * Fail-open — never blocks the agent.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

function git(args, opts = {}) {
  return spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    ...opts,
  });
}

function log(msg) {
  console.error(`[auto-pull] ${msg}`);
}

try {
  await new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve();
    process.stdin.resume();
    process.stdin.on("data", () => {});
    process.stdin.on("end", resolve);
    setTimeout(resolve, 200);
  });
} catch {
  /* ignore */
}

try {
  if (!existsSync(path.join(ROOT, ".git"))) {
    log("not a git repo — skip");
    process.exit(0);
  }

  // Don't clobber uncommitted local work
  const status = git(["status", "--porcelain"]);
  if (status.status === 0 && String(status.stdout || "").trim()) {
    log("local uncommitted changes — skip pull (commit/sync first or stash)");
    process.exit(0);
  }

  const fetch = git(["fetch", "origin"], { timeout: 60_000 });
  if (fetch.status !== 0) {
    log(`fetch failed: ${fetch.stderr || fetch.stdout}`);
    process.exit(0);
  }

  const behind = git(["rev-list", "--count", "HEAD..@{u}"]);
  const n = Number(String(behind.stdout || "").trim()) || 0;
  if (n === 0) {
    log("already up to date");
    process.exit(0);
  }

  const pull = git(["pull", "--ff-only", "origin", "HEAD"], { timeout: 60_000 });
  if (pull.status !== 0) {
    log(`pull failed: ${pull.stderr || pull.stdout}`);
  } else {
    log(`pulled ${n} commit(s)`);
  }
} catch (err) {
  log(`error: ${err?.message || err}`);
}

process.exit(0);
