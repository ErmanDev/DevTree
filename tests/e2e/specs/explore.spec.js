// File history, blame, search across history, compare.
const { test, expect, menu } = require("../support/fixtures");

function history(makeRepo) {
  const repo = makeRepo();
  repo.commit("Initial program", { "main.rs": "use std::io;\nfn main() {}\n" });
  repo.commit("Add helper_7", { "main.rs": "use std::io;\nfn helper_7() {}\nfn main() {}\n" });
  repo.git("mv", "main.rs", "app.rs");
  repo.commit("Rename main.rs to app.rs");
  repo.commit("Comment the import", { "app.rs": "use std::io; // input\nfn helper_7() {}\nfn main() {}\n" });
  return repo;
}

test("file history follows renames and blame opens commits", async ({ page, makeRepo, openRepo }) => {
  const repo = history(makeRepo);
  await openRepo(repo);
  await page.locator(".row", { hasText: "Comment the import" }).click();
  await page.locator("li[data-cdiff='app.rs']").click({ button: "right" });
  await menu(page, "File history");

  const items = page.locator(".hist-list li");
  await expect(items).toHaveCount(4);
  await expect(items.nth(3)).toContainText("Initial program");
  await expect(items.nth(3)).toContainText("main.rs"); // its name back then
  await items.nth(2).click();
  await expect(page.locator("#histDiff .ln.add")).toContainText(["fn helper_7() {}"]);

  await page.locator("[data-hist-act='blame']").click();
  await expect(page.locator("#diffTitle")).toContainText("blame · main.rs @");
  await page.locator("#diffActions [data-panel='history']").click();
  await page.locator("#btnCloseDiff").click();

  await page.locator(".row", { hasText: "Comment the import" }).click();
  await page.locator("li[data-cdiff='app.rs']").click();
  await page.locator("#diffActions [data-panel='blame']").click();
  const rows = page.locator(".bl-row");
  await expect(rows).toHaveCount(3);
  await rows.nth(1).click(); // helper_7 line
  await expect(page.locator("#detail")).toContainText("Add helper_7");
});

test("search all history by message, author, file, code and sha", async ({ page, makeRepo, openRepo }) => {
  const repo = history(makeRepo);
  const renameSha = repo.head("HEAD~1");
  await openRepo(repo);

  const search = async (mode, q) => {
    await page.locator("#searchMode").selectOption(mode);
    await page.locator("#search").fill(q);
    await page.locator("#search").press("Enter");
    await expect(page.locator("#diffTitle")).toHaveText(`search · ${mode}: ${q}`);
    await expect(page.locator(".search-list")).toBeVisible();
    return page.locator(".search-list li .s-sub").allTextContents().then((t) => t.map((x) => x.trim()));
  };
  expect(await search("message", "RENAME")).toEqual(["Rename main.rs to app.rs"]);
  expect((await search("author", "test user")).length).toBe(4);
  expect(await search("code", "helper_7")).toEqual(["Add helper_7"]);
  expect(await search("file", "app")).toEqual([expect.stringContaining("Comment the import"), "Rename main.rs to app.rs"]);
  expect(await search("sha", renameSha.slice(0, 8))).toEqual(["Rename main.rs to app.rs"]);

  await page.locator(".search-list li").first().click();
  await expect(page.locator(`.row.selected[data-sha="${renameSha}"]`)).toBeVisible();
});

test("compare two commits with ctrl-click, swap sides, open a file diff", async ({ page, makeRepo, openRepo }) => {
  const repo = history(makeRepo);
  const [newest, , , oldest] = repo.log("%H");
  await openRepo(repo);

  await page.locator(`.row[data-sha="${newest}"]`).click();
  await page.locator(`.row[data-sha="${oldest}"]`).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await expect(page.locator(".cmp-sum")).toHaveText(/0 commits only in .* · 3 only in main/);
  await expect(page.locator(".row.selected")).toHaveCount(2);
  await page.locator("[data-cmp='swap']").click();
  await expect(page.locator(".cmp-sum")).toHaveText(/3 commits only in main · 0 only in/);

  await page.locator("li[data-xdiff]").first().click();
  await expect(page.locator("#diffTitle")).toContainText("→");
  await expect(page.locator(".diff-code")).toBeVisible();
});
