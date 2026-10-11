// Shared by the documentation screenshots and the promo video recordings: a demo project with
// several authors, and offline avatars.
const crypto = require("node:crypto");

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

module.exports = { PEOPLE, fakeAvatars, demoRepo };
