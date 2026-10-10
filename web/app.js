"use strict";

// ---------------------------------------------------------------- constants & state

const LANE_W = 20;
const GRAPH_PAD = 14;
const ROW_H = 30;
const NODE_R = 7;
const MAX_GRAPH_W = 420;
const PAGE = 1000;
// Warm retro lane colours, led by Claude orange.
const LANES = ["#d97757", "#e3b448", "#8fb573", "#6fa3c7", "#c774a0", "#a08bd6", "#e08e45", "#5fb3a1", "#d4a373", "#b5bd68"];
const laneColor = (i) => LANES[i % LANES.length];

const state = {
  repos: [],
  repo: null,          // current repo object
  rows: [],            // graph rows from the server
  width: 0,
  truncated: false,
  limit: PAGE,
  status: null,
  statusSig: "",
  branches: [],
  remotes: [],
  selected: null,      // sha or "WIP"
  filter: "",
  draft: "",
  amend: false,
  pullMode: "merge",
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- api

async function api(method, path, body) {
  const opts = { method, headers: { "X-DevTree": "1" } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch("/api" + path, opts);
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const repoApi = (method, path, body) => api(method, `/repos/${state.repo.id}${path}`, body);

// ---------------------------------------------------------------- console & toasts

function log(text, cls = "") {
  const body = $("consoleBody");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  if (cls === "cmd" || cls === "err") $("consoleLast").textContent = text.split("\n")[0];
}

function logOutput(out) {
  if (!out || !out.command) return;
  log(`$ ${out.command}`, "cmd");
  // Progress output redraws lines with \r: keep only the final state of each line.
  const text = [out.stdout, out.stderr].filter((s) => s && s.trim()).join("\n")
    .split("\n").map((l) => l.split("\r").filter((p) => p.trim()).pop() || "").join("\n").trim();
  if (text) log(text);
}

function toast(msg, error = false) {
  const t = document.createElement("div");
  t.className = "toast" + (error ? " error" : "");
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), error ? 9000 : 3500);
}

function fail(e, what) {
  const msg = e && e.message ? e.message : String(e);
  log(`✗ ${what}: ${msg}`, "err");
  toast(`${what} failed\n${msg.slice(0, 400)}`, true);
  $("console").classList.add("open");
}

/** Runs an action with a button showing busy state; logs output; refreshes afterwards. */
async function run(btn, what, fn, { refresh = true } = {}) {
  if (btn) { btn.classList.add("busy"); btn.disabled = true; }
  log(`▸ ${what}…`, "cmd");
  try {
    const out = await fn();
    if (out && out.output) logOutput(out.output); else logOutput(out);
    log(`✓ ${what}`, "okl");
    toast(`✓ ${what}`);
    if (refresh) await reload();
    return out;
  } catch (e) {
    fail(e, what);
    if (refresh) await reload().catch(() => {});
  } finally {
    if (btn) { btn.classList.remove("busy"); btn.disabled = false; }
  }
}

// ---------------------------------------------------------------- formatting

function relTime(ts) {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
const fullTime = (ts) => new Date(ts * 1000).toLocaleString();

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// ---------------------------------------------------------------- repositories

async function loadRepos() {
  state.repos = await api("GET", "/repos");
  renderRepos();
}

function renderRepos() {
  const ul = $("repoList");
  if (!state.repos.length) {
    ul.innerHTML = `<li class="empty-note">none yet</li>`;
    return;
  }
  ul.innerHTML = state.repos
    .map((r) => `<li data-id="${esc(r.id)}" class="${state.repo && state.repo.id === r.id ? "active" : ""}" title="${esc(r.path)}">
      <span>▤</span><span class="name">${esc(r.name)}</span>
      <button class="x" data-remove="${esc(r.id)}" title="Remove from DevTree (files are kept)">✕</button></li>`)
    .join("");
}

async function openRepo(id) {
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) return;
  state.repo = repo;
  state.selected = null;
  state.limit = PAGE;
  state.statusSig = "";
  state.draft = "";
  try { localStorage.setItem("devtree.repo", id); } catch {}
  renderRepos();
  $("repoName").textContent = repo.name;
  $("repoName").title = repo.path;
  closeDiff();
  $("detail").innerHTML = `<div class="detail-empty">Loading…</div>`;
  await reload();
  // Start with the working tree when there are changes, otherwise the HEAD commit.
  if (!state.selected) {
    if (hasWip()) selectWip();
    else if (state.rows.length) selectCommit(state.status?.head || state.rows[0].sha);
    else $("detail").innerHTML = `<div class="detail-empty">This repository has no commits yet.</div>`;
  }
}

async function removeRepo(id) {
  const r = state.repos.find((x) => x.id === id);
  if (!r || !confirm(`Remove "${r.name}" from DevTree?\n\nThe folder on disk is not touched.`)) return;
  await api("DELETE", `/repos/${id}`);
  if (state.repo && state.repo.id === id) {
    state.repo = null;
    state.rows = [];
    state.status = null;
    renderEmpty();
  }
  await loadRepos();
}

function renderEmpty() {
  $("repoName").textContent = "no repository";
  $("branchPill").hidden = true;
  $("syncPill").hidden = true;
  $("refsSection").hidden = true;
  $("rows").innerHTML = "";
  $("graphSvg").innerHTML = "";
  $("empty").hidden = false;
  $("loadMore").hidden = true;
  $("detail").innerHTML = `<div class="detail-empty">Select a commit to see its details.</div>`;
  setToolbarEnabled(false);
}

function setToolbarEnabled(on) {
  for (const id of ["btnFetch", "btnPull", "btnPullMode", "btnPush", "btnBranch", "btnRefresh"]) $(id).disabled = !on;
}

// ---------------------------------------------------------------- loading

async function reload() {
  if (!state.repo) return;
  const id = state.repo.id;
  const [graph, status, refs] = await Promise.all([
    repoApi("GET", `/graph?limit=${state.limit}`),
    repoApi("GET", "/status"),
    repoApi("GET", "/branches"),
  ]);
  if (!state.repo || state.repo.id !== id) return; // switched repo meanwhile
  state.rows = graph.rows;
  state.width = graph.width;
  state.truncated = graph.truncated;
  state.branches = refs.branches;
  state.remotes = refs.remotes;
  applyStatus(status, true);
  setToolbarEnabled(true);
  renderRefs();
  renderGraph();
  if (state.selected === "WIP") renderWip();
}

function applyStatus(status, force) {
  const sig = JSON.stringify(status);
  if (!force && sig === state.statusSig) return false;
  state.status = status;
  state.statusSig = sig;
  renderHeaderStatus();
  return true;
}

function renderHeaderStatus() {
  const st = state.status;
  const bp = $("branchPill");
  bp.hidden = false;
  bp.textContent = st.branch ? `⎇ ${st.branch}` : `detached @ ${(st.head || "").slice(0, 7)}`;
  const sp = $("syncPill");
  const bits = [];
  if (st.ahead) bits.push(`↑${st.ahead}`);
  if (st.behind) bits.push(`↓${st.behind}`);
  if (st.branch && !st.upstream) bits.push("not published");
  sp.hidden = !bits.length;
  sp.textContent = bits.join(" ");
  sp.title = st.upstream ? `tracking ${st.upstream}` : "no upstream branch";
}

const hasWip = () => !!(state.status && state.status.files.length);

// Poll the working tree so the WIP row and file lists stay current.
async function poll() {
  if (!state.repo || document.hidden) return;
  try {
    const status = await repoApi("GET", "/status");
    const prev = state.status;
    if (!applyStatus(status, false)) return;
    if (!prev || prev.head !== status.head || prev.branch !== status.branch) {
      await reload();
    } else {
      renderGraph();
      if (state.selected === "WIP") renderWip();
      if (state.selected === "WIP" && !hasWip()) selectCommit(status.head);
    }
  } catch { /* ignore transient errors while polling */ }
}

// ---------------------------------------------------------------- sidebar refs

function renderRefs() {
  $("refsSection").hidden = false;
  const by = (k) => state.branches.filter((b) => b.kind === k);
  const local = by("local"), remote = by("remote"), tags = by("tag");
  $("localCount").textContent = local.length;
  $("remoteCount").textContent = remote.length;
  $("tagCount").textContent = tags.length;
  const item = (b) => {
    const track = b.track ? ` <span class="meta">${esc(b.track.replace(/[\[\]]/g, ""))}</span>` : "";
    return `<li class="${b.current ? "current" : ""}" data-ref="${esc(b.name)}" data-kind="${b.kind}" data-sha="${esc(b.sha)}" title="${esc(b.name)}${b.upstream ? " → " + esc(b.upstream) : ""}">
      <span class="name">${esc(b.name)}</span>${track}</li>`;
  };
  const none = `<li class="empty-note">none</li>`;
  $("localList").innerHTML = local.map(item).join("") || none;
  $("remoteList").innerHTML = remote.map(item).join("") || none;
  $("tagList").innerHTML = tags.map(item).join("") || none;
}

// ---------------------------------------------------------------- graph rendering

function laneX(col) {
  return GRAPH_PAD + col * LANE_W;
}

function renderGraph() {
  const rows = state.rows;
  const wip = hasWip();
  const off = wip ? 1 : 0;
  $("empty").hidden = true;
  if (state.repo && !rows.length && !wip) {
    $("rows").innerHTML = `<div class="empty"><p>No commits yet. Make some changes and commit them.</p></div>`;
    $("graphSvg").innerHTML = "";
    $("loadMore").hidden = true;
    return;
  }

  const graphW = Math.min(MAX_GRAPH_W, Math.max(90, GRAPH_PAD * 2 + Math.max(state.width - 1, 0) * LANE_W + 8));
  document.documentElement.style.setProperty("--graph-w", graphW + "px");

  // Ref badges get the colour of the lane they sit on.
  const html = [];
  const headRow = rows.findIndex((r) => r.sha === state.status?.head);
  if (wip) {
    const f = state.status.files;
    const staged = f.filter((x) => x.index !== "." && !x.untracked).length;
    html.push(`<div class="row wip ${state.selected === "WIP" ? "selected" : ""}" data-sha="WIP">
      <div class="col-graph"></div>
      <div class="col-msg"><span class="ref current" style="--c:${laneColor(headRow >= 0 ? rows[headRow].color : 0)}">WIP</span>
        <span class="subject">${f.length} changed file${f.length === 1 ? "" : "s"}${staged ? ` · ${staged} staged` : ""}</span></div>
      <div class="col-author"></div><div class="col-date"></div><div class="col-sha">// // //</div></div>`);
  }
  const filter = state.filter.toLowerCase();
  for (const r of rows) {
    const c = laneColor(r.color);
    const refs = r.refs
      .map((ref) => `<span class="ref ${ref.kind}${ref.current ? " current" : ""}" style="--c:${c}" title="${esc(ref.kind)}: ${esc(ref.name)}">${esc(ref.name)}</span>`)
      .join("");
    const match = !filter || r.subject.toLowerCase().includes(filter) || r.author.toLowerCase().includes(filter) || r.sha.startsWith(filter);
    html.push(`<div class="row${state.selected === r.sha ? " selected" : ""}${match ? "" : " dim"}" data-sha="${r.sha}">
      <div class="col-graph"></div>
      <div class="col-msg">${refs}<span class="subject" title="${esc(r.subject)}">${esc(r.subject)}</span></div>
      <div class="col-author" title="${esc(r.author)} <${esc(r.email)}>">${esc(r.author)}</div>
      <div class="col-date" title="${esc(fullTime(r.time))}">${esc(relTime(r.time))}</div>
      <div class="col-sha">${r.sha.slice(0, 7)}</div></div>`);
  }
  $("rows").innerHTML = html.join("");
  $("loadMore").hidden = !state.truncated;

  // SVG: segments first, then nodes on top.
  const svg = $("graphSvg");
  const h = (rows.length + off) * ROW_H;
  svg.setAttribute("width", graphW);
  svg.setAttribute("height", h);
  svg.setAttribute("viewBox", `0 0 ${graphW} ${h}`);
  const yOf = (row, anchor) => (row + off) * ROW_H + anchor * (ROW_H / 2);
  const paths = [];
  rows.forEach((r, i) => {
    for (const s of r.segments) {
      const x1 = laneX(s.x1), x2 = laneX(s.x2), y1 = yOf(i, s.y1), y2 = yOf(i, s.y2);
      const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
      paths.push(`<path d="${d}" stroke="${laneColor(s.color)}"/>`);
    }
  });
  const nodes = [];
  if (wip) {
    const col = headRow >= 0 ? rows[headRow].col : 0;
    const x = laneX(col), c = headRow >= 0 ? laneColor(rows[headRow].color) : LANES[0];
    if (headRow >= 0) paths.push(`<path d="M${x} ${ROW_H / 2}V${yOf(headRow, 1)}" stroke="${c}" stroke-dasharray="3 3" opacity=".8"/>`);
    nodes.push(`<circle cx="${x}" cy="${ROW_H / 2}" r="${NODE_R}" fill="var(--bg)" stroke="${c}" stroke-width="2" stroke-dasharray="3 2"/>`);
  }
  rows.forEach((r, i) => {
    const x = laneX(r.col), y = yOf(i, 1), c = laneColor(r.color);
    const isHead = r.sha === state.status?.head;
    if (isHead) nodes.push(`<circle cx="${x}" cy="${y}" r="${NODE_R + 4}" fill="none" stroke="${c}" stroke-width="1.5" opacity=".7"/>`);
    if (r.parents.length > 1) {
      nodes.push(`<circle cx="${x}" cy="${y}" r="${NODE_R - 2.5}" fill="var(--bg)" stroke="${c}" stroke-width="2.5"/>`);
    } else {
      nodes.push(`<circle cx="${x}" cy="${y}" r="${NODE_R}" fill="${c}" stroke="var(--bg)" stroke-width="2"/>`);
      nodes.push(`<text x="${x}" y="${y + 3}" text-anchor="middle" font-size="7.5" font-weight="700" fill="#1c1a17" font-family="IBM Plex Mono, monospace">${esc(initials(r.author))}</text>`);
    }
  });
  svg.innerHTML = `<g fill="none" stroke-width="2" stroke-linecap="round">${paths.join("")}</g><g>${nodes.join("")}</g>`;
}

function markSelected() {
  for (const el of document.querySelectorAll(".row.selected")) el.classList.remove("selected");
  const el = document.querySelector(`.row[data-sha="${state.selected}"]`);
  if (el) {
    el.classList.add("selected");
    el.scrollIntoView({ block: "nearest" });
  }
}

// ---------------------------------------------------------------- commit detail

async function selectCommit(sha) {
  if (!sha || !state.repo) return;
  state.selected = sha;
  markSelected();
  const panel = $("detail");
  try {
    const c = await repoApi("GET", `/commit/${sha}`);
    if (state.selected !== sha) return;
    const [subject, ...rest] = c.message.split("\n");
    const parents = c.parents.map((p) => `<a data-goto="${p}">${p.slice(0, 7)}</a>`).join(" ");
    panel.innerHTML = `<div class="detail-pad">
      <h2>commit <span class="copy" data-copy="${c.sha}" title="Copy full SHA">${c.sha.slice(0, 10)}</span></h2>
      <pre class="message"><span class="subject-line">${esc(subject)}</span>${esc(rest.length ? "\n" + rest.join("\n") : "")}</pre>
      <dl class="kv">
        <dt>author</dt><dd title="${esc(c.email)}">${esc(c.author)} &lt;${esc(c.email)}&gt;</dd>
        <dt>date</dt><dd>${esc(fullTime(c.author_time))}</dd>
        ${c.committer !== c.author ? `<dt>committer</dt><dd>${esc(c.committer)}</dd>` : ""}
        <dt>parents</dt><dd>${parents || "<i>root commit</i>"}</dd>
      </dl>
      <h3><span>${c.files.length} FILE${c.files.length === 1 ? "" : "S"} CHANGED</span>${c.parents.length > 1 ? `<span class="count">vs first parent</span>` : ""}</h3>
      <ul class="files">${c.files.map((f) => fileItem(f.status, f.path, f.orig_path, `data-cdiff="${esc(f.path)}"`)).join("")}</ul>
    </div>`;
  } catch (e) {
    fail(e, "load commit");
  }
}

function fileItem(st, path, orig, attrs, action = "") {
  const letter = st === "?" ? "?" : st[0];
  const title = orig ? `${orig} → ${path}` : path;
  return `<li ${attrs} title="${esc(title)}"><span class="st st-${esc(letter)}">${esc(letter === "?" ? "+" : letter)}</span>
    <span class="path">&lrm;${esc(path)}&lrm;</span>${action}</li>`;
}

// ---------------------------------------------------------------- working tree (WIP)

function selectWip() {
  state.selected = "WIP";
  markSelected();
  renderWip();
}

function renderWip() {
  const panel = $("detail");
  if (!panel.querySelector("#wipPanel")) {
    panel.innerHTML = `<div class="detail-pad" id="wipPanel">
      <h2>working tree</h2>
      <h3><span id="unstagedHead">UNSTAGED</span><button class="mini" id="btnStageAll">STAGE ALL</button></h3>
      <ul class="files" id="unstagedList"></ul>
      <h3><span id="stagedHead">STAGED</span><button class="mini" id="btnUnstageAll">UNSTAGE ALL</button></h3>
      <ul class="files" id="stagedList"></ul>
      <h3><span>COMMIT</span></h3>
      <div class="commit-box">
        <textarea id="commitMsg" placeholder="Summary of your changes&#10;&#10;Optional longer description"></textarea>
        <div class="opts"><label><input type="checkbox" id="amend"> amend last commit</label><span id="msgLen"></span></div>
        <button class="btn btn-accent" id="btnCommit">Commit</button>
      </div>
    </div>`;
    const ta = $("commitMsg");
    ta.value = state.draft;
    $("amend").checked = state.amend;
    ta.addEventListener("input", () => { state.draft = ta.value; updateCommitBtn(); });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doCommit(); });
    $("amend").addEventListener("change", (e) => { state.amend = e.target.checked; updateCommitBtn(); });
    $("btnCommit").addEventListener("click", doCommit);
    $("btnStageAll").addEventListener("click", (e) => run(e.target, "stage all", () => repoApi("POST", "/stage", { paths: [] })));
    $("btnUnstageAll").addEventListener("click", (e) => run(e.target, "unstage all", () => repoApi("POST", "/unstage", { paths: [] })));
  }
  const files = state.status ? state.status.files : [];
  const unstaged = files.filter((f) => f.worktree !== "." || f.conflicted);
  const staged = files.filter((f) => f.index !== "." && !f.untracked && !f.conflicted);
  const act = (label, cls) => `<button class="mini act ${cls}">${label}</button>`;
  $("unstagedHead").textContent = `UNSTAGED (${unstaged.length})`;
  $("stagedHead").textContent = `STAGED (${staged.length})`;
  $("unstagedList").innerHTML = unstaged
    .map((f) => fileItem(f.conflicted ? "U" : f.untracked ? "?" : f.worktree, f.path, f.orig_path,
      `data-wdiff="${esc(f.path)}" data-untracked="${f.untracked}"`, act("STAGE", "do-stage")))
    .join("") || `<li class="empty-note" style="cursor:default;color:var(--faint)">nothing to stage</li>`;
  $("stagedList").innerHTML = staged
    .map((f) => fileItem(f.index, f.path, f.orig_path, `data-wdiff="${esc(f.path)}" data-staged="true"`, act("UNSTAGE", "do-unstage")))
    .join("") || `<li class="empty-note" style="cursor:default;color:var(--faint)">nothing staged</li>`;
  $("btnStageAll").disabled = !unstaged.length;
  $("btnUnstageAll").disabled = !staged.length;
  updateCommitBtn();
}

