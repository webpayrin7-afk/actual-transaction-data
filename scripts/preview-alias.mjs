#!/usr/bin/env node
/**
 * Point the stable preview domain at the Vercel Preview deployment of the current HEAD.
 *
 *   npm run preview:alias            # after `git push`
 *   PREVIEW_ALIAS=foo.vercel.app npm run preview:alias
 *
 * Waits for Vercel's GitHub deployment of HEAD to succeed, then runs `vercel alias set`.
 * Preview only: refuses Production deployments and never passes --prod.
 * Needs `gh` (logged in) and the Vercel CLI (`npm i -g vercel`, `vercel login` once).
 */
import { execSync } from "node:child_process";

const ALIAS = process.env.PREVIEW_ALIAS || "ziplab-preview.vercel.app";
const SCOPE = process.env.VERCEL_SCOPE || "webpayrin7-6446";
const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 10 * 1000;

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sha = sh("git rev-parse HEAD");
const remote = sh("git remote get-url origin");
const repo = remote.match(/github\.com[:/](.+?)(\.git)?$/)?.[1];
if (!repo) throw new Error(`Cannot parse GitHub repo from ${remote}`);

const unpushed = sh(`git branch -r --contains ${sha}`);
if (!unpushed) {
  console.error(`HEAD ${sha.slice(0, 7)} is not on any remote branch. Push first.`);
  process.exit(1);
}

async function findPreviewUrl() {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    const deployments = JSON.parse(sh(`gh api "repos/${repo}/deployments?sha=${sha}"`));
    for (const d of deployments) {
      if (d.environment !== "Preview") continue;
      const [status] = JSON.parse(sh(`gh api "repos/${repo}/deployments/${d.id}/statuses"`));
      if (status?.state === "success" && status.environment_url) return status.environment_url;
      if (status?.state === "failure" || status?.state === "error") {
        throw new Error(`Preview deployment ${status.state}: ${status.target_url ?? ""}`);
      }
    }
    process.stdout.write(`waiting for Preview of ${sha.slice(0, 7)}…\n`);
    await sleep(POLL_MS);
  }
  throw new Error("Timed out waiting for the Preview deployment");
}

const url = await findPreviewUrl();
if (/actual-transaction-data\.vercel\.app/.test(url)) {
  throw new Error(`Refusing: ${url} looks like the Production domain`);
}
console.log(`alias ${ALIAS} → ${url}`);
execSync(`vercel alias set ${url} ${ALIAS} --scope ${SCOPE}`, { stdio: "inherit" });
console.log(`https://${ALIAS}`);
