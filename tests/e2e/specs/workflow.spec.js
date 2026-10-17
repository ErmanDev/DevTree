// Everyday work: stage, commit, discard, stash, branches, pull and push against a local remote.
const { test, expect, menu, toast } = require("../support/fixtures");

test("stage, unstage and commit from the working tree panel", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  repo.commit("init", { "a.txt": "a\n" });
  repo.write("a.txt", "a2\n").write("new.txt", "new\n");
  await openRepo(repo);

  await page.locator(".row.wip").click();
  await expect(page.locator("#unstagedHead")).toHaveText("UNSTAGED (2)");
  await page.locator("li[data-wdiff='new.txt']").hover();
  await page.locator("li[data-wdiff='new.txt'] .do-stage").click();
  await expect(page.locator("#stagedHead")).toHaveText("STAGED (1)");
  expect(repo.git("diff", "--cached", "--name-only").trim()).toBe("new.txt");

  await page.locator("#btnStageAll").click();
  await expect(page.locator("#stagedHead")).toHaveText("STAGED (2)");
  await page.locator("li[data-wdiff='a.txt'][data-staged='true']").hover();
  await page.locator("li[data-wdiff='a.txt'][data-staged='true'] .do-unstage").click();
  await expect(page.locator("#stagedHead")).toHaveText("STAGED (1)");

  await page.locator("#commitMsg").fill("Add new file");
  await page.locator("#btnCommit").click();
  await toast(page, "commit");
  expect(repo.log("%s", "-1")).toEqual(["Add new file"]);
  expect(repo.git("status", "--short").trim()).toBe("M a.txt");
});

test("discard a file and discard everything", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  repo.commit("init", { "a.txt": "a\n", "b.txt": "b\n" });
  repo.write("a.txt", "changed\n").write("b.txt", "changed\n").write("untracked.txt", "u\n");
  await openRepo(repo);
  await page.locator(".row.wip").click();

  await page.locator("li[data-wdiff='a.txt']").hover();
  await page.locator("li[data-wdiff='a.txt'] .do-discard").click();
  await expect(page.locator("#dialogTitle")).toHaveText("Discard changes");
  await page.locator("#dialogOk").click();
  await expect.poll(() => repo.readIfExists("a.txt")).toBe("a\n");

  await page.locator("#btnDiscardAll").click();
  await expect(page.locator("#dialogTitle")).toHaveText("Discard all changes");
  await page.locator("#dialogOk").click();
  await expect.poll(() => repo.git("status", "--short")).toBe("");
  expect(repo.exists("untracked.txt")).toBe(false);
});

test("stash, see it in the sidebar, pop it", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  repo.commit("init", { "a.txt": "a\n" });
  repo.write("a.txt", "work in progress\n");
  await openRepo(repo);

  await page.locator("#btnStash").click();
  await page.locator("#dlg_message").fill("half done");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#stashList li[data-stash='0']")).toContainText("half done");
  expect(repo.read("a.txt")).toBe("a\n");

  await page.locator("#stashList li[data-stash='0']").click();
  await page.locator("[data-stash-act='pop']").click();
  await expect.poll(() => repo.readIfExists("a.txt")).toBe("work in progress\n");
  await expect(page.locator("#stashList li[data-stash]")).toHaveCount(0);
});

test("create, rename, check out and delete branches", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  repo.commit("init", { "a.txt": "a\n" });
  await openRepo(repo);

  await page.locator("#btnBranch").click();
  await page.locator("#dlg_name").fill("feature/x");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#branchPill")).toHaveText("⎇ feature/x");

  await page.locator("#localList li[data-ref='feature/x']").click({ button: "right" });
  await menu(page, "Rename…");
  await page.locator("#dlg_name").fill("feature/y");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#localList li[data-ref='feature/y']")).toBeVisible();

  await page.locator("#localList li[data-ref='main']").dblclick();
  await expect(page.locator("#branchPill")).toHaveText("⎇ main");

  repo.git("switch", "-q", "feature/y");
  repo.commit("unmerged work");
  repo.git("switch", "-q", "main");
  await page.evaluate(() => reload());
  await page.locator("#localList li[data-ref='feature/y']").click({ button: "right" });
  await menu(page, "Delete feature/y");
  await page.locator("#dialogOk").click();
  // Not merged: asks again before forcing.
  await expect(page.locator("#dialogTitle")).toHaveText("Branch not merged");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#localList li[data-ref='feature/y']")).toHaveCount(0);
});