function updateCommitBtn() {
  const btn = $("btnCommit");
  if (!btn) return;
  const staged = (state.status?.files || []).some((f) => f.index !== "." && !f.untracked && !f.conflicted);
  const msg = state.draft.trim();
  btn.disabled = !msg || (!staged && !state.amend);
  const first = state.draft.split("\n")[0].length;
  $("msgLen").textContent = first ? `${first}/72` : "";
  $("msgLen").style.color = first > 72 ? "var(--del)" : "";
  btn.textContent = state.amend ? "Amend commit" : `Commit ${staged ? "staged changes" : ""}`;
}

async function doCommit() {
  const btn = $("btnCommit");
  if (!btn || btn.disabled) return;
  const res = await run(btn, state.amend ? "amend commit" : "commit", () => repoApi("POST", "/commit", { message: state.draft, amend: state.amend }));
  if (res) {
    state.draft = "";
    state.amend = false;
    const ta = $("commitMsg");
    if (ta) ta.value = "";
    if ($("amend")) $("amend").checked = false;
    if (!hasWip()) selectCommit(state.status.head);
    else renderWip();
  }
}

// ---------------------------------------------------------------- diffs

async function showDiff(title, path) {
  $("diffView").hidden = false;
  $("diffTitle").textContent = title;
  $("diffBody").innerHTML = `<div class="nodiff">loading…</div>`;
  try {
    const { diff } = await repoApi("GET", path);
    $("diffBody").innerHTML = renderDiff(diff);
  } catch (e) {
    $("diffBody").innerHTML = `<div class="nodiff">${esc(e.message)}</div>`;
  }
}

