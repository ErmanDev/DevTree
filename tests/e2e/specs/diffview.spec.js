// The diff viewer: syntax colours, word marks, split view, whitespace, images and line staging.
const { test, expect } = require("../support/fixtures");
const zlib = require("node:zlib");

/** A solid-colour PNG of the given size. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function rustRepo(makeRepo) {
  const repo = makeRepo();
  const lines = ["use std::io;", "", "fn add(a: i32, b: i32) -> i32 {", "    a + b", "}", ""];
  for (let i = 0; i < 15; i++) lines.push(`fn helper_${i}() -> u32 { ${i} }`);
  lines.push("", "fn main() {", "    let total = add(2, 3);");
  for (let i = 0; i < 15; i++) lines.push(`    let v${i} = helper_${i}();`);
  lines.push("    let unused = 42;", "}", "");
  repo.commit("program", { "main.rs": lines.join("\n"), "logo.png": png(32, 32, [217, 119, 87]) });
  const changed = lines.join("\n")
    .replace("fn add(a: i32, b: i32) -> i32 {", "fn add(a: i64, b: i64) -> i64 {")
    .replace("    let v7 = helper_7();", "        let v7 = helper_7();")
    .replace("    let unused = 42;", "    let answer = 42;\n    println!(\"{}\", answer);");
  repo.write("main.rs", changed).write("logo.png", png(48, 24, [227, 180, 72]));
  return repo;
}

test("syntax colours, word marks, split view and whitespace toggle", async ({ page, makeRepo, openRepo }) => {
  const repo = rustRepo(makeRepo);
  await openRepo(repo);
  await page.locator(".row.wip").click();
  await page.locator("li[data-wdiff='main.rs']").click();

  await expect(page.locator(".diff-body .hunk")).toHaveCount(3);
  expect(await page.locator(".tk-k").count()).toBeGreaterThan(5);
  await expect(page.locator(".diff-body .del mark").first()).toHaveText("i32");
  await expect(page.locator(".diff-body .add mark").first()).toHaveText("i64");

  await page.locator("[data-dv='split']").click();
  await expect(page.locator(".diff-body .split")).toHaveCount(3);
  await page.locator("[data-dv='split']").click();

  const added = await page.locator(".diff-body .ln.add").count();
  await page.locator("[data-dv='ws']").click();
  await expect(page.locator(".diff-body .ln.add")).toHaveCount(added - 1); // the re-indented line
  await expect(page.locator(".selectable")).toHaveCount(0); // no line staging on a -w diff
  await page.locator("[data-dv='ws']").click();
});

test("stage a single line and a hunk, unstage a line, discard a hunk", async ({ page, makeRepo, openRepo }) => {
  const repo = rustRepo(makeRepo);
  await openRepo(repo);
  await page.locator(".row.wip").click();
  await page.locator("li[data-wdiff='main.rs']").click();

  // Select just the "answer" line.
  await page.locator(".ln.add.selectable", { hasText: "let answer" }).click();
  await page.locator("[data-dv='stage-sel']").click();
  await expect.poll(() => repo.git("diff", "--cached", "--", "main.rs")).toContain("+    let answer = 42;");
  expect(repo.git("diff", "--cached", "--", "main.rs")).not.toContain("println");

  await page.locator("[data-dv='stage-hunk'][data-h='0']").click();
  await expect.poll(() => repo.git("diff", "--cached", "--", "main.rs")).toContain("+fn add(a: i64");

  // Discard the re-indent hunk (now hunk 0 of the unstaged diff).
  const hunk = page.locator(".diff-body .hunk", { has: page.locator("[data-dv='discard-hunk']") }).filter({ hasText: "fn main" }).first();
  await hunk.locator("[data-dv='discard-hunk']").click();
  await page.locator("#dialogOk").click();
  await expect.poll(() => repo.read("main.rs")).toContain("\n    let v7 = helper_7();");

  // Unstage the add() change from the staged diff.
  await page.locator("#btnCloseDiff").click();
  await page.locator("li[data-wdiff='main.rs'][data-staged='true']").click();
  await page.locator(".ln.add.selectable", { hasText: "fn add" }).click();
  await page.locator(".ln.del.selectable", { hasText: "fn add" }).click();
  await page.locator("[data-dv='unstage-sel']").click();
  await expect.poll(() => repo.git("diff", "--cached", "--", "main.rs")).not.toContain("fn add");
  expect(repo.git("diff", "--cached", "--", "main.rs")).toContain("let answer");
});

test("image files show before and after", async ({ page, makeRepo, openRepo }) => {
  const repo = rustRepo(makeRepo);
  await openRepo(repo);
  await page.locator(".row.wip").click();
  await page.locator("li[data-wdiff='logo.png']").click();
  await expect(page.locator(".img-dim")).toHaveText(["32 × 32", "48 × 24"]);
});

test("commit diffs follow renames", async ({ page, makeRepo, openRepo }) => {
  const repo = makeRepo();
  repo.commit("add", { "old.txt": "one\ntwo\nthree\nfour\nfive\n" });
  repo.git("mv", "old.txt", "new.txt");
  repo.write("new.txt", "one\ntwo\nTHREE\nfour\nfive\n");
  repo.commit("rename and edit");
  await openRepo(repo);
  await page.locator(".row", { hasText: "rename and edit" }).click();
  await page.locator("li[data-cdiff='new.txt']").click();
  await expect(page.locator(".meta-block")).toContainText("rename from old.txt");
  await expect(page.locator(".diff-body .ln.add")).toHaveCount(1);
});
