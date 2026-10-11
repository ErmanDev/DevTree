const { test, expect } = require("../support/fixtures");
const { execFileSync } = require("node:child_process");

test("graph shows commits, refs, WIP and lanes for a merge", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  repo.commit("Initial commit", { "a.txt": "1\n" });
  repo.git("switch", "-q", "-c", "feature");
  repo.commit("Feature work", { "b.txt": "b\n" });
  repo.git("switch", "-q", "main");
  repo.commit("Main work", { "a.txt": "2\n" });
  repo.git("merge", "-q", "--no-ff", "feature", "-m", "Merge feature");
  repo.git("tag", "v1");
  repo.write("dirty.txt", "x\n");

  await openRepo(repo);
  const rows = page.locator(".row[data-sha]");
  await expect(rows).toHaveCount(5); // WIP + 4 commits
  await expect(page.locator(".row.wip")).toContainText("1 changed file");
  await expect(page.locator(".ref.current", { hasText: "main" })).toBeVisible();
  await expect(page.locator(".ref.tag", { hasText: "v1" })).toBeVisible();
  // The merge needs a second lane.
  expect(await page.evaluate(() => state.width)).toBe(2);
  await expect(page.locator("#branchPill")).toHaveText("⎇ main");

  // Commit details
  await page.locator(".row", { hasText: "Feature work" }).click();
  await expect(page.locator("#detail")).toContainText("Feature work");
  await expect(page.locator("#detail li[data-cdiff='b.txt']")).toBeVisible();
});

test("big histories render only visible rows and load more on scroll", async ({ page, makeRepo, openRepo }) => {
  test.setTimeout(120_000);
  const repo = makeRepo("big");
  // 3,000 commits with a merged feature branch every 15 commits, via fast-import (fast).
  let stream = "", mark = 0, t = 1700000000;
  const commit = (branch, msg, parents) => {
    mark++; t += 60;
    stream += `commit refs/heads/${branch}\nmark :${mark}\ncommitter Dev <d@x> ${t} +0000\ndata ${msg.length}\n${msg}\n`;
    if (parents[0]) stream += `from :${parents[0]}\n`;
    for (const p of parents.slice(1)) stream += `merge :${p}\n`;
    stream += `M 644 inline f${mark % 20}.txt\ndata 4\n${String(mark % 999).padStart(3, "0")}\n\n`;
    return mark;
  };
  let main = commit("main", "root", []);
  for (let n = 1; mark < 3000; n++) {
    if (n % 15 === 0) {
      let f = main;
      for (let k = 0; k < 3; k++) f = commit(`feature/${n}`, `feature ${n} step ${k}`, [f]);
      main = commit("main", `Merge feature/${n}`, [main, f]);
    } else main = commit("main", `work item ${n}`, [main]);
  }
  execFileSync("git", ["-C", repo.dir, "fast-import", "--quiet"], { input: stream, env: repo.env });
  repo.git("reset", "-q", "--hard", "main");
  for (const b of repo.git("branch", "--format=%(refname:short)").split("\n").filter((x) => x.startsWith("feature/")).slice(5)) repo.git("branch", "-q", "-D", b);

  await openRepo(repo);
  await expect(page.locator(".row[data-sha]").first()).toBeVisible();
  expect(await page.evaluate(() => state.rows.length)).toBe(1000);
  expect(await page.locator(".row").count()).toBeLessThan(120);

  // Scrolling to the bottom keeps loading until everything is there.
  for (let i = 0; i < 20 && (await page.evaluate(() => state.truncated || state.loadingMore)); i++) {
    await page.evaluate(() => { const s = document.getElementById("graphScroll"); s.scrollTop = s.scrollHeight; });
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(() => !state.loadingMore && !state.truncated);
  expect(await page.evaluate(() => state.rows.length)).toBe(3000);
  expect(await page.locator(".row").count()).toBeLessThan(120);
  await page.evaluate(() => { const s = document.getElementById("graphScroll"); s.scrollTop = s.scrollHeight; renderWindow(); });
  await expect(page.locator(".row", { hasText: "root" })).toBeVisible();

  // Hover highlights the first-parent path.
  await page.evaluate(() => { document.getElementById("graphScroll").scrollTop = 0; renderWindow(); });
  await page.locator(".row", { hasText: /feature \d+ step 2/ }).first().hover();
  await expect(page.locator("#graphSvg .g-path")).toHaveCount(1);
  expect(await page.locator(".row.on-path").count()).toBeGreaterThan(3);

  // Keyboard navigation scrolls past the rendered window.
  await page.locator(".row[data-sha]").first().click();
  for (let i = 0; i < 150; i++) await page.keyboard.press("j");
  const sel = await page.evaluate(() => state.selected);
  expect(await page.evaluate((s) => state.graph.index.get(s), sel)).toBe(150);
  await expect(page.locator(`.row.selected[data-sha="${sel}"]`)).toBeVisible();
});

test("empty repository", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  await openRepo(repo);
  await expect(page.locator("#rows")).toContainText("No commits yet");
  repo.write("first.txt", "hello\n");
  await page.evaluate(() => poll());
  await expect(page.locator(".row.wip")).toBeVisible();
});