function renderDiff(text) {
  if (!text.trim()) return `<div class="nodiff">No textual changes.</div>`;
  if (/^Binary files .* differ$/m.test(text) && !text.includes("@@")) return `<div class="nodiff">Binary file changed.</div>`;
  const out = [];
  let a = 0, b = 0, inHunk = false;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (m) {
      a = +m[1]; b = +m[2]; inHunk = true;
      out.push(`<div class="hunk">${esc(line)}</div>`);
    } else if (!inHunk || line.startsWith("diff --git")) {
      inHunk = false;
      if (line && !/^(index |--- |\+\+\+ |diff --git)/.test(line)) out.push(`<div class="meta">${esc(line)}</div>`);
    } else if (line.startsWith("+")) {
      out.push(`<div class="ln add"><span class="n"></span><span class="n">${b++}</span><span class="t">${esc(line)}</span></div>`);
    } else if (line.startsWith("-")) {
      out.push(`<div class="ln del"><span class="n">${a++}</span><span class="n"></span><span class="t">${esc(line)}</span></div>`);
    } else if (line.startsWith("\\")) {
      out.push(`<div class="meta">${esc(line)}</div>`);
    } else if (line !== "" || a || b) {
      out.push(`<div class="ln"><span class="n">${a++}</span><span class="n">${b++}</span><span class="t">${esc(line)}</span></div>`);
    }
  }
  return out.join("");
}

