// Partial staging builds patches in the browser (web/diff.js); check them against real git.
// No browser needed: diff.js also loads under Node.
const { test, expect } = require("../support/fixtures");
const Diff = require("../../../web/diff.js");

function keysWhere(parsed, pred) {
  const out = new Set();
  parsed.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if (pred(l)) out.add(`${hi}:${li}`); }));
  return out;
}

function apply(repo, patch, ...flags) {
  const { execFileSync } = require("node:child_process");
  execFileSync("git", ["-C", repo.dir, "apply", "--recount", ...flags, "-"], { input: patch, env: repo.env });
}

test.describe("partial staging patches", () => {
  let repo;
  const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

  test.beforeEach(({ makeRepo }) => {
    repo = makeRepo();
    repo.commit("base", { "f.txt": base.join("\n") + "\n" });
    const lines = [...base];
    lines[2] = "line 3 CHANGED";
    lines.splice(25, 0, "new A", "new B");
    lines.splice(9, 1); // delete line 10
    repo.write("f.txt", lines.join("\n") + "\n");
  });

  test("stage selected lines across two hunks", () => {
    const parsed = Diff.parse(repo.git("diff", "--", "f.txt"));
    expect(parsed.hunks.length).toBe(2);
    const sel = keysWhere(parsed, (l) => (l.type === "add" && l.text === "new A") || (l.type === "del" && l.text === "line 10"));
    apply(repo, Diff.buildPatch(parsed, sel, false), "--cached");
    const index = repo.git("show", ":f.txt");
    expect(index).toContain("new A\n");
    expect(index).not.toContain("new B");
    expect(index).not.toContain("line 10\n");
    expect(index).toContain("line 3\n");
  });

  test("unstage one line and discard another", () => {
    let parsed = Diff.parse(repo.git("diff", "--", "f.txt"));
    apply(repo, Diff.buildPatch(parsed, new Set(Diff.changedKeys(parsed)), false), "--cached");
    expect(repo.git("diff", "--", "f.txt")).toBe("");

    parsed = Diff.parse(repo.git("diff", "--cached", "--", "f.txt"));
    apply(repo, Diff.buildPatch(parsed, keysWhere(parsed, (l) => l.text === "line 10"), true), "--cached", "--reverse");
    expect(repo.git("show", ":f.txt")).toContain("line 10\n");
    expect(repo.git("show", ":f.txt")).toContain("new A\n");

    // Worktree still lacks line 10 -> unstaged diff deletes it; discard that deletion.
    parsed = Diff.parse(repo.git("diff", "--", "f.txt"));
    apply(repo, Diff.buildPatch(parsed, keysWhere(parsed, (l) => l.text === "line 10"), true), "--reverse");
    expect(repo.read("f.txt")).toContain("line 10\n");
  });

  test("a partial selection inside one change block keeps line order", () => {
    repo.commit("abc", { "g.txt": "a\nb\nc" });
    repo.write("g.txt", "a\nB\nc\nd");
    const parsed = Diff.parse(repo.git("diff", "--", "g.txt"));
    apply(repo, Diff.buildPatch(parsed, keysWhere(parsed, (l) => l.text === "B" || l.text === "b"), false), "--cached");
    expect(repo.git("show", ":g.txt")).toBe("a\nB\nc");
  });
});

test("word diff marks only the changed token", () => {
  const [, after] = Diff.wordDiff("let total = price * qty;", "let total = price * quantity;");
  expect(after.filter((s) => s.changed).map((s) => s.text)).toEqual(["quantity"]);
  expect(Diff.wordDiff("    let done = true;", '    println!("answer = {}", answer);')).toBeNull();
});

test("syntax highlighting", () => {
  expect(Diff.highlight('let x = "hi"; // note', Diff.langFor("a.rs"))).toBe(
    '<span class="tk-k">let</span> x = <span class="tk-s">&quot;hi&quot;</span>; <span class="tk-c">// note</span>',
  );
  expect(Diff.highlight("<b>", Diff.langFor("notes.txt"))).toBe("&lt;b&gt;");
});
