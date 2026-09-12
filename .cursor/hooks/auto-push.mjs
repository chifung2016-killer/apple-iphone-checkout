/**
 * Auto-commit + push project changes to GitHub (private repo).
 * Used by Cursor stop hook and `npm run sync`.
 * Never stages .env / secrets. Fail-open (never blocks the agent).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const BLOCKED = new Set([
  ".env",
  ".env.local",
  "used-emails.json",
  "card-remaining-limits.json",
  "order-summary.json",
  "runtime-config.json",
  "runtime-status.json",
]);

function git(args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      // Prefer existing identity; fall back so commits still work
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "chifu",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "chifu@users.noreply.github.com",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "chifu",
      GIT_COMMITTER_EMAIL:
        process.env.GIT_COMMITTER_EMAIL || "chifu@users.noreply.github.com",
    },
    ...opts,
  });
  return r;
}

function log(msg) {
  console.error(`[auto-push] ${msg}`);
}

// Drain stdin so Cursor hooks don't hang (JSON payload unused)
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

  const status = git(["status", "--porcelain"]);
  if (status.status !== 0) {
    log(`git status failed: ${status.stderr || status.stdout}`);
    process.exit(0);
  }

  const lines = String(status.stdout || "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

  if (lines.length === 0) {
    // Still push if local commits are ahead
    const ahead = git(["rev-list", "--count", "@{u}..HEAD"]);
    const n = Number(String(ahead.stdout || "").trim()) || 0;
    if (n > 0) {
      log(`no new files; pushing ${n} local commit(s)…`);
      const push = git(["push", "origin", "HEAD"], { timeout: 90_000 });
      if (push.status !== 0) log(`push failed: ${push.stderr || push.stdout}`);
      else log("pushed");
    } else {
      log("clean — nothing to do");
    }
    process.exit(0);
  }

  const files = lines.map((line) => line.replace(/^[MADRCU?!\s]{1,2}\s+/, "").replace(/^"/, "").replace(/"$/, ""));
  const blockedHit = files.filter((f) => BLOCKED.has(f) || /(^|\/)\.env(\.|$)/.test(f));
  // Stage everything gitignore already excludes secrets; double-check
  const add = git(["add", "-A"]);
  if (add.status !== 0) {
    log(`git add failed: ${add.stderr || add.stdout}`);
    process.exit(0);
  }

  // Unstage anything that slipped through
  for (const name of BLOCKED) {
    git(["reset", "-q", "HEAD", "--", name]);
  }
  git(["reset", "-q", "HEAD", "--", ".env", ".env.local"]);

  const staged = git(["diff", "--cached", "--name-only"]);
  const stagedFiles = String(staged.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (stagedFiles.some((f) => BLOCKED.has(f) || /(^|\/)\.env$/.test(f))) {
    log("refusing to commit secrets — abort");
    process.exit(0);
  }

  if (stagedFiles.length === 0) {
    log("nothing staged after filtering secrets — skip");
    process.exit(0);
  }

  if (blockedHit.length) {
    log(`skipped secrets (not committed): ${blockedHit.join(", ")}`);
  }

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const summary =
    stagedFiles.length <= 3
      ? stagedFiles.join(", ")
      : `${stagedFiles.slice(0, 3).join(", ")} (+${stagedFiles.length - 3})`;
  const msg = `auto: sync ${summary} @ ${stamp}`;

  const commit = git(["commit", "-m", msg]);
  if (commit.status !== 0) {
    log(`commit failed: ${commit.stderr || commit.stdout}`);
    process.exit(0);
  }
  log(`committed: ${msg}`);

  const push = git(["push", "origin", "HEAD"], { timeout: 90_000 });
  if (push.status !== 0) {
    log(`push failed: ${push.stderr || push.stdout}`);
  } else {
    log("pushed to origin");
  }
} catch (err) {
  log(`error: ${err?.message || err}`);
}

process.exit(0);