function closeDiff() {
  $("diffView").hidden = true;
  for (const el of document.querySelectorAll(".files li.active")) el.classList.remove("active");
}

// ---------------------------------------------------------------- import modal

function openModal() {
  $("modal").hidden = false;
  browse($("fsPath").value || "");
}
function closeModal() { $("modal").hidden = true; }

async function browse(path) {
  try {
    const res = await api("GET", `/fs?path=${encodeURIComponent(path)}`);
    $("fsPath").value = res.path;
    const items = [];
    if (res.parent) items.push(`<li class="up" data-path="${esc(res.parent)}">⬑ ..</li>`);
    for (const e of res.entries) {
      items.push(`<li data-path="${esc(e.path)}">${e.repo ? `<b class="git-dot">●</b>` : "<span>▸</span>"}<span>${esc(e.name)}</span></li>`);
    }
    $("fsList").innerHTML = items.join("") || `<li class="up">empty folder</li>`;
    $("btnDoImport").textContent = res.repo ? "Import this repository" : "Import this folder";
  } catch (e) {
    toast(e.message, true);
  }
}

async function doImport() {
  const path = $("fsPath").value.trim();
  if (!path) return;
  const repo = await run($("btnDoImport"), `import ${path}`, () => api("POST", "/repos", { path }), { refresh: false });
  if (repo) {
    closeModal();
    await loadRepos();
    await openRepo(repo.id);
  }
}

