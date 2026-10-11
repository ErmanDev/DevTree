// Merge / rebase conflicts: banner, conflict editor, continue / skip / abort, drag & drop merge.
const { test, expect, menu } = require("../support/fixtures");

/** main and feature both change line 2 of a.txt. */
function diverged(makeRepo) {
  const repo = makeRepo();
  repo.commit("base", { "a.txt": "line1\nshared\nline3\n" });
  repo.git("switch", "-q", "-c", "feature");
  repo.commit("feature edit", { "a.txt": "line1\nfeature version\nline3\n" });
  repo.git("switch", "-q", "main");
  repo.commit("main edit", { "a.txt": "line1\nmain version\nline3\n" });
  return repo;
}

test("drag a branch onto the current one, resolve in the editor, commit the merge", async ({ page, makeRepo, openRepo }) => {
  const repo = diverged(makeRepo);
  await openRepo(repo);

  await page.locator("#localList li[data-ref='feature']").dragTo(page.locator("#localList li[data-ref='main']"));
  await expect(page.locator("#ctxMenu button")).toHaveText(["Merge feature into main", "Rebase main onto feature"]);
  await menu(page, "Merge feature into main");
  await page.locator("#dialogOk").click(); // strategy dialog

  const banner = page.locator("#opBanner");
  await expect(banner).toContainText("MERGING");
  await expect(banner).toContainText("1 conflicted file");
  await expect(banner.locator("[data-op='continue']")).toBeDisabled();

  await banner.locator("[data-op='resolve']").click();
  await expect(page.locator(".cx-card")).toHaveCount(1);
  await expect(page.locator(".cx-code.ours")).toHaveText("main version\n");
  await expect(page.locator(".cx-code.theirs")).toHaveText("feature version\n");
  await page.locator("[data-cx='both']").click();
  await page.locator("#diffActions [data-cx='save']").click();
  await expect(banner).toContainText("all conflicts resolved");
  expect(repo.read("a.txt")).toBe("line1\nmain version\nfeature version\nline3\n");

  await banner.locator("[data-op='continue']").click();
  await expect(banner).toBeHidden();
  expect(repo.log("%s", "-1")).toEqual(["Merge branch 'feature'"]);
});

test("manual editing in the conflict editor", async ({ page, makeRepo, openRepo }) => {
  const repo = diverged(makeRepo);
  repo.tryGit("merge", "feature");
  await openRepo(repo);
  await page.locator("#opBanner [data-op='resolve']").click();
  await page.locator("#diffActions [data-cx='manual']").click();
  await page.locator("#cxManual").fill("line1\nhand merged\nline3\n");
  await page.locator("#diffActions [data-cx='save']").click();
  await expect(page.locator("#opBanner")).toContainText("all conflicts resolved");
  expect(repo.git("show", ":a.txt")).toBe("line1\nhand merged\nline3\n");
});

test("abort a merge from the banner", async ({ page, makeRepo, openRepo }) => {
  const repo = diverged(makeRepo);
  const head = repo.head();
  repo.tryGit("merge", "feature");
  await openRepo(repo);
  await page.locator("#opBanner [data-op='abort']").click();
  await page.locator("#dialogOk").click();
  await expect(page.locator("#opBanner")).toBeHidden();
  expect(repo.head()).toBe(head);
  expect(repo.read("a.txt")).toBe("line1\nmain version\nline3\n");
});

test("rebase conflict: take a whole side, then continue; skip works too", async ({ page, makeRepo, openRepo }) => {
  const repo = diverged(makeRepo);
  await openRepo(repo);

  await page.locator("#localList li[data-ref='feature']").click({ button: "right" });
  await menu(page, "Rebase main onto feature");
  await page.locator("#dialogOk").click();
  const banner = page.locator("#opBanner");
  await expect(banner).toContainText("REBASING");
  await expect(banner).toContainText("step 1/1");

  await banner.locator("[data-op='resolve']").click();
  await page.locator("[data-cx='take-theirs']").first().click();
  await expect(banner).toContainText("all conflicts resolved");
  await banner.locator("[data-op='continue']").click();
  await expect(banner).toBeHidden();
  // "theirs" during a rebase is the commit being replayed (main's own edit).
  expect(repo.read("a.txt")).toBe("line1\nmain version\nline3\n");
  expect(repo.log("%s")).toEqual(["main edit", "feature edit", "base"]);

  // Second rebase that we skip instead.
  repo.git("reset", "-q", "--hard", "HEAD~1");
  repo.commit("another main edit", { "a.txt": "line1\nyet another\nline3\n" });
  repo.git("branch", "-f", "feature", "HEAD~1");
  repo.git("switch", "-q", "feature");
  repo.commit("conflicting feature", { "a.txt": "line1\nconflict\nline3\n" });
  repo.git("switch", "-q", "main");
  await page.evaluate(() => reload());
  await page.locator("#localList li[data-ref='feature']").click({ button: "right" });
  await menu(page, "Rebase main onto feature");
  await page.locator("#dialogOk").click();
  await expect(banner).toContainText("REBASING");
  await banner.locator("[data-op='skip']").click();
  await expect(banner).toBeHidden();
  expect(repo.log("%s", "-1")).toEqual(["conflicting feature"]);
});
