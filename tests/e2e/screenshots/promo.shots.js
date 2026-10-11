// Recordings for the promo video (marketing/): each feature is a short sequence of real
// interactions with the app. Every step saves a screenshot and where the pointer went, and the
// video replays them with an animated pointer. Not part of the test suite.
// Regenerate after UI changes:  cd tests/e2e && npx playwright test --config screenshots.config.js promo
const { test, expect, menu } = require("../support/fixtures");
const fs = require("node:fs");
const path = require("node:path");
const { fakeAvatars, demoRepo } = require("./demo");

const OUT = path.resolve(__dirname, "../../../marketing/public/promo");
const VIEW = { width: 1440, height: 860 };

/** Records a scene: a screenshot per step, plus the pointer's target for that step. */
function recorder(page, scene) {
  const beats = [];
  fs.mkdirSync(OUT, { recursive: true });
  const center = async (locator) => {
    const b = await locator.boundingBox();
    if (!b) throw new Error(`${scene}: target not visible`);
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  };
  const snap = async (beat) => {
    await page.waitForTimeout(500); // let transitions, avatars and fonts settle
    const image = `promo/${scene}-${beats.length}.png`;
    await page.screenshot({ path: path.join(OUT, path.basename(image)) });
    beats.push({ image, ...beat });
  };
  return {
    /** The opening frame, with the pointer out of the way. */
    async start() {
      await page.mouse.move(VIEW.width - 4, VIEW.height - 4);
      await snap({});
    },
    async hover(locator) {
      const to = await center(locator);
      await page.mouse.move(to.x, to.y, { steps: 4 });
      await snap({ action: "hover", to });
    },
    async click(locator, options = {}) {
      const to = await center(locator);
      await locator.click(options);
      if (options.until) await options.until();
      await snap({ action: "click", to });
    },
    async select(locator, value) {
      const to = await center(locator);
      await locator.selectOption(value);
      await page.mouse.move(to.x, to.y);
      await snap({ action: "click", to });
    },
    async drag(from, onto) {
      const a = await center(from);
      const b = await center(onto);
      await from.dragTo(onto);
      await page.mouse.move(b.x, b.y);
      await snap({ action: "drag", from: a, to: b });
    },
    save() {
      fs.writeFileSync(path.join(OUT, `${scene}.json`), JSON.stringify({ scene, ...VIEW, beats }, null, 2) + "\n");
    },
  };
}

test.beforeEach(async ({ page }) => {
  await fakeAvatars(page);
});

test("promo: commit graph", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  repo.write("src/session.rs", "pub struct Session {\n    pub user: String,\n}\n");
  await openRepo(repo);
  const rec = recorder(page, "graph");
  await rec.start();
  await rec.hover(page.locator(".row .subject", { hasText: "Remember me checkbox" }));
  await rec.click(page.locator(".row .subject", { hasText: "Merge feature/login" }));
  await rec.click(page.locator(".row .subject", { hasText: "Raise request timeout to 30s" }));
  rec.save();
});

test("promo: partial staging", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  const lines = ["use std::time::Duration;", "", "pub const TIMEOUT: u64 = 10;", "", "pub fn serve(port: u16) {"];
  for (let i = 0; i < 8; i++) lines.push(`    // step ${i}`);
  lines.push("    let addr = format!(\"127.0.0.1:{port}\");", "    println!(\"listening on {addr}\");", "}", "");
  repo.write("src/server.rs", lines.join("\n"));
  repo.commit("Server listens on a port");
  repo.write(
    "src/server.rs",
    lines
      .join("\n")
      .replace("TIMEOUT: u64 = 10", "TIMEOUT: u64 = 30")
      .replace("println!(\"listening on {addr}\");", "log::info(&format!(\"listening on {addr}\"));\n    accept_loop(&addr);"),
  );
  await openRepo(repo);
  await page.locator(".row.wip").click();
  await page.locator("li[data-wdiff='src/server.rs']").click();
  await expect(page.locator(".ln.add.selectable").first()).toBeVisible();
  const rec = recorder(page, "staging");
  await rec.start();
  await rec.click(page.locator(".ln.del.selectable", { hasText: "TIMEOUT" }));
  await rec.click(page.locator(".ln.add.selectable", { hasText: "TIMEOUT" }));
  await rec.click(page.locator("[data-dv='stage-sel']"), {
    until: () => expect(page.locator("#stagedList li[data-wdiff='src/server.rs']")).toBeVisible(),
  });
  rec.save();
});

test("promo: conflict editor", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  repo.git("switch", "-q", "fix/timeouts");
  repo.write("src/server.rs", "pub const TIMEOUT: u64 = 30;\npub const RETRIES: u32 = 3;\npub fn serve() {}\n").git("add", "-A");
  repo.git("commit", "-q", "-m", "Retry failed requests");
  repo.git("switch", "-q", "main");
  repo.write("src/server.rs", "pub const TIMEOUT: u64 = 15;\npub const RETRIES: u32 = 5;\npub fn serve() {}\n").git("add", "-A");
  repo.git("commit", "-q", "-m", "Tune server limits");
  repo.tryGit("merge", "fix/timeouts");
  await openRepo(repo);
  const rec = recorder(page, "conflicts");
  await rec.start();
  await rec.click(page.locator("#opBanner [data-op='resolve']"), { until: () => expect(page.locator(".cx-card")).toBeVisible() });
  await rec.click(page.locator("[data-cx='theirs']").first());
  await rec.click(page.locator("[data-cx='save']").first(), {
    until: () => expect(page.locator("#conflictBlock")).toBeHidden(),
  });
  rec.save();
});

test("promo: interactive rebase", async ({ page, makeRepo, openRepo }) => {
  const { repo } = demoRepo(makeRepo);
  repo.commit("WIP", { "web/theme.css": ":root { --bg: #0d1317; --fg: #e2f3ee; }\n" });
  repo.commit("fix lint", { "web/theme.css": ":root { --bg: #0d1317; --fg: #e2f3ee; }\n\n" });
  repo.commit("Theme toggle button", { "web/toggle.js": "export function toggle() {}\n" });
  await openRepo(repo);
  await page.locator(".row", { hasText: "Session cookies" }).click({ button: "right" });
  await menu(page, "Interactive rebase from here");
  await expect(page.locator(".rb-list li")).toHaveCount(4);
  const rec = recorder(page, "rebase");
  await rec.start();
  await rec.select(page.locator("[data-rb-action='1']"), "reword");
  await page.locator("[data-rb-msg='1']").fill("Dark and light theme colours");
  await rec.select(page.locator("[data-rb-action='2']"), "fixup");
  await rec.drag(page.locator(".rb-handle").nth(3), page.locator(".rb-list li").nth(0));
  await rec.click(page.locator("#rbStart"), { until: () => expect(page.locator("#rebaseModal")).toBeHidden() });
  rec.save();
});