async function doClone() {
  const url = $("cloneUrl").value.trim();
  if (!url) return;
  const res = await run($("btnDoClone"), `clone ${url}`, () => api("POST", "/repos/clone", { url, parent: $("cloneParent").value.trim() || null }), { refresh: false });
  if (res) {
    closeModal();
    $("cloneUrl").value = "";
    await loadRepos();
    await openRepo(res.repo.id);
  }
}

// ---------------------------------------------------------------- context menu

function showMenu(x, y, items) {
  const m = $("ctxMenu");
  m.innerHTML = items.map((it, i) => (it === "-" ? "<hr>" : `<button data-i="${i}">${esc(it.label)}</button>`)).join("");
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - 240) + "px";
  m.style.top = Math.min(y, innerHeight - m.offsetHeight - 10) + "px";
  m.onclick = (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    m.hidden = true;
    items[+b.dataset.i].fn();
  };
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast(`copied ${text.slice(0, 12)}`), () => toast("could not copy", true));
}

function newBranch(start) {
  const name = prompt(start ? `New branch at ${start.slice(0, 7)}:` : "New branch name (from HEAD):");
  if (!name) return;
  run($("btnBranch"), `create branch ${name}`, () => repoApi("POST", "/branch", { name: name.trim(), start: start || null }));
}

