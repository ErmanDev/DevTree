// The server runs git on your machine: these guards must hold.
const { test, expect } = require("../support/fixtures");

test("API calls need the X-DevTree header", async ({ server }) => {
  const res = await fetch(`${server.url}/api/repos`);
  expect(res.status).toBe(403);
});

test("requests for a non-local Host are refused (DNS rebinding)", async ({ server }) => {
  // fetch() won't let us override Host, so speak HTTP directly.
  const net = require("node:net");
  const port = new URL(server.url).port;
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(+port, "127.0.0.1", () => sock.write("GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"));
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
  });
  expect(reply).toMatch(/^HTTP\/1\.1 403/);
});

test("option-looking names, unsafe URLs and escaping paths are rejected", async ({ api, makeRepo }) => {
  const repo = makeRepo();
  repo.commit("init", { "a.txt": "a\n" });
  const { body: r } = await api("POST", "/repos", { path: repo.dir });
  const id = r.id;

  for (const [route, body] of [
    ["/checkout", { name: "--orphan" }],
    ["/branch", { name: "-D" }],
    ["/remote/add", { name: "x", url: "--upload-pack=touch pwned" }],
    ["/merge", { name: "--abort" }],
    ["/rebase", { onto: "-i" }],
  ]) {
    const res = await api("POST", `/repos/${id}${route}`, body);
    expect(res.status, `${route} ${JSON.stringify(body)}`).toBe(400);
  }
  expect((await api("GET", `/repos/${id}/file?path=..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
  expect((await api("GET", `/repos/${id}/compare?from=--output=x&to=main`)).status).toBe(400);
  // The conflict editor may only write files that are actually conflicted.
  expect((await api("POST", `/repos/${id}/file`, { path: "a.txt", content: "x" })).status).toBe(400);
  expect(repo.read("a.txt")).toBe("a\n");
});

test("file previews are served with a sandboxing CSP", async ({ server, api, makeRepo }) => {
  const repo = makeRepo();
  repo.commit("svg", { "x.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
  const { body: r } = await api("POST", "/repos", { path: repo.dir });
  const res = await fetch(`${server.url}/api/repos/${r.id}/blob?rev=HEAD&path=x.svg`, { headers: { "X-DevTree": "1" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain("sandbox");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});