test("checkout with local changes in the way offers stash & switch", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  repo.commit("init", { "a.txt": "a\n" });
  repo.git("switch", "-q", "-c", "other");
  repo.commit("other", { "a.txt": "other\n" });
  repo.git("switch", "-q", "main");
  repo.write("a.txt", "dirty\n");
  await openRepo(repo);

  await page.locator("#localList li[data-ref='other']").dblclick();
  await expect(page.locator("#dialogTitle")).toHaveText("Local changes in the way");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#branchPill")).toHaveText("⎇ other");
  await expect(page.locator("#stashList li[data-stash='0']")).toContainText("auto-stash before checkout other");
});

test("fetch, pull and push with a remote", async ({ page, makeRepo, openRepo }) => {
  const remote = makeRepo("remote.git", { bare: true });
  const repo = makeRepo("local");
  repo.commit("init", { "a.txt": "a\n" });
  repo.git("remote", "add", "origin", remote.dir);
  repo.git("push", "-q", "-u", "origin", "main");
  // Someone else pushes a commit.
  const other = makeRepo("other");
  other.git("remote", "add", "origin", remote.dir);
  other.git("pull", "-q", "origin", "main");
  other.commit("their change", { "b.txt": "b\n" });
  other.git("push", "-q", "origin", "main");

  await openRepo(repo);
  await page.locator("#btnFetch").click();
  await expect(page.locator("#syncPill")).toHaveText("↓1");
  await expect(page.locator("#fetchInfo")).toContainText("fetched");

  await page.locator("#btnPull").click();
  await toast(page, "pull");
  expect(repo.log("%s", "-1")).toEqual(["their change"]);

  repo.write("c.txt", "c\n");
  await page.locator(".row.wip").click();
  await page.locator("#btnStageAll").click();
  await page.locator("#commitMsg").fill("my change");
  await page.locator("#btnCommit").click();
  await expect(page.locator("#syncPill")).toHaveText("↑1");
  await page.locator("#btnPush").click();
  await toast(page, "push");
  expect(remote.log("%s", "-1", "main")).toEqual(["my change"]);
  await expect(page.locator("#syncPill")).toBeHidden();

  // A new branch is published with an upstream on first push.
  await page.locator("#btnBranch").click();
  await page.locator("#dlg_name").fill("topic");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#syncPill")).toHaveText("not published");
  await page.locator("#btnPush").click();
  await expect(page.locator("#syncPill")).toBeHidden();
  expect(remote.git("branch", "--format=%(refname:short)")).toContain("topic");
});

test("cherry-pick, revert and reset from the commit menu", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  repo.commit("init", { "a.txt": "a\n" });
  repo.git("switch", "-q", "-c", "side");
  const picked = repo.commit("side change", { "side.txt": "s\n" });
  repo.git("switch", "-q", "main");
  const second = repo.commit("second", { "b.txt": "b\n" });
  await openRepo(repo);

  await page.locator(`.row[data-sha="${picked}"]`).click({ button: "right" });
  await menu(page, "Cherry-pick onto main");
  await toast(page, "cherry-pick");
  expect(repo.log("%s", "-1")).toEqual(["side change"]);

  await page.locator(`.row[data-sha="${second}"]`).click({ button: "right" });
  await menu(page, "Revert this commit…");
  await page.locator("#dialogOk").click();
  await toast(page, "revert");
  expect(repo.log("%s", "-1")).toEqual(['Revert "second"']);
  expect(repo.exists("b.txt")).toBe(false);

  await page.locator(`.row[data-sha="${second}"]`).click({ button: "right" });
  await menu(page, "Reset main to here…");
  await page.locator("#dlg_mode").selectOption({ label: "hard — throw the changes away" });
  await page.locator("#dialogOk").click();
  await expect.poll(() => repo.head()).toBe(second);
});