function checkoutRef(name, remote) {
  run(null, `checkout ${name}`, () => repoApi("POST", "/checkout", { name, remote }));
}

// ---------------------------------------------------------------- wiring

function wire() {
  // Toolbar
  $("btnFetch").onclick = (e) => run(e.currentTarget, "fetch", () => repoApi("POST", "/fetch"));
  $("btnPull").onclick = (e) => run(e.currentTarget, `pull (${state.pullMode})`, () => repoApi("POST", "/pull", { mode: state.pullMode }));
  $("btnPush").onclick = (e) => run(e.currentTarget, "push", () => repoApi("POST", "/push", {}));
  $("btnBranch").onclick = () => newBranch(null);
  $("btnRefresh").onclick = (e) => run(e.currentTarget, "refresh", async () => {}, { refresh: true });
  $("btnPullMode").onclick = (e) => { e.stopPropagation(); $("pullMenu").hidden = !$("pullMenu").hidden; };
  $("pullMenu").onclick = (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    state.pullMode = b.dataset.mode;
    try { localStorage.setItem("devtree.pullMode", state.pullMode); } catch {}
    $("pullMenu").hidden = true;
    $("btnPull").click();
  };
  $("btnTheme").onclick = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("devtree.theme", next); } catch {}
  };

  // Repositories
  $("btnImport").onclick = openModal;
  $("btnImportEmpty").onclick = openModal;
  $("repoList").onclick = (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) { e.stopPropagation(); removeRepo(rm.dataset.remove).catch((err) => fail(err, "remove")); return; }
    const li = e.target.closest("li[data-id]");
    if (li) openRepo(li.dataset.id).catch((err) => fail(err, "open repository"));
  };

  // Branch lists: click jumps to the commit, double-click checks out.
  for (const id of ["localList", "remoteList", "tagList"]) {
    const ul = $(id);
    ul.onclick = (e) => {
      const li = e.target.closest("li[data-sha]");
      if (li && state.rows.some((r) => r.sha === li.dataset.sha)) selectCommit(li.dataset.sha);
    };
    ul.ondblclick = (e) => {
      const li = e.target.closest("li[data-ref]");
      if (li && li.dataset.kind !== "tag") checkoutRef(li.dataset.ref, li.dataset.kind === "remote");
    };
    ul.oncontextmenu = (e) => {
      const li = e.target.closest("li[data-ref]");
      if (!li) return;
      e.preventDefault();
      const { ref, kind, sha } = li.dataset;
      const items = [];
      if (kind === "local") items.push({ label: `Checkout ${ref}`, fn: () => checkoutRef(ref, false) });
      if (kind === "remote") items.push({ label: `Checkout ${ref} (track)`, fn: () => checkoutRef(ref, true) });
      if (kind === "tag") items.push({ label: `Checkout ${ref} (detached)`, fn: () => run(null, `checkout ${ref}`, () => repoApi("POST", "/checkout", { name: sha, detach: true })) });
      items.push({ label: "Create branch here…", fn: () => newBranch(sha) }, "-", { label: "Copy name", fn: () => copy(ref) });
      showMenu(e.clientX, e.clientY, items);
    };
  }

  // Graph rows
  $("rows").onclick = (e) => {
    const row = e.target.closest(".row[data-sha]");
    if (!row) return;
    closeDiff();
    if (row.dataset.sha === "WIP") selectWip(); else selectCommit(row.dataset.sha);
  };
  $("rows").ondblclick = (e) => {
    const ref = e.target.closest(".ref.branch, .ref.remote");
    if (ref) checkoutRef(ref.textContent, ref.classList.contains("remote"));
  };
  $("rows").oncontextmenu = (e) => {
    const row = e.target.closest(".row[data-sha]");
    if (!row || row.dataset.sha === "WIP") return;
    e.preventDefault();
    const sha = row.dataset.sha;
    const r = state.rows.find((x) => x.sha === sha);
    const items = [];
    for (const ref of r.refs) {
      if (ref.kind === "branch" && !ref.current) items.push({ label: `Checkout ${ref.name}`, fn: () => checkoutRef(ref.name, false) });
      if (ref.kind === "remote") items.push({ label: `Checkout ${ref.name} (track)`, fn: () => checkoutRef(ref.name, true) });
    }
    items.push(
      { label: "Checkout this commit (detached)", fn: () => run(null, `checkout ${sha.slice(0, 7)}`, () => repoApi("POST", "/checkout", { name: sha, detach: true })) },
      { label: "Create branch here…", fn: () => newBranch(sha) },
      "-",
      { label: "Copy SHA", fn: () => copy(sha) },
      { label: "Copy message", fn: () => copy(r.subject) },
    );
    showMenu(e.clientX, e.clientY, items);
  };
  $("loadMore").onclick = (e) => { state.limit += PAGE; run(e.currentTarget, "load more commits", async () => {}); };
  $("search").oninput = (e) => { state.filter = e.target.value.trim(); renderGraph(); };

  // Detail panel (delegated: content is re-rendered often)
  $("detail").onclick = (e) => {
    const goto = e.target.closest("[data-goto]");
    if (goto) { selectCommit(goto.dataset.goto); return; }
    const cp = e.target.closest("[data-copy]");
    if (cp) { copy(cp.dataset.copy); return; }
    const li = e.target.closest("li[data-cdiff], li[data-wdiff]");
    if (!li) return;
    if (li.dataset.wdiff !== undefined) {
      const path = li.dataset.wdiff;
      if (e.target.closest(".do-stage")) return void run(e.target, `stage ${path}`, () => repoApi("POST", "/stage", { paths: [path] }));
      if (e.target.closest(".do-unstage")) return void run(e.target, `unstage ${path}`, () => repoApi("POST", "/unstage", { paths: [path] }));
      const staged = li.dataset.staged === "true";
      const q = `path=${encodeURIComponent(path)}&staged=${staged}&untracked=${li.dataset.untracked === "true"}`;
      showDiff(`${path}  ·  ${staged ? "staged" : "unstaged"}`, `/diff?${q}`);
    } else {
      const path = li.dataset.cdiff;
      showDiff(`${path}  ·  ${state.selected.slice(0, 7)}`, `/commit/${state.selected}/diff?path=${encodeURIComponent(path)}`);
    }
    for (const el of document.querySelectorAll(".files li.active")) el.classList.remove("active");
    li.classList.add("active");
  };
  $("btnCloseDiff").onclick = closeDiff;

  // Console
  $("consoleHead").onclick = (e) => { if (!e.target.closest("button")) $("console").classList.toggle("open"); };
  $("btnClearConsole").onclick = () => { $("consoleBody").innerHTML = ""; $("consoleLast").textContent = ""; };

  // Modal
  $("btnCloseModal").onclick = closeModal;
  $("modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
  for (const tab of document.querySelectorAll(".tab")) {
    tab.onclick = () => {
      for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
      for (const b of document.querySelectorAll(".tab-body")) b.hidden = b.dataset.body !== tab.dataset.tab;
    };
  }
  $("fsList").onclick = (e) => { const li = e.target.closest("li[data-path]"); if (li) browse(li.dataset.path); };
  $("fsList").ondblclick = (e) => { const li = e.target.closest("li[data-path]"); if (li && li.querySelector(".git-dot")) { $("fsPath").value = li.dataset.path; doImport(); } };
  $("btnFsGo").onclick = () => browse($("fsPath").value);
  $("fsPath").onkeydown = (e) => { if (e.key === "Enter") browse($("fsPath").value); };
  $("btnDoImport").onclick = doImport;
  $("btnDoClone").onclick = doClone;
  $("cloneUrl").onkeydown = (e) => { if (e.key === "Enter") doClone(); };

  // Global
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#ctxMenu")) $("ctxMenu").hidden = true;
    if (!e.target.closest(".split")) $("pullMenu").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("ctxMenu").hidden = true;
      $("pullMenu").hidden = true;
      if (!$("modal").hidden) closeModal(); else closeDiff();
      return;
    }
    if (e.target.matches("input, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("search").focus(); }
    else if (e.key === "r" && state.repo) reload().catch((err) => fail(err, "refresh"));
    else if (["ArrowDown", "ArrowUp", "j", "k"].includes(e.key) && state.repo) {
      e.preventDefault();
      const ids = [...document.querySelectorAll(".row[data-sha]")].map((r) => r.dataset.sha);
      const i = ids.indexOf(state.selected);
      const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === "ArrowDown" || e.key === "j" ? 1 : -1)))];
      if (next && next !== state.selected) { closeDiff(); next === "WIP" ? selectWip() : selectCommit(next); }
    }
  });
  window.addEventListener("focus", () => { if (state.repo) reload().catch(() => {}); });
  setInterval(poll, 4000);
}

// ---------------------------------------------------------------- boot

(async function boot() {
  try {
    const theme = localStorage.getItem("devtree.theme");
    if (theme) document.documentElement.dataset.theme = theme;
    state.pullMode = localStorage.getItem("devtree.pullMode") || "merge";
  } catch {}
  wire();
  renderEmpty();
  try {
    await loadRepos();
    let last = null;
    try { last = localStorage.getItem("devtree.repo"); } catch {}
    const start = state.repos.find((r) => r.id === last) || state.repos[0];
    if (start) await openRepo(start.id);
  } catch (e) {
    fail(e, "start up");
  }
})();
