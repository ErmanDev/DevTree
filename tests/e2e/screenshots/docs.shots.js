// Screenshots for the documentation site (site/img). Not part of the test suite.
// Regenerate after UI changes:  cd tests/e2e && npx playwright test --config screenshots.config.js
const { test, expect, menu } = require("../support/fixtures");
const path = require("node:path");

const OUT = path.resolve(__dirname, "../../../site/img");

const PEOPLE = {
  ada: "Ada Lovelace <ada@example.com>",
  grace: "Grace Hopper <grace@example.com>",
  linus: "Linus Torvalds <linus@example.com>",
  octo: "Octo Cat <583231+octocat@users.noreply.github.com>",
  margaret: "Margaret Hamilton <margaret@example.com>",
};
const COLORS = { ada: "70,130,180", grace: "199,116,160", linus: "214,140,60", octo: "120,60,160", margaret: "95,179,161" };

/** Answers avatar requests with simple silhouettes, so screenshots never depend on the network. */
async function fakeAvatars(page) {
  const crypto = require("node:crypto");
  const byHash = {};
  for (const [k, p] of Object.entries(PEOPLE)) {
    const email = p.match(/<(.*)>/)[1];
    byHash[crypto.createHash("sha256").update(email).digest("hex")] = COLORS[k];
  }
  const svg = (rgb) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="rgb(${rgb})"/><circle cx="32" cy="25" r="12" fill="#f3e9d8"/><rect x="12" y="42" width="40" height="24" rx="12" fill="#f3e9d8"/></svg>`;
  await page.route("https://www.gravatar.com/avatar/**", (r) => {
    const rgb = byHash[new URL(r.request().url()).pathname.split("/").pop()];
    // Margaret has no picture: shows the initials fallback.
    return rgb && rgb !== COLORS.margaret ? r.fulfill({ contentType: "image/svg+xml", body: svg(rgb) }) : r.fulfill({ status: 404 });
  });
  await page.route("https://avatars.githubusercontent.com/**", (r) => r.fulfill({ contentType: "image/svg+xml", body: svg(COLORS.octo) }));
}

/** A small but realistic project history with several authors, branches, a merge, tags and a remote. */
function demoRepo(makeRepo) {
  const remote = makeRepo("origin.git", { bare: true });
  const repo = makeRepo("acme-web");
  const c = (who, msg, files) => {
    for (const [f, t] of Object.entries(files)) repo.write(f, t);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", msg, "--author", PEOPLE[who]);
  };
  c("ada", "Initial project scaffold", { "README.md": "# acme-web\n", "src/app.rs": "fn main() {}\n" });
  c("grace", "Add HTTP server skeleton", { "src/server.rs": "pub fn serve() {}\n" });
  c("linus", "Set up CI workflow", { ".ci.yml": "jobs: {}\n" });
  repo.git("tag", "v0.1.0");
  repo.git("remote", "add", "origin", remote.dir);
  repo.git("push", "-q", "-u", "origin", "main", "--tags");
  repo.git("switch", "-q", "-c", "feature/login");
  c("octo", "Login form markup", { "web/login.html": "<form></form>\n" });
  c("ada", "Validate credentials on submit", { "web/login.js": "export function validate() {}\n" });
  c("octo", "Remember me checkbox", { "web/login.html": "<form><input type=checkbox></form>\n" });
  repo.git("push", "-q", "-u", "origin", "feature/login");
  repo.git("switch", "-q", "main");
  c("margaret", "Fix typo in README", { "README.md": "# acme-web\n\nThe ACME web app.\n" });
  repo.git("switch", "-q", "-c", "fix/timeouts");
  c("linus", "Raise request timeout to 30s", { "src/server.rs": "pub const TIMEOUT: u64 = 30;\npub fn serve() {}\n" });
  repo.git("switch", "-q", "main");
  c("grace", "Structured logging", { "src/log.rs": "pub fn info(msg: &str) { println!(\"{msg}\"); }\n" });
  repo.git("merge", "-q", "--no-ff", "feature/login", "-m", "Merge feature/login");
  c("ada", "Session cookies", { "src/session.rs": "pub struct Session;\n" });
  repo.git("tag", "v0.2.0");
  repo.git("push", "-q", "origin", "main", "--tags");
  c("margaret", "Dark mode for the dashboard", { "web/theme.css": ":root { --bg: #1c1a17; }\n" });
  return { repo, remote };
}

async function shoot(page, name, clip) {
  await page.waitForTimeout(600); // let avatars and fonts settle
  await page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });
}

test.beforeEach(async ({ page }) => {
  await fakeAvatars(page);
});

test("overview (dark and light)", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  repo.write("src/session.rs", "pub struct Session {\n    pub user: String,\n}\n");
  await openRepo(repo);
  await page.locator(".row", { hasText: "Merge feature/login" }).hover();
  await page.locator(".row", { hasText: "Validate credentials on submit" }).click();
  await expect(page.locator("#detail h2")).toContainText("commit");
  await shoot(page, "overview");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.mouse.move(1300, 800);
  await shoot(page, "overview-light");
});

test("partial staging", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  const lines = ["use std::time::Duration;", "", "pub const TIMEOUT: u64 = 10;", "", "pub fn serve(port: u16) {"];
  for (let i = 0; i < 8; i++) lines.push(`    // step ${i}`);
  lines.push("    let addr = format!(\"127.0.0.1:{port}\");", "    println!(\"listening on {addr}\");", "}", "");
  repo.write("src/server.rs", lines.join("\n"));
  repo.commit("Server listens on a port");
  repo.write("src/server.rs", lines.join("\n").replace("TIMEOUT: u64 = 10", "TIMEOUT: u64 = 30").replace("println!(\"listening on {addr}\");", "log::info(&format!(\"listening on {addr}\"));\n    accept_loop(&addr);"));
  await openRepo(repo);
  await page.locator(".row.wip").click();
  await page.locator("li[data-wdiff='src/server.rs']").click();
  await page.locator(".ln.add.selectable", { hasText: "TIMEOUT" }).click();
  await page.locator(".ln.del.selectable", { hasText: "TIMEOUT" }).click();
  await shoot(page, "partial-staging");
});

