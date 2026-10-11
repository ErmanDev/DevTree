// Shared test fixtures: an isolated DevTree server per test, git repos to point it at,
// and small helpers for the API and the UI.

const base = require("@playwright/test");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");
const EXE = process.platform === "win32" ? "devtree.exe" : "devtree";
const BIN = process.env.DEVTREE_BIN || path.join(ROOT, "target", "debug", EXE);

/** Environment that makes git behave the same on every machine and CI runner. */
function gitEnv(home) {
  const config = path.join(home, "gitconfig");
  if (!fs.existsSync(config)) {
    fs.writeFileSync(config, "[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[advice]\n\tdetachedHead = false\n");
  }
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1", // ignore e.g. Git for Windows' credential manager and autocrlf
    LC_ALL: "C",
  };
}

/** A git repository on disk with helpers to build history quickly. */
class Repo {
  constructor(dir, env) {
    this.dir = dir;
    this.env = env;
    this.name = path.basename(dir);
  }

  git(...args) {
    return execFileSync("git", ["-C", this.dir, ...args], { env: this.env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  }

  /** Like git(), but returns { ok, out } instead of throwing on a non-zero exit. */
  tryGit(...args) {
    try {
      return { ok: true, out: this.git(...args) };
    } catch (e) {
      return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` };
    }
  }

  write(file, content) {
    const full = path.join(this.dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return this;
  }

  read(file) {
    return fs.readFileSync(path.join(this.dir, file), "utf8");
  }

  /** read(), or null while the file doesn't exist (git rewrites files by replacing them). */
  readIfExists(file) {
    try {
      return this.read(file);
    } catch {
      return null;
    }
  }

  exists(file) {
    return fs.existsSync(path.join(this.dir, file));
  }

  /** Writes the given files (if any), stages everything and commits. Returns the new sha. */
  commit(message, files = {}) {
    for (const [f, c] of Object.entries(files)) this.write(f, c);
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.head();
  }

  head(rev = "HEAD") {
    return this.git("rev-parse", rev).trim();
  }

  log(format = "%s", ...args) {
    return this.git("log", `--format=${format}`, ...args).trim().split("\n").filter(Boolean);
  }
}

/** Kills a child process and waits (up to 5 s) until it has actually exited. */
function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 5000);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
    proc.kill();
  });
}

/** Starts a DevTree server on a free port and waits until it is ready. */
async function startServer(tmp, env) {
  const proc = spawn(BIN, ["--no-open", "--port", "0", "--data-dir", path.join(tmp, "data"), "--clone-dir", path.join(tmp, "clones")], { env });
  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DevTree did not start:\n${output}`)), 15000);
    const onData = (chunk) => {
      output += chunk;
      const m = output.match(/http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://localhost:${m[1]}`);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (c) => (output += c));
    proc.on("error", (e) => reject(new Error(`cannot start ${BIN}: ${e.message}. Build it first with \`cargo build\`.`)));
    proc.on("exit", (code) => reject(new Error(`DevTree exited with ${code}:\n${output}`)));
  });
  return { url, proc, stop: () => stopProcess(proc) };
}

/** Calls the DevTree API; returns { status, body }. */
function apiClient(url) {
  return async (method, route, body) => {
    const res = await fetch(`${url}/api${route}`, {
      method,
      headers: { "X-DevTree": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
}

const test = base.test.extend({
  tmp: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtree-e2e-"));
    await use(dir);
    // Best effort: on Windows, antivirus / indexing can hold freshly written files for a
    // while. A leftover temp folder is harmless and must not fail the test.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (e) {
      console.warn(`could not remove ${dir}: ${e.message}`);
    }
  },

  env: async ({ tmp }, use) => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    await use(gitEnv(home));
  },

  server: async ({ tmp, env }, use) => {
    const srv = await startServer(tmp, env);
    await use(srv);
    await srv.stop();
  },

  api: async ({ server }, use) => {
    await use(apiClient(server.url));
  },

  /** makeRepo(name, { bare }) -> Repo, initialised on branch main. */
  makeRepo: async ({ tmp, env }, use) => {
    await use((name = "repo", { bare = false } = {}) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", ...(bare ? ["--bare"] : []), dir], { env });
      return new Repo(dir, env);
    });
  },

  /** Imports a repo into DevTree and opens the app on it. Returns the repo id. */
  openRepo: async ({ page, server, api }, use) => {
    await use(async (repo) => {
      const res = await api("POST", "/repos", { path: repo.dir });
      base.expect(res.status, JSON.stringify(res.body)).toBe(200);
      await page.goto(server.url);
      await page.evaluate((id) => localStorage.setItem("devtree.repo", id), res.body.id);
      await page.reload();
      // `state` is a top-level const in app.js: reachable by name, not as window.state.
      await page.waitForFunction(() => typeof state !== "undefined" && state.repo && state.status);
      return res.body.id;
    });
  },

  /** Fails the test on any uncaught error in the page. */
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(page);
    base.expect(errors, "uncaught errors in the page").toEqual([]);
  },
});

/** Clicks a context-menu entry by its visible text. */
async function menu(page, label) {
  await page.locator("#ctxMenu button", { hasText: label }).first().click();
}

/** Waits for a toast containing text. */
async function toast(page, text) {
  await base.expect(page.locator(".toast", { hasText: text }).first()).toBeVisible();
}

module.exports = { test, expect: base.expect, Repo, gitEnv, menu, toast, stopProcess, ROOT, BIN };