test("remotes: add, rename, remove", async ({ page, makeRepo, openRepo }) => {
  const remote = makeRepo("upstream.git", { bare: true });
  const repo = makeRepo("local");
  repo.commit("init");
  await openRepo(repo);

  await page.locator("#btnAddRemote").click();
  await page.locator("#dlg_name").fill("upstream");
  await page.locator("#dlg_url").fill(remote.dir);
  await page.locator("#dialogOk").click();
  await expect(page.locator("#remoteList li[data-remote='upstream']")).toBeVisible();
  expect(repo.git("remote").trim()).toBe("upstream");

  await page.locator("#remoteList li[data-remote='upstream']").click();
  await menu(page, "Rename…");
  await page.locator("#dlg_n").fill("up2");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#remoteList li[data-remote='up2']")).toBeVisible();

  await page.locator("#remoteList li[data-remote='up2']").click();
  await menu(page, "Remove up2…");
  await page.locator("#dialogOk").click();
  await expect(page.locator("#remoteList li[data-remote]")).toHaveCount(0);
});

test("header links to the repository's web page and folder", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  repo.commit("Initial");
  await openRepo(repo);
  await expect(page.locator("#btnFolder")).toBeVisible();
  await expect(page.locator("#btnWeb")).toBeHidden(); // no remote yet

  repo.git("remote", "add", "origin", "git@github.com:someone/demo.git");
  await page.locator("#btnRefresh").click();
  await expect(page.locator("#btnWeb")).toHaveText("↗GitHub");
  await expect(page.locator("#btnWeb")).toHaveAttribute("href", "https://github.com/someone/demo");

  // Don't really open a file manager during tests: just check the request.
  let revealed = false;
  await page.route("**/api/repos/*/reveal", (route) => {
    revealed = true;
    route.fulfill({ json: { opened: repo.dir } });
  });
  await page.locator("#btnFolder").click();
  await expect.poll(() => revealed).toBe(true);
});

test("an update alert appears when a new version is out", async ({ page, makeRepo, openRepo }) => {
  // Development builds never ask GitHub, so pretend it answered.
  await page.route("**/api/update", (route) =>
    route.fulfill({ json: { current: "0.1.2", latest: "9.9.9", available: true, can_install: true, url: "https://github.com/ErmanDev/DevTree/releases/tag/v9.9.9" } }));
  let installs = 0;
  let finish;
  await page.route("**/api/update/install", (route) => {
    installs++;
    finish = () => route.fulfill({ json: { installed: "9.9.9" } });
  });
  await page.route("**/api/update/progress", (route) =>
    route.fulfill({ json: { downloading: true, received: 1048576, total: 4194304 } }));
  const repo = makeRepo();
  repo.commit("Initial");
  await openRepo(repo);

  await expect(page.locator("#dialogTitle")).toHaveText("Update available");
  await expect(page.locator("#dialogBody")).toContainText("DevTree 9.9.9 is available (you have 0.1.2)");
  await expect(page.locator("#dialogCancel")).toHaveText("Later");
  await page.locator("#dialogOk").click();
  await expect.poll(() => installs).toBe(1);
  const card = page.locator("#jobs .job", { hasText: "update to v9.9.9" });
  await expect(card.locator(".job-phase")).toContainText("1.0 / 4.0 MB · 25%");
  finish();
  await expect(card.locator(".job-phase")).toHaveText("Installed. Restarting…");
});

test("the bottom bar shows DevTree's version", async ({ page, makeRepo, openRepo }) => {
  const version = require("fs").readFileSync(require("path").join(__dirname, "../../../Cargo.toml"), "utf8").match(/^version = "(.+)"/m)[1];
  const repo = makeRepo();
  repo.commit("Initial");
  await openRepo(repo);
  const label = page.locator("#appVersion");
  await expect(label).toHaveText(`v${version}`);
  await expect(label).toHaveAttribute("href", `https://github.com/ErmanDev/DevTree/releases/tag/v${version}`);
  await page.evaluate(() => document.getElementById("appVersion").addEventListener("click", (e) => e.preventDefault()));
  await label.click();
  await expect(page.locator("#console")).not.toHaveClass(/open/); // the link doesn't toggle the console
});
