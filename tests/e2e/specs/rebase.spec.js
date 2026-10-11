// Interactive rebase: the editor, validation, and rewording across a conflict pause.
const { test, expect, menu } = require("../support/fixtures");

function linear(makeRepo, n = 5) {
  const repo = makeRepo();
  repo.commit("commit 0", { "f0.txt": "0\n" });
  for (let i = 1; i <= n; i++) repo.commit(`commit ${i}`, { [`f${i}.txt`]: `${i}\n` });
  return repo;
}

test("reorder, reword, squash and drop from the editor", async ({ page, makeRepo, openRepo }) => {
  const repo = linear(makeRepo, 4);
  const base = repo.head("HEAD~4");
  await openRepo(repo);

  await page.locator(`.row[data-sha="${base}"]`).click({ button: "right" });
  await menu(page, "Interactive rebase from here");
  const rows = page.locator(".rb-list li");
  await expect(rows.locator(".rb-msg")).toHaveText(["commit 1", "commit 2", "commit 3", "commit 4"]);
  await expect(page.locator("#rbStart")).toBeDisabled(); // nothing changed yet

  await page.locator("[data-rb-action='0']").selectOption("squash");
  await expect(page.locator("#rbSummary")).toContainText("can't be squashed");
  await expect(page.locator("#rbStart")).toBeDisabled();
  await page.locator("[data-rb-action='0']").selectOption("drop");

  await page.locator("[data-rb-action='1']").selectOption("reword");
  await expect(page.locator("[data-rb-msg='1']")).toHaveValue("commit 2");
  await page.locator("[data-rb-msg='1']").fill("Commit two, reworded\n\nwith a body");
  await page.locator("[data-rb-action='2']").selectOption("fixup");
  // Move "commit 4" above "commit 2" with drag & drop.
  await page.locator(".rb-handle").nth(3).dragTo(rows.nth(1));
  expect(await rows.locator("select").evaluateAll((els) => els.map((e) => e.value))).toEqual(["drop", "pick", "reword", "fixup"]);
  await expect(page.locator("#rbSummary")).toHaveText("1 reword · 1 fixup · 1 drop · reordered");

  await page.locator("#rbStart").click();
  await expect(page.locator("#rebaseModal")).toBeHidden();
  // Wait for the whole rebase: with a fixup after the reword, git may already show the new
  // message while the fixup step is still running.
  await expect
    .poll(() => ({ running: repo.exists(".git/rebase-merge"), log: repo.log("%s") }), { timeout: 15000 })
    .toEqual({ running: false, log: ["Commit two, reworded", "commit 4", "commit 0"] });
  expect(repo.git("log", "-1", "--format=%b").trim()).toBe("with a body");
  expect(repo.exists("f1.txt")).toBe(false); // dropped
  expect(repo.exists("f3.txt")).toBe(true); // fixup'd into commit 2
});

test("reworded messages survive a conflict pause and continue", async ({ api, makeRepo }) => {
  const repo = makeRepo();
  repo.commit("base", { "x.txt": "x\n" });
  repo.commit("shared v1", { "shared.txt": "one\n" });
  repo.commit("shared v2", { "shared.txt": "two\n" });
  repo.commit("other file", { "other.txt": "o\n" });
  const base = repo.head("HEAD~3");
  const { body: r } = await api("POST", "/repos", { path: repo.dir });
  const id = r.id;
  const { body: plan } = await api("GET", `/repos/${id}/rebase/plan?base=${base}`);
  const sha = Object.fromEntries(plan.commits.map((c) => [c.subject, c.sha]));

  // Swapping v1 and v2 conflicts twice; the reword of "other file" comes afterwards.
  const start = await api("POST", `/repos/${id}/rebase/interactive`, {
    base,
    steps: [
      { sha: sha["shared v2"], action: "pick" },
      { sha: sha["shared v1"], action: "pick" },
      { sha: sha["other file"], action: "reword", message: "Other file, reworded after conflicts" },
    ],
  });
  expect(start.status).toBe(422);
  for (let round = 0; round < 3; round++) {
    const { body: st } = await api("GET", `/repos/${id}/status`);
    if (!st.operation) break;
    for (const f of st.files.filter((f) => f.conflicted)) await api("POST", `/repos/${id}/resolve`, { path: f.path, side: "theirs" });
    await api("POST", `/repos/${id}/operation/continue`);
  }
  expect((await api("GET", `/repos/${id}/status`)).body.operation).toBeNull();
  expect(repo.log("%s")).toEqual(["Other file, reworded after conflicts", "shared v1", "shared v2", "base"]);
  expect(repo.exists(".git/devtree-reword.json")).toBe(false);
});

test("the plan must list every commit", async ({ api, makeRepo }) => {
  const repo = linear(makeRepo, 2);
  const { body: r } = await api("POST", "/repos", { path: repo.dir });
  const res = await api("POST", `/repos/${r.id}/rebase/interactive`, { base: repo.head("HEAD~2"), steps: [{ sha: repo.head(), action: "pick" }] });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("every commit");
  expect(repo.log("%s")).toEqual(["commit 2", "commit 1", "commit 0"]);
});
