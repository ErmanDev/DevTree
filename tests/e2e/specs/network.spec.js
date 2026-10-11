// Remotes that need a password, live progress, cancel, the per-repo lock and auto-fetch.
// Uses support/gitserver.py: a smart-HTTP git server that only accepts alice / s3cret.
const { test: base, expect } = require("../support/fixtures");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

const test = base.extend({
  /** { url, root, slow(seconds|null) } for a password-protected server hosting big.git */
  gitServer: async ({ tmp, env, makeRepo }, use) => {
    const root = path.join(tmp, "srv");
    fs.mkdirSync(root);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", path.join(root, "big.git")], { env });
    // Enough objects that git reports progress while transferring.
    const seed = makeRepo("seed");
    for (let i = 0; i < 400; i++) seed.write(`f${i}.txt`, `${i}`.repeat(2000) + require("node:crypto").randomBytes(1500).toString("hex"));
    seed.commit("big");
    seed.git("push", "-q", path.join(root, "big.git"), "main");

    const proc = spawn(PYTHON, [path.join(__dirname, "..", "support", "gitserver.py"), root], { env });
    let out = "";
    const port = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10000);
      proc.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/PORT (\d+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.stderr.on("data", (d) => (out += d));
      proc.on("error", () => { clearTimeout(timer); resolve(null); });
    });
    test.skip(!port, `needs ${PYTHON} to run the test git server: ${out}`);
    const slowFile = path.join(root, "SLOW");
    await use({
      url: `http://localhost:${port}/big.git`,
      host: `localhost:${port}`,
      slow: (secs) => (secs ? fs.writeFileSync(slowFile, String(secs)) : fs.rmSync(slowFile, { force: true })),
    });
    proc.kill();
  },
});

/** Polls a job's progress lines while `promise` runs. */
async function watchJob(api, job, promise) {
  const seen = [];
  let done = false;
  promise.finally(() => (done = true));
  while (!done) {
    const { status, body } = await api("GET", `/jobs/${job}`);
    if (status === 200 && body.progress && !seen.includes(body.progress)) seen.push(body.progress);
    await new Promise((r) => setTimeout(r, 40));
  }
  return seen;
}

test("sign-in: rejected, wrong password, one-shot and remembered credentials", async ({ api, gitServer, tmp }) => {
  let res = await api("POST", "/repos/clone", { url: gitServer.url });
  expect(res.status).toBe(401);
  expect(res.body.auth).toEqual({ kind: "https", host: gitServer.host, reason: null });
  expect(fs.existsSync(path.join(tmp, "clones", "big"))).toBe(false); // no half-written folder

  await api("POST", "/credentials", { host: gitServer.host, username: "alice", password: "nope" });
  expect((await api("POST", "/repos/clone", { url: gitServer.url })).status).toBe(401);

  await api("POST", "/credentials", { host: gitServer.host, username: "alice", password: "s3cret" });
  const clone = api("POST", "/repos/clone?job=clone-1", { url: gitServer.url });
  const progress = await watchJob(api, "clone-1", clone);
  res = await clone;
  expect(res.status).toBe(200);
  expect(progress.some((l) => /Receiving objects|Cloning into/.test(l))).toBe(true);
  const id = res.body.repo.id;

  // One-shot credentials were forgotten after use.
  expect((await api("POST", `/repos/${id}/fetch`)).status).toBe(401);
  await api("POST", "/credentials", { host: gitServer.host, username: "alice", password: "s3cret", remember: true });
  expect((await api("POST", `/repos/${id}/fetch`)).status).toBe(200);
  expect((await api("POST", `/repos/${id}/fetch`)).status).toBe(200);
  expect((await api("GET", "/credentials")).body.hosts).toEqual([gitServer.host]);
  await api("DELETE", "/credentials");
  expect((await api("POST", `/repos/${id}/fetch`)).status).toBe(401);
});

