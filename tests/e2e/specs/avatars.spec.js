// Author chips: pictures from Gravatar / GitHub (faked here), initials fallback, committer marker.
const { test, expect } = require("../support/fixtures");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

/** A solid-colour square PNG. */
function png(size, [r, g, b]) {
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
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const ADA = "ada@example.com";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Serves fake pictures: Ada has a Gravatar, Grace doesn't, any GitHub id does. Records requests. */
async function fakeAvatarServices(page) {
  const requests = [];
  await page.route("https://www.gravatar.com/avatar/**", (route) => {
    requests.push(route.request().url());
    const hash = new URL(route.request().url()).pathname.split("/").pop();
    if (hash === sha256(ADA)) return route.fulfill({ status: 200, contentType: "image/png", body: png(16, [70, 130, 180]) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route("https://avatars.githubusercontent.com/**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/png", body: png(16, [120, 60, 160]) });
  });
  await page.route("https://github.com/*.png*", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/png", body: png(16, [60, 160, 90]) });
  });
  return requests;
}

function teamRepo(makeRepo) {
  const repo = makeRepo();
  // --author sets the author; the committer stays "Test User" from the test git config.
  repo.write("a.txt", "1\n").git("add", "-A");
  repo.git("commit", "-q", "-m", "Ada's work", "--author", `Ada Lovelace <${ADA}>`);
  repo.write("b.txt", "2\n").git("add", "-A");
  repo.git("commit", "-q", "-m", "Grace's work", "--author", "Grace Hopper <grace@example.com>");
  repo.write("c.txt", "3\n").git("add", "-A");
  repo.git("commit", "-q", "-m", "Octocat's work", "--author", "Octo Cat <583231+octocat@users.noreply.github.com>");
  repo.commit("My own work", { "d.txt": "4\n" }); // author == committer
  return repo;
}

test("graph rows show author chips with pictures or initials", async ({ page, makeRepo, openRepo }) => {
  await fakeAvatarServices(page);
  const repo = teamRepo(makeRepo);
  await openRepo(repo);

  const chip = (subject) => page.locator(".row", { hasText: subject }).locator(".author-chip");
  // Ada: Gravatar picture, looked up by SHA-256 of the email.
  await expect(chip("Ada's work").locator(".an")).toHaveText("Ada Lovelace");
  await expect(chip("Ada's work").locator("img")).toHaveAttribute("src", `https://www.gravatar.com/avatar/${sha256(ADA)}?s=64&d=404`);
  await expect.poll(() => chip("Ada's work").locator("img").evaluate((i) => i.naturalWidth)).toBe(16);
  // Grace: Gravatar has nothing (404) -> picture removed, initials remain.
  await expect(chip("Grace's work").locator("img")).toHaveCount(0);
  await expect(chip("Grace's work").locator(".av-i")).toHaveText("GH");
  // GitHub noreply address -> GitHub avatar by user id, no Gravatar lookup.
  await expect(chip("Octocat's work").locator("img")).toHaveAttribute("src", /avatars\.githubusercontent\.com\/u\/583231/);
  // Pictures in the graph nodes too, but only those that exist (Ada and Octocat): a missing
  // one would show a broken-image icon in SVG.
  await expect(page.locator("#graphSvg image")).toHaveCount(2);

  // Committer differs from author -> marked; own commit isn't.
  await expect(chip("Ada's work").locator(".committed-by")).toHaveAttribute("title", "committed by Test User <test@example.com>");
  await expect(chip("My own work").locator(".committed-by")).toHaveCount(0);
});

test("commit details show author and committer", async ({ page, makeRepo, openRepo }) => {
  await fakeAvatarServices(page);
  const repo = teamRepo(makeRepo);
  await openRepo(repo);
  await page.locator(".row", { hasText: "Ada's work" }).click();
  const people = page.locator("#detail dd.person");
  await expect(people).toHaveCount(2);
  await expect(people.nth(0)).toContainText("Ada Lovelace");
  await expect(people.nth(0)).toContainText(ADA);
  await expect(people.nth(1)).toContainText("Test User");
  await expect(people.nth(0).locator("img")).toHaveCount(1);

  await page.locator(".row", { hasText: "My own work" }).click();
  await expect(page.locator("#detail dd.person")).toHaveCount(1); // same person: no committer row
});

test("switching pictures off fetches nothing", async ({ page, makeRepo, openRepo }) => {
  const requests = await fakeAvatarServices(page);
  const repo = teamRepo(makeRepo);
  await openRepo(repo);
  await expect(page.locator(".row .author-chip img").first()).toBeVisible();

  await page.locator("#btnAvatars").click();
  await expect(page.locator(".row .author-chip img")).toHaveCount(0);
  await expect(page.locator("#graphSvg image")).toHaveCount(0);
  await expect(page.locator(".row", { hasText: "Ada's work" }).locator(".av-i")).toHaveText("AL");

  // Stays off after a reload, and no picture requests are made.
  requests.length = 0;
  await page.reload();
  await expect(page.locator(".row[data-sha]").first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
  await expect(page.locator("#btnAvatars")).not.toHaveClass(/\bon\b/);
});