test("conflict editor", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  repo.git("switch", "-q", "fix/timeouts");
  repo.write("src/server.rs", "pub const TIMEOUT: u64 = 30;\npub const RETRIES: u32 = 3;\npub fn serve() {}\n").git("add", "-A");
  repo.git("commit", "-q", "-m", "Retry failed requests", "--author", PEOPLE.linus);
  repo.git("switch", "-q", "main");
  repo.write("src/server.rs", "pub const TIMEOUT: u64 = 15;\npub const RETRIES: u32 = 5;\npub fn serve() {}\n").git("add", "-A");
  repo.git("commit", "-q", "-m", "Tune server limits", "--author", PEOPLE.grace);
  repo.tryGit("merge", "fix/timeouts");
  await openRepo(repo);
  await page.locator("#opBanner [data-op='resolve']").click();
  await expect(page.locator(".cx-card")).toBeVisible();
  await shoot(page, "conflicts");
});

test("interactive rebase", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  repo.commit("WIP", { "web/theme.css": ":root { --bg: #1c1a17; --fg: #f0e8d8; }\n" });
  repo.commit("fix lint", { "web/theme.css": ":root { --bg: #1c1a17; --fg: #f0e8d8; }\n\n" });
  repo.commit("Theme toggle button", { "web/toggle.js": "export function toggle() {}\n" });
  await openRepo(repo);
  await page.locator(".row", { hasText: "Session cookies" }).click({ button: "right" });
  await menu(page, "Interactive rebase from here");
  await page.locator("[data-rb-action='1']").selectOption("reword");
  await page.locator("[data-rb-msg='1']").fill("Dark and light theme colours");
  await page.locator("[data-rb-action='2']").selectOption("fixup");
  await page.locator("[data-rb-action='0']").selectOption("squash");
  await page.locator("[data-rb-action='0']").selectOption("pick");
  await shoot(page, "interactive-rebase");
});

test("blame, history and search", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  await openRepo(repo);
  await page.locator(".row", { hasText: "Raise request timeout" }).click();
  await page.locator("li[data-cdiff='src/server.rs']").click();
  await page.locator("#diffActions [data-panel='blame']").click();
  await expect(page.locator(".bl-row").first()).toBeVisible();
  await shoot(page, "blame");
  await page.locator("#btnCloseDiff").click();
  await page.locator("#searchMode").selectOption("author");
  await page.locator("#search").fill("ada");
  await page.locator("#search").press("Enter");
  await expect(page.locator(".search-list li").first()).toBeVisible();
  await shoot(page, "search");
});

test("compare branches", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  await openRepo(repo);
  await page.locator("#localList li[data-ref='fix/timeouts']").click({ button: "right" });
  await menu(page, "Compare with main");
  await expect(page.locator(".cmp-sum")).toBeVisible();
  await page.locator("li[data-xdiff='src/server.rs']").click();
  await shoot(page, "compare");
});

test("drag and drop merge", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  await openRepo(repo);
  await page.locator("#localList li[data-ref='fix/timeouts']").dragTo(page.locator("#localList li[data-ref='main']"));
  await expect(page.locator("#ctxMenu")).toBeVisible();
  await shoot(page, "drag-merge", { x: 0, y: 0, width: 1060, height: 520 });
});