test("cancel a slow fetch; a second one waits for the lock", async ({ api, gitServer }) => {
  await api("POST", "/credentials", { host: gitServer.host, username: "alice", password: "s3cret", remember: true });
  const { body } = await api("POST", "/repos/clone", { url: gitServer.url });
  const id = body.repo.id;

  gitServer.slow(5);
  const t0 = Date.now();
  const first = api("POST", `/repos/${id}/fetch?job=slow-1`);
  await new Promise((r) => setTimeout(r, 600));
  const second = api("POST", `/repos/${id}/fetch?job=slow-2`);
  await expect.poll(async () => (await api("GET", "/jobs/slow-2")).body.progress).toContain("waiting for another git operation");

  await api("POST", "/jobs/slow-1/cancel");
  const r1 = await first;
  expect(r1.status).toBe(409);
  expect(r1.body.error).toBe("cancelled by user");
  expect(Date.now() - t0).toBeLessThan(4500);

  await api("POST", "/jobs/slow-2/cancel");
  expect((await second).status).toBe(409);
  gitServer.slow(null);
  expect((await api("GET", "/jobs/slow-1")).status).toBe(404);
});

test("UI: clone asks to sign in, shows progress, opens the repo", async ({ page, server, gitServer }) => {
  await page.goto(server.url);
  await page.locator("#btnImportEmpty").click();
  await page.locator(".tab[data-tab='clone']").click();
  await page.locator("#cloneUrl").fill(gitServer.url);
  await page.locator("#btnDoClone").click();

  await expect(page.locator("#dialogTitle")).toHaveText(`Sign in to ${gitServer.host}`);
  await expect(page.locator("#dlg_password")).toHaveAttribute("type", "password");
  await page.locator("#dlg_username").fill("alice");
  await page.locator("#dlg_password").fill("wrong");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#dialogTitle")).toHaveText(`Sign in to ${gitServer.host}`); // asked again

  gitServer.slow(0.5);
  await page.locator("#dlg_username").fill("alice");
  await page.locator("#dlg_password").fill("s3cret");
  await page.locator("#dialogOk").click();
  await expect(page.locator(".job .job-title")).toContainText("clone");
  await expect(page.locator(".job")).toHaveCount(0, { timeout: 30_000 });
  gitServer.slow(null);
  await expect(page.locator("#repoName")).toHaveText("big");
  await expect(page.locator(".row[data-sha]")).toHaveCount(1);
});

test("UI: cancel a pull; auto-fetch flags a missing sign-in without a dialog", async ({ page, api, server, gitServer }) => {
  await api("POST", "/credentials", { host: gitServer.host, username: "alice", password: "s3cret", remember: true });
  const { body } = await api("POST", "/repos/clone", { url: gitServer.url });
  await page.goto(server.url);
  await page.evaluate((id) => localStorage.setItem("devtree.repo", id), body.repo.id);
  await page.reload();
  await expect(page.locator("#repoName")).toHaveText("big");

  gitServer.slow(5);
  await page.locator("#btnPull").click();
  await expect(page.locator(".job")).toBeVisible();
  await page.locator(".job-cancel").click();
  await expect(page.locator(".job")).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator(".toast", { hasText: "cancelled" })).toBeVisible();
  gitServer.slow(null);

  await api("DELETE", "/credentials");
  await page.evaluate(async () => { state.status.last_fetch = 1; state.lastAutoFetch = {}; await autoFetchTick(); });
  await expect(page.locator("#fetchInfo")).toContainText("sign-in needed");
  await expect(page.locator("#dialog")).toBeHidden();

  // Clicking the indicator fetches interactively and asks to sign in.
  await page.locator("#fetchInfo").click();
  await expect(page.locator("#dialogTitle")).toHaveText(`Sign in to ${gitServer.host}`);
  await page.locator("#dlg_username").fill("alice");
  await page.locator("#dlg_password").fill("s3cret");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#fetchInfo")).toContainText("fetched just now");
});
