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
const DRAG_TYPE = "application/x-devtree-ref";

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
  remoteInfo: [],      // [{ name, fetch_url, push_url }]
  stashes: [],
  selected: null,      // sha or "WIP"
  filter: "",
  draft: "",
  amend: false,
  pullMode: "merge",
  conflict: null,      // conflict editor state
  netBusy: 0,          // network commands in flight
  autoFetch: 5,        // minutes between background fetches; 0 = off
  lastAutoFetch: {},   // repo id -> unix time of the last auto-fetch attempt
  autoFetchProblem: null,
};
const AUTO_FETCH_CHOICES = [0, 1, 5, 15, 30];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (sha) => String(sha || "").slice(0, 7);

// ---------------------------------------------------------------- api

async function api(method, path, body) {
  const opts = { method, headers: { "X-DevTree": "1" } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch("/api" + path, opts);
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.auth = data.auth || null;
    throw err;
  }
  return data;
}

/** Adds a progress-job id to an API path. */
const withJob = (path, job) => (job ? `${path}${path.includes("?") ? "&" : "?"}job=${job}` : path);
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

/**
 * Runs an action with a button showing busy state; logs output; refreshes afterwards.
 * Options:
 *   job      – `fn` receives a job id: show live progress with a Cancel button.
 *   silent   – background work (auto-fetch): no toasts, no sign-in prompts; errors are re-thrown.
 *   onError  – `onError(err)` may return true to say it handled the failure itself.
 * When a remote asks for a password, the user is prompted and the action retried.
 */
async function run(btn, what, fn, { refresh = true, onError = null, job = false, silent = false } = {}) {
  if (btn) { btn.classList.add("busy"); btn.disabled = true; }
  log(`▸ ${what}…`, "cmd");
  try {
    for (;;) {
      const jobId = job ? newJobId() : null;
      const card = jobId && !silent ? showJob(jobId, what) : null;
      if (job) state.netBusy++;
      try {
        const out = await fn(jobId);
        if (out && out.output) logOutput(out.output); else logOutput(out);
        log(`✓ ${what}`, "okl");
        if (!silent) toast(`✓ ${what}`);
        if (refresh) await reload();
        return out;
      } catch (e) {
        if (card) hideJob(jobId);
        if (silent) throw e;
        if (e.message === "cancelled by user") {
          log(`■ ${what} cancelled`, "err");
          toast(`${what} cancelled`);
          if (refresh) await reload().catch(() => {});
          return;
        }
        if (e.auth) {
          log(`✗ ${what}: ${e.message}`, "err");
          if (e.auth.kind === "https" && (await signIn(e.auth, what))) continue; // retry with credentials
          if (e.auth.kind === "ssh") await explainSsh(e.auth);
          return;
        }
        if (refresh) await reload().catch(() => {});
        if (onError && (await onError(e))) return;
        if (conflictCount()) {
          // Merges, rebases, pulls and stash pops stop here when they hit conflicts.
          log(`✗ ${what}: ${e.message}`, "err");
          toast(`${what} stopped with conflicts\nResolve them in the working tree panel.`, true);
          selectWip();
        } else {
          fail(e, what);
        }
        return;
      } finally {
        if (job) state.netBusy--;
        if (card) hideJob(jobId);
      }
    }
  } finally {
    if (btn) { btn.classList.remove("busy"); btn.disabled = false; }
  }
}

// ---------------------------------------------------------------- progress jobs

const newJobId = () => `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Shows a progress card for a running network command and polls its progress. */
function showJob(id, what) {
  const card = document.createElement("div");
  card.className = "job";
  card.id = `job-${id}`;
  card.innerHTML = `<div class="job-head"><span class="job-title">${esc(what)}</span>
      <button class="btn btn-ghost job-cancel" title="Cancel">✕ cancel</button></div>
    <div class="job-phase">starting…</div>
    <div class="job-bar"><div class="job-fill"></div></div>`;
  card.querySelector(".job-cancel").onclick = async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = "cancelling…";
    await api("POST", `/jobs/${id}/cancel`).catch(() => {});
  };
  $("jobs").appendChild(card);
  const started = Date.now();
  const timer = setInterval(async () => {
    try {
      const { progress } = await api("GET", `/jobs/${id}`);
      updateJob(card, progress, started);
    } catch { /* finished or not registered yet */ }
  }, 250);
  card.dataset.timer = timer;
  return card;
}

function updateJob(card, progress, started) {
  if (!progress) return;
  // e.g. "Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s"
  const m = progress.match(/^(?:remote:\s*)?([^:]+):\s+(\d+)%/);
  const secs = Math.round((Date.now() - started) / 1000);
  const text = progress.replace(/^Cloning into '(?:.*[\\/])?([^\\/']+)'\.\.\.$/, "Cloning into $1…");
  card.querySelector(".job-phase").textContent = `${text}${secs > 2 ? `  · ${secs}s` : ""}`;
  const fill = card.querySelector(".job-fill");
  card.querySelector(".job-bar").classList.toggle("indeterminate", !m);
  if (m) fill.style.width = `${m[2]}%`;
}

function hideJob(id) {
  const card = $(`job-${id}`);
  if (!card) return;
  clearInterval(+card.dataset.timer);
  card.remove();
}

// ---------------------------------------------------------------- fetch & auto-fetch

async function fetchNow(btn) {
  const res = await run(btn, "fetch", (job) => repoApi("POST", withJob("/fetch", job)), { job: true });
  if (res) {
    state.autoFetchProblem = null;
    renderFetchInfo();
  }
  return res;
}

/** Runs every few seconds: fetches in the background once the chosen interval has passed. */
async function autoFetchTick() {
  renderFetchInfo();
  const mins = state.autoFetch;
  const repo = state.repo;
  if (!mins || !repo || state.netBusy || !state.remotes.length || state.closeDialog) return;
  const now = Date.now() / 1000;
  const last = Math.max(state.status?.last_fetch || 0, state.lastAutoFetch[repo.id] || 0);
  if (now - last < mins * 60) return;
  state.lastAutoFetch[repo.id] = now;
  try {
    await run(null, "auto-fetch", (job) => repoApi("POST", withJob("/fetch", job)), { job: true, silent: true });
    state.autoFetchProblem = null;
  } catch (e) {
    // Never pop up dialogs from background work: show it in the header instead.
    state.autoFetchProblem = e.auth ? "sign-in needed" : "failed";
    log(`✗ auto-fetch: ${e.message}`, "err");
  }
  renderFetchInfo();
}

function renderFetchInfo() {
  const el = $("fetchInfo");
  if (!state.repo || !state.status || !state.remotes.length) {
    el.hidden = true;
    return;
  }
  const last = state.status.last_fetch;
  const auto = state.autoFetch ? ` · auto ${state.autoFetch}m` : "";
  el.hidden = false;
  el.classList.toggle("problem", !!state.autoFetchProblem);
  el.textContent = state.autoFetchProblem
    ? `⚠ auto-fetch ${state.autoFetchProblem} – click to fetch`
    : `⟳ ${last ? `fetched ${relTime(last)}` : "never fetched"}${auto}`;
  el.title = `${last ? `Last fetch: ${fullTime(last)}` : "Not fetched yet"}\n${state.autoFetch ? `Auto-fetch every ${state.autoFetch} min` : "Auto-fetch is off"}\nClick to fetch now.`;
}

function renderFetchMenu() {
  const opt = (m) => `<button data-auto="${m}"><span class="tick">${state.autoFetch === m ? "✓" : ""}</span>${m ? `every ${m} minute${m === 1 ? "" : "s"}` : "off"}</button>`;
  $("fetchMenu").innerHTML = `<button data-auto="now"><span class="tick">⟳</span>Fetch now</button><hr>
    <div class="menu-label">AUTO-FETCH</div>${AUTO_FETCH_CHOICES.map(opt).join("")}`;
}

// ---------------------------------------------------------------- sign-in

/** Asks for a username and token for an HTTPS remote. Resolves true if the user entered some. */
async function signIn(auth, what) {
  const fields = [];
  if (!auth.host) fields.push({ key: "host", label: "Server (e.g. github.com)", required: true });
  fields.push(
    { key: "username", label: "Username", required: true },
    { key: "password", label: "Password or personal access token", type: "password", required: true },
    { key: "remember", label: "Remember until DevTree is closed (kept in memory only)", type: "checkbox", value: true },
  );
  const v = await ask({
    title: `Sign in to ${auth.host || "the remote"}`,
    text: `${what} needs you to sign in.\n\nGitHub, GitLab and Bitbucket want a personal access token here, not your account password. If git has a credential manager set up, it will save the login for next time.`,
    fields,
    ok: "Sign in & retry",
  });
  if (!v) return false;
  try {
    await api("POST", "/credentials", { host: auth.host || v.host, username: v.username, password: v.password, remember: v.remember });
    log(`🔑 credentials set for ${auth.host || v.host}`, "okl");
    return true;
  } catch (e) {
    fail(e, "save credentials");
    return false;
  }
}

async function explainSsh(auth) {
  const host = auth.host || "the server";
  const text = auth.reason === "hostkey"
    ? `SSH doesn't recognise ${host} yet, so it refused to connect.\n\nOpen a terminal and run:\n    ssh -T git@${auth.host || "<host>"}\nCheck the fingerprint, answer "yes", then try again.`
    : `${host} rejected your SSH key.\n\n• Check a key is loaded:  ssh-add -l\n• If your key has a passphrase, add it to the agent:  ssh-add\n• Make sure its public key (~/.ssh/id_*.pub) is added to your account on ${host}.\n\nOr switch the remote to an HTTPS URL and sign in with a token instead.`;
  await ask({ title: "SSH sign-in failed", text, ok: "OK" });
}

// ---------------------------------------------------------------- dialog

/**
 * Small form dialog. fields: [{ key, label, type: text|textarea|checkbox|select, value, placeholder, options }]
 * Resolves with { key: value } on OK, or null when cancelled.
 */
function ask({ title, text = "", fields = [], ok = "OK", danger = false }) {
  return new Promise((resolve) => {
    $("dialogTitle").textContent = title;
    const parts = [];
    if (text) parts.push(`<p>${esc(text)}</p>`);
    for (const f of fields) {
      const id = `dlg_${f.key}`;
      if (f.type === "checkbox") {
        parts.push(`<label class="check"><input type="checkbox" id="${id}" ${f.value ? "checked" : ""}> ${esc(f.label)}</label>`);
      } else if (f.type === "textarea") {
        parts.push(`<label>${esc(f.label)}<textarea id="${id}" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea></label>`);
      } else if (f.type === "select") {
        const opts = f.options.map((o) => `<option value="${esc(o)}" ${o === f.value ? "selected" : ""}>${esc(o)}</option>`).join("");
        parts.push(`<label>${esc(f.label)}<select id="${id}">${opts}</select></label>`);
      } else {
        const type = f.type === "password" ? "password" : "text";
        parts.push(`<label>${esc(f.label)}<input id="${id}" type="${type}" value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}" autocomplete="off" spellcheck="false"></label>`);
      }
    }
    $("dialogBody").innerHTML = parts.join("");
    const okBtn = $("dialogOk");
    okBtn.textContent = ok;
    okBtn.className = "btn " + (danger ? "btn-danger" : "btn-accent");
    $("dialog").hidden = false;
    const first = $("dialogBody").querySelector("input:not([type=checkbox]), textarea, select");
    (first || okBtn).focus();
    if (first && first.select) first.select();

    const finish = (result) => {
      $("dialog").hidden = true;
      $("dialogForm").onsubmit = null;
      $("dialogCancel").onclick = null;
      state.closeDialog = null;
      resolve(result);
    };
    state.closeDialog = () => finish(null);
    $("dialogCancel").onclick = () => finish(null);
    $("dialogForm").onsubmit = (e) => {
      e.preventDefault();
      const values = {};
      for (const f of fields) {
        const el = $(`dlg_${f.key}`);
        values[f.key] = f.type === "checkbox" ? el.checked : f.type === "password" ? el.value : el.value.trim();
        if (f.required && !values[f.key]) { el.focus(); return; }
      }
      finish(values);
    };
  });
}

const confirmBox = (title, text, ok = "OK", danger = false) => ask({ title, text, ok, danger }).then((v) => v !== null);

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

/** Best human name for a commit: a branch or tag pointing at it, else its short sha. */
function nameFor(sha) {
  if (!sha) return "?";
  const b = state.branches.find((x) => x.sha === sha && x.kind === "local") || state.branches.find((x) => x.sha === sha);
  return b ? b.name : short(sha);
}

const currentBranch = () => state.status?.branch || null;
const conflictCount = () => (state.status?.files || []).filter((f) => f.conflicted).length;

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
  state.autoFetchProblem = null;
  await reload();
  setTimeout(autoFetchTick, 1500);
  // Start with the working tree when there are changes, otherwise the HEAD commit.
  if (!state.selected) {
    if (hasWip()) selectWip();
    else if (state.rows.length) selectCommit(state.status?.head || state.rows[0].sha);
    else $("detail").innerHTML = `<div class="detail-empty">This repository has no commits yet.</div>`;
  }
}

async function removeRepo(id) {
  const r = state.repos.find((x) => x.id === id);
  if (!r || !(await confirmBox("Remove repository", `Remove "${r.name}" from DevTree?\n\nThe folder on disk is not touched.`, "Remove"))) return;
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
  $("opBanner").hidden = true;
  $("fetchInfo").hidden = true;
  document.documentElement.style.setProperty("--banner-h", "0px");
  $("rows").innerHTML = "";
  $("graphSvg").innerHTML = "";
  $("empty").hidden = false;
  $("loadMore").hidden = true;
  $("detail").innerHTML = `<div class="detail-empty">Select a commit to see its details.</div>`;
  setToolbarEnabled(false);
}

function setToolbarEnabled(on) {
  for (const id of ["btnFetch", "btnFetchMode", "btnPull", "btnPullMode", "btnPush", "btnBranch", "btnRefresh", "btnStash", "btnPop"]) $(id).disabled = !on;
  if (on) {
    $("btnStash").disabled = !hasWip();
    $("btnPop").disabled = !state.stashes.length;
  }
}

// ---------------------------------------------------------------- loading

async function reload() {
  if (!state.repo) return;
  const id = state.repo.id;
  const [graph, status, refs, remoteInfo] = await Promise.all([
    repoApi("GET", `/graph?limit=${state.limit}`),
    repoApi("GET", "/status"),
    repoApi("GET", "/branches"),
    repoApi("GET", "/remotes"),
  ]);
  if (!state.repo || state.repo.id !== id) return; // switched repo meanwhile
  state.rows = graph.rows;
  state.width = graph.width;
  state.truncated = graph.truncated;
  state.branches = refs.branches;
  state.remotes = refs.remotes;
  state.remoteInfo = remoteInfo;
  state.stashes = refs.stashes;
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
  renderBanner();
  if (state.repo) setToolbarEnabled(true);
  return true;
}

function renderHeaderStatus() {
  const st = state.status;
  const bp = $("branchPill");
  bp.hidden = false;
  bp.textContent = st.branch ? `⎇ ${st.branch}` : `detached @ ${short(st.head)}`;
  const sp = $("syncPill");
  const bits = [];
  if (st.ahead) bits.push(`↑${st.ahead}`);
  if (st.behind) bits.push(`↓${st.behind}`);
  if (st.branch && !st.upstream) bits.push("not published");
  sp.hidden = !bits.length;
  sp.textContent = bits.join(" ");
  sp.title = st.upstream ? `tracking ${st.upstream}` : "no upstream branch";
  renderFetchInfo();
}

const hasWip = () => !!(state.status && state.status.files.length);

// Poll the working tree so the WIP row and file lists stay current.
async function poll() {
  if (!state.repo || document.hidden) return;
  try {
    const status = await repoApi("GET", "/status");
    const prev = state.status;
    if (!applyStatus(status, false)) return;
    if (!prev || prev.head !== status.head || prev.branch !== status.branch || !!prev.operation !== !!status.operation) {
      await reload();
    } else {
      renderGraph();
      if (state.selected === "WIP") renderWip();
      if (state.selected === "WIP" && !hasWip()) selectCommit(status.head);
    }
  } catch { /* ignore transient errors while polling */ }
}

// ---------------------------------------------------------------- merge / rebase banner

const OP_LABEL = { merge: "MERGING", rebase: "REBASING", "cherry-pick": "CHERRY-PICKING", revert: "REVERTING", am: "APPLYING PATCHES" };

function renderBanner() {
  const st = state.status;
  const el = $("opBanner");
  const op = st?.operation;
  const conflicts = conflictCount();
  if (!st || (!op && !conflicts)) {
    el.hidden = true;
    document.documentElement.style.setProperty("--banner-h", "0px");
    return;
  }
  let what;
  if (!op) what = `<span class="op-kind">CONFLICTS</span>left by the last operation (e.g. a stash apply).`;
  else if (op.kind === "merge") what = `<span class="op-kind">${OP_LABEL.merge}</span><b>${esc(nameFor(op.incoming))}</b> into <b>${esc(st.branch || short(st.head))}</b>`;
  else if (op.kind === "rebase") {
    const step = op.step && op.total ? ` · step ${op.step}/${op.total}` : "";
    what = `<span class="op-kind">${OP_LABEL.rebase}</span><b>${esc(op.head_name || "HEAD")}</b> onto <b>${esc(nameFor(op.onto))}</b>${step}`;
  } else what = `<span class="op-kind">${OP_LABEL[op.kind] || op.kind.toUpperCase()}</span><b>${esc(short(op.incoming))}</b>`;
  const tail = conflicts
    ? ` · <span class="op-bad">${conflicts} conflicted file${conflicts === 1 ? "" : "s"}</span>`
    : op ? ` · <span class="op-ok">all conflicts resolved ✓</span>` : "";
  const btns = [];
  if (conflicts) btns.push(`<button class="btn" data-op="resolve">Resolve conflicts</button>`);
  if (op) {
    btns.push(`<button class="btn btn-accent" data-op="continue" ${conflicts ? "disabled title='Resolve all conflicts first'" : ""}>${op.kind === "merge" ? "Commit merge" : "Continue"}</button>`);
    if (op.kind !== "merge") btns.push(`<button class="btn" data-op="skip" title="Drop this commit and move on">Skip</button>`);
    btns.push(`<button class="btn btn-danger" data-op="abort">Abort</button>`);
  }
  el.innerHTML = `<span class="op-text">${what}${tail}</span>${btns.join("")}`;
  el.hidden = false;
  document.documentElement.style.setProperty("--banner-h", el.offsetHeight + "px");
}

async function operationAction(action, btn) {
  if (action === "resolve") {
    selectWip();
    const first = state.status.files.find((f) => f.conflicted);
    if (first) openConflict(first.path);
    return;
  }
  const kind = state.status.operation?.kind || "operation";
  if (action === "abort" && !(await confirmBox(`Abort ${kind}`, `Abort the ${kind} and return to where you were before it started?\nConflict resolutions made so far are lost.`, "Abort", true))) return;
  await run(btn, `${kind} ${action}`, () => repoApi("POST", `/operation/${action}`));
}

// ---------------------------------------------------------------- sidebar refs

function renderRefs() {
  $("refsSection").hidden = false;
  const by = (k) => state.branches.filter((b) => b.kind === k);
  const local = by("local"), remote = by("remote"), tags = by("tag");
  $("localCount").textContent = local.length;
  $("remoteCount").textContent = remote.length;
  $("tagCount").textContent = tags.length;
  $("stashCount").textContent = state.stashes.length;
  const item = (b) => {
    const track = b.track ? ` <span class="meta">${esc(b.track.replace(/[\[\]]/g, ""))}</span>` : "";
    const drag = b.kind === "tag" ? "" : `draggable="true"`;
    return `<li class="${b.current ? "current" : ""}" ${drag} data-ref="${esc(b.name)}" data-kind="${b.kind}" data-sha="${esc(b.sha)}" title="${esc(b.name)}${b.upstream ? " → " + esc(b.upstream) : ""}">
      <span class="name">${esc(b.name)}</span>${track}</li>`;
  };
  const none = `<li class="empty-note">none</li>`;
  $("localList").innerHTML = local.map(item).join("") || none;
  // Remote branches grouped under their remote; the group header has the remote's own menu.
  const remoteOf = (name) => state.remotes.filter((r) => name.startsWith(r + "/")).sort((a, b) => b.length - a.length)[0];
  $("remoteList").innerHTML = state.remoteInfo
    .map((rm) => {
      const branches = remote.filter((b) => remoteOf(b.name) === rm.name);
      return `<li class="remote-head" data-remote="${esc(rm.name)}" title="${esc(rm.fetch_url)}"><span class="name">☁ ${esc(rm.name)}</span><span class="meta">${branches.length}</span></li>${branches.map(item).join("")}`;
    })
    .join("") || none;
  $("tagList").innerHTML = tags.map(item).join("") || none;
  $("stashList").innerHTML = state.stashes
    .map((s) => `<li data-stash="${s.index}" data-sha="${esc(s.sha)}" title="${esc(s.message)} · ${esc(fullTime(s.time))}">
      <span class="meta">{${s.index}}</span><span class="name">${esc(s.message.replace(/^(WIP on|On) [^:]+: /, ""))}</span></li>`)
    .join("") || none;
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
    const staged = f.filter((x) => x.index !== "." && !x.untracked && !x.conflicted).length;
    const conflicts = conflictCount();
    html.push(`<div class="row wip ${state.selected === "WIP" ? "selected" : ""}" data-sha="WIP">
      <div class="col-graph"></div>
      <div class="col-msg"><span class="ref current" style="--c:${laneColor(headRow >= 0 ? rows[headRow].color : 0)}">WIP</span>
        <span class="subject">${f.length} changed file${f.length === 1 ? "" : "s"}${staged ? ` · ${staged} staged` : ""}${conflicts ? ` · ⚠ ${conflicts} conflicted` : ""}</span></div>
      <div class="col-author"></div><div class="col-date"></div><div class="col-sha">// // //</div></div>`);
  }
  const filter = state.filter.toLowerCase();
  for (const r of rows) {
    const c = laneColor(r.color);
    const refs = r.refs
      .map((ref) => {
        const drag = ref.kind === "branch" || ref.kind === "remote" ? `draggable="true"` : "";
        return `<span class="ref ${ref.kind}${ref.current ? " current" : ""}" ${drag} data-ref="${esc(ref.name)}" data-kind="${ref.kind === "branch" ? "local" : ref.kind}" style="--c:${c}" title="${esc(ref.kind)}: ${esc(ref.name)}">${esc(ref.name)}</span>`;
      })
      .join("");
    const match = !filter || r.subject.toLowerCase().includes(filter) || r.author.toLowerCase().includes(filter) || r.sha.startsWith(filter);
    html.push(`<div class="row${state.selected === r.sha ? " selected" : ""}${match ? "" : " dim"}" data-sha="${r.sha}">
      <div class="col-graph"></div>
      <div class="col-msg">${refs}<span class="subject" title="${esc(r.subject)}">${esc(r.subject)}</span></div>
      <div class="col-author" title="${esc(r.author)} <${esc(r.email)}>">${esc(r.author)}</div>
      <div class="col-date" title="${esc(fullTime(r.time))}">${esc(relTime(r.time))}</div>
      <div class="col-sha">${short(r.sha)}</div></div>`);
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
    const parents = c.parents.map((p) => `<a data-goto="${p}">${short(p)}</a>`).join(" ");
    const stash = state.stashes.find((s) => s.sha === c.sha);
    const actions = stash
      ? `<div class="detail-actions">
          <button class="btn btn-accent" data-stash-act="apply" data-n="${stash.index}">Apply</button>
          <button class="btn" data-stash-act="pop" data-n="${stash.index}">Pop</button>
          <button class="btn btn-danger" data-stash-act="drop" data-n="${stash.index}">Drop</button></div>`
      : "";
    panel.innerHTML = `<div class="detail-pad">
      <h2>${stash ? `stash@{${stash.index}}` : "commit"} <span class="copy" data-copy="${c.sha}" title="Copy full SHA">${c.sha.slice(0, 10)}</span></h2>
      ${actions}
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
      <div class="wip-actions">
        <button class="btn" id="btnWipStash" title="Stash all changes">⊞ Stash</button>
        <button class="btn btn-danger" id="btnDiscardAll" title="Throw away every change, including untracked files">↺ Discard all</button>
      </div>
      <div id="conflictBlock">
        <h3><span class="warn" id="conflictHead">CONFLICTS</span></h3>
        <ul class="files conflict-list" id="conflictList"></ul>
      </div>
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
    $("btnWipStash").addEventListener("click", (e) => stashSave(e.currentTarget));
    $("btnDiscardAll").addEventListener("click", (e) => discardAll(e.currentTarget));
  }
  const files = state.status ? state.status.files : [];
  const conflicts = files.filter((f) => f.conflicted);
  const unstaged = files.filter((f) => f.worktree !== "." && !f.conflicted);
  const staged = files.filter((f) => f.index !== "." && !f.untracked && !f.conflicted);
  const act = (label, cls, title = "") => `<button class="mini act ${cls}" title="${esc(title)}">${label}</button>`;
  const none = (t) => `<li class="empty-note" style="cursor:default;color:var(--faint)">${t}</li>`;

  $("conflictBlock").hidden = !conflicts.length;
  $("conflictHead").textContent = `⚠ CONFLICTS (${conflicts.length})`;
  $("conflictList").innerHTML = conflicts
    .map((f) => fileItem("U", f.path, null, `data-conflict="${esc(f.path)}"`, act("RESOLVE", "show do-resolve", "Open the conflict editor")))
    .join("");
  $("unstagedHead").textContent = `UNSTAGED (${unstaged.length})`;
  $("stagedHead").textContent = `STAGED (${staged.length})`;
  $("unstagedList").innerHTML = unstaged
    .map((f) => fileItem(f.untracked ? "?" : f.worktree, f.path, f.orig_path,
      `data-wdiff="${esc(f.path)}" data-untracked="${f.untracked}"`,
      act("↺", "danger do-discard", f.untracked ? "Delete this new file" : "Discard changes to this file") + act("STAGE", "do-stage")))
    .join("") || none("nothing to stage");
  $("stagedList").innerHTML = staged
    .map((f) => fileItem(f.index, f.path, f.orig_path, `data-wdiff="${esc(f.path)}" data-staged="true"`, act("UNSTAGE", "do-unstage")))
    .join("") || none("nothing staged");
  $("btnStageAll").disabled = !unstaged.length;
  $("btnUnstageAll").disabled = !staged.length;
  $("btnDiscardAll").disabled = !files.length;
  $("btnWipStash").disabled = !files.length || !!conflicts.length;
  updateCommitBtn();
}

function updateCommitBtn() {
  const btn = $("btnCommit");
  if (!btn) return;
  const files = state.status?.files || [];
  const staged = files.some((f) => f.index !== "." && !f.untracked && !f.conflicted);
  const conflicts = files.some((f) => f.conflicted);
  const msg = state.draft.trim();
  btn.disabled = !msg || conflicts || (!staged && !state.amend);
  const first = state.draft.split("\n")[0].length;
  $("msgLen").textContent = first ? `${first}/72` : "";
  $("msgLen").style.color = first > 72 ? "var(--del)" : "";
  btn.textContent = conflicts ? "Resolve conflicts first" : state.amend ? "Amend commit" : `Commit ${staged ? "staged changes" : ""}`;
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

async function discardFile(path, untracked, btn) {
  const text = untracked
    ? `Delete the new file "${path}"?\n\nIt has never been committed, so this cannot be undone.`
    : `Discard your unstaged changes to "${path}"?\n\nStaged changes are kept. This cannot be undone.`;
  if (!(await confirmBox(untracked ? "Delete file" : "Discard changes", text, untracked ? "Delete" : "Discard", true))) return;
  await run(btn, `discard ${path}`, () => repoApi("POST", "/discard", { paths: [path] }));
}

async function discardAll(btn) {
  const n = state.status?.files.length || 0;
  const ok = await confirmBox("Discard all changes",
    `Throw away ALL ${n} changed file${n === 1 ? "" : "s"}: staged and unstaged edits, and new untracked files?\n\nThis cannot be undone. Consider stashing instead.`,
    "Discard everything", true);
  if (ok) await run(btn, "discard all changes", () => repoApi("POST", "/discard", { all: true }));
}

// ---------------------------------------------------------------- stashes

async function stashSave(btn) {
  const v = await ask({
    title: "Stash changes",
    text: "Saves your changes and cleans the working tree. Pop them back any time.",
    fields: [
      { key: "message", label: "Message (optional)", placeholder: "what were you doing?" },
      { key: "untracked", label: "Include untracked (new) files", type: "checkbox", value: true },
    ],
    ok: "Stash",
  });
  if (!v) return;
  const res = await run(btn, "stash", () => repoApi("POST", "/stash", { message: v.message || null, untracked: v.untracked }));
  if (res && state.selected === "WIP" && !hasWip()) selectCommit(state.status.head);
}

async function stashAction(n, action, btn) {
  const s = state.stashes.find((x) => x.index === n);
  if (!s) return;
  if (action === "drop" && !(await confirmBox("Drop stash", `Delete stash@{${n}} "${s.message}"?\n\nThis cannot be undone.`, "Drop", true))) return;
  const res = await run(btn, `stash ${action} {${n}}`, () => repoApi("POST", `/stash/${n}/${action}`));
  if (res && action !== "apply" && state.selected === s.sha) {
    if (hasWip()) selectWip(); else selectCommit(state.status.head);
  }
}

// ---------------------------------------------------------------- branches, tags, merge & rebase

async function newBranch(start) {
  const v = await ask({
    title: "New branch",
    text: start ? `Starts at ${nameFor(start)} and checks it out.` : "Starts at HEAD and checks it out.",
    fields: [{ key: "name", label: "Branch name", placeholder: "feature/my-idea", required: true }],
    ok: "Create",
  });
  if (v) run($("btnBranch"), `create branch ${v.name}`, () => repoApi("POST", "/branch", { name: v.name, start: start || null }));
}

async function newTag(start) {
  const v = await ask({
    title: "New tag",
    text: `Tags ${start ? nameFor(start) : "HEAD"}.`,
    fields: [
      { key: "name", label: "Tag name", placeholder: "v1.0.0", required: true },
      { key: "message", label: "Message (optional — makes an annotated tag)", type: "textarea" },
      { key: "push", label: "Push the tag to the remote", type: "checkbox", value: false },
    ],
    ok: "Create tag",
  });
  if (!v) return;
  // Separate steps, so a sign-in retry of the push doesn't try to create the tag twice.
  const made = await run(null, `tag ${v.name}`, () => repoApi("POST", "/tag", { name: v.name, start: start || null, message: v.message || null }));
  if (made && v.push) pushTag(v.name);
}

/** Checks out a branch; if local changes are in the way, offers to stash them first. */
function checkoutRef(name, remote) {
  const doIt = () => repoApi("POST", "/checkout", { name, remote });
  run(null, `checkout ${name}`, doIt, {
    onError: async (e) => {
      if (!/would be overwritten|commit your changes or stash/i.test(e.message)) return false;
      const ok = await confirmBox("Local changes in the way",
        `Your uncommitted changes would be overwritten by checking out ${name}.\n\nStash them first and then switch?`, "Stash & switch");
      if (ok) {
        await run(null, `stash & checkout ${name}`, async () => {
          await repoApi("POST", "/stash", { message: `auto-stash before checkout ${name}`, untracked: true });
          return doIt();
        });
      }
      return true;
    },
  });
}

function checkoutCommit(sha) {
  run(null, `checkout ${short(sha)}`, () => repoApi("POST", "/checkout", { name: sha, detach: true }));
}

const headLabel = () => currentBranch() || "HEAD";

async function mergeInto(name) {
  const v = await ask({
    title: "Merge",
    text: `Merge ${name} into ${headLabel()}.`,
    fields: [{ key: "mode", label: "Strategy", type: "select", options: ["fast-forward if possible", "always create a merge commit", "fast-forward only"], value: "fast-forward if possible" }],
    ok: "Merge",
  });
  if (!v) return;
  const mode = { "fast-forward if possible": "auto", "always create a merge commit": "no-ff", "fast-forward only": "ff-only" }[v.mode];
  run(null, `merge ${name} into ${headLabel()}`, () => repoApi("POST", "/merge", { name, mode }));
}

async function rebaseOnto(onto) {
  const ok = await confirmBox("Rebase", `Rebase ${headLabel()} onto ${onto}?\n\nYour commits are replayed on top of ${onto}, which rewrites their history. Don't rebase commits others already pulled.`, "Rebase");
  if (ok) run(null, `rebase ${headLabel()} onto ${onto}`, () => repoApi("POST", "/rebase", { onto }));
}

async function deleteBranch(name, kind) {
  if (kind === "remote") {
    if (await confirmBox("Delete remote branch", `Delete ${name} on the remote server?\n\nOther people will lose access to it. This cannot be undone from here.`, "Delete from remote", true)) {
      run(null, `delete remote branch ${name}`, (job) => repoApi("POST", withJob("/branch/delete", job), { name, remote: true }), { job: true });
    }
    return;
  }
  if (!(await confirmBox("Delete branch", `Delete the local branch ${name}?`, "Delete", true))) return;
  run(null, `delete branch ${name}`, () => repoApi("POST", "/branch/delete", { name }), {
    onError: async (e) => {
      if (!/not fully merged/.test(e.message)) return false;
      if (await confirmBox("Branch not merged", `${name} has commits that are not merged anywhere. Delete it anyway?\n\nThose commits will be hard to recover.`, "Force delete", true)) {
        await run(null, `force delete branch ${name}`, () => repoApi("POST", "/branch/delete", { name, force: true }));
      }
      return true;
    },
  });
}

async function renameBranch(name) {
  const v = await ask({ title: "Rename branch", fields: [{ key: "name", label: "New name", value: name, required: true }], ok: "Rename" });
  if (v && v.name !== name) run(null, `rename ${name} → ${v.name}`, () => repoApi("POST", "/branch/rename", { old: name, new: v.name }));
}

async function setUpstream(name) {
  const remotes = state.branches.filter((b) => b.kind === "remote").map((b) => b.name);
  if (!remotes.length) return toast("There are no remote branches to track. Push the branch first.", true);
  const current = state.branches.find((b) => b.kind === "local" && b.name === name)?.upstream;
  const guess = current || remotes.find((r) => r.endsWith("/" + name)) || remotes[0];
  const v = await ask({ title: `Upstream for ${name}`, fields: [{ key: "up", label: "Track remote branch", type: "select", options: remotes, value: guess }], ok: "Set upstream" });
  if (v) run(null, `set upstream of ${name} to ${v.up}`, () => repoApi("POST", "/branch/upstream", { name, upstream: v.up }));
}

function pushTag(name) {
  return run(null, name ? `push tag ${name}` : "push all tags", (job) => repoApi("POST", withJob("/tag/push", job), name ? { name } : {}), { job: true });
}

async function deleteTag(name) {
  const v = await ask({
    title: "Delete tag",
    text: `Delete the tag ${name}?`,
    fields: [{ key: "remote", label: "Also delete it on the remote", type: "checkbox", value: false }],
    ok: "Delete",
    danger: true,
  });
  if (v) run(null, `delete tag ${name}`, (job) => repoApi("POST", withJob("/tag/delete", job), { name, remote: v.remote }), { job: v.remote });
}

/** Context-menu entries for a branch or tag. kind: local | remote | tag */
function refMenuItems(name, kind, sha) {
  const cur = currentBranch();
  const isCurrent = kind === "local" && name === cur;
  const items = [];
  if (kind === "local" && !isCurrent) items.push({ label: `Checkout ${name}`, fn: () => checkoutRef(name, false) });
  if (kind === "remote") items.push({ label: `Checkout ${name} (track)`, fn: () => checkoutRef(name, true) });
  if (kind === "tag") items.push({ label: `Checkout ${name} (detached)`, fn: () => checkoutCommit(sha) });
  if (!isCurrent) {
    items.push({ label: `Merge ${name} into ${headLabel()}`, fn: () => mergeInto(name) });
    if (kind !== "tag") items.push({ label: `Rebase ${headLabel()} onto ${name}`, fn: () => rebaseOnto(name) });
  }
  items.push("-", { label: "Create branch here…", fn: () => newBranch(sha) });
  if (kind !== "tag") items.push({ label: "Create tag here…", fn: () => newTag(sha) });
  if (kind === "local") {
    const b = state.branches.find((x) => x.kind === "local" && x.name === name);
    items.push("-", { label: "Rename…", fn: () => renameBranch(name) }, { label: "Set upstream…", fn: () => setUpstream(name) });
    if (b && b.upstream) items.push({ label: `Unset upstream (${b.upstream})`, fn: () => run(null, `unset upstream of ${name}`, () => repoApi("POST", "/branch/upstream", { name, upstream: null })) });
    if (!isCurrent) items.push({ label: `Delete ${name}…`, fn: () => deleteBranch(name, "local"), danger: true });
  }
  if (kind === "remote") items.push("-", { label: `Delete ${name} from remote…`, fn: () => deleteBranch(name, "remote"), danger: true });
  if (kind === "tag") {
    items.push("-", { label: `Push tag ${name}`, fn: () => pushTag(name) });
    items.push({ label: "Push all tags", fn: () => pushTag(null) });
    items.push({ label: `Delete tag ${name}…`, fn: () => deleteTag(name), danger: true });
  }
  items.push("-", { label: "Copy name", fn: () => copy(name) });
  return items;
}

/** Context-menu entries for a commit. */
function commitMenuItems(sha) {
  const r = state.rows.find((x) => x.sha === sha);
  const isHead = sha === state.status?.head;
  const items = [];
  for (const ref of r ? r.refs : []) {
    if (ref.kind === "branch" && ref.name !== currentBranch()) items.push({ label: `Checkout ${ref.name}`, fn: () => checkoutRef(ref.name, false) });
    if (ref.kind === "remote") items.push({ label: `Checkout ${ref.name} (track)`, fn: () => checkoutRef(ref.name, true) });
  }
  items.push({ label: "Checkout this commit (detached)", fn: () => checkoutCommit(sha) });
  if (!isHead) {
    items.push({ label: `Merge this commit into ${headLabel()}`, fn: () => mergeInto(sha) });
    items.push({ label: `Rebase ${headLabel()} onto this commit`, fn: () => rebaseOnto(sha) });
    items.push({ label: `Cherry-pick onto ${headLabel()}`, fn: () => cherryPick(sha) });
  }
  items.push(
    { label: "Revert this commit…", fn: () => revertCommit(sha) },
    { label: `Reset ${headLabel()} to here…`, fn: () => resetTo(sha), danger: true },
    "-",
    { label: "Create branch here…", fn: () => newBranch(sha) },
    { label: "Create tag here…", fn: () => newTag(sha) },
    "-",
    { label: "Copy SHA", fn: () => copy(sha) },
  );
  if (r) items.push({ label: "Copy message", fn: () => copy(r.subject) });
  return items;
}

function commitLabel(sha) {
  const r = state.rows.find((x) => x.sha === sha);
  return r ? `${short(sha)} "${r.subject.length > 50 ? r.subject.slice(0, 50) + "…" : r.subject}"` : short(sha);
}

function cherryPick(sha) {
  run(null, `cherry-pick ${short(sha)} onto ${headLabel()}`, () => repoApi("POST", "/cherry-pick", { sha }));
}

async function revertCommit(sha) {
  const ok = await confirmBox("Revert commit", `Create a new commit on ${headLabel()} that undoes ${commitLabel(sha)}?\n\nHistory is not rewritten, so this is safe on shared branches.`, "Revert");
  if (ok) run(null, `revert ${short(sha)}`, () => repoApi("POST", "/revert", { sha }));
}

const RESET_MODES = {
  "soft — keep the changes, staged": "soft",
  "mixed — keep the changes, unstaged": "mixed",
  "hard — throw the changes away": "hard",
};

async function resetTo(sha) {
  const v = await ask({
    title: `Reset ${headLabel()}`,
    text: `Move ${headLabel()} to ${commitLabel(sha)}.\n\nCommits after it leave the branch (they stay reachable from the reflog for a while). Don't reset commits you already pushed and shared.`,
    fields: [{ key: "mode", label: "What happens to the changes in those commits and your working tree?", type: "select", options: Object.keys(RESET_MODES), value: Object.keys(RESET_MODES)[1] }],
    ok: "Reset",
    danger: true,
  });
  if (!v) return;
  const mode = RESET_MODES[v.mode];
  if (mode === "hard" && hasWip() && !(await confirmBox("Discard uncommitted changes?", "A hard reset also throws away your uncommitted changes. This cannot be undone.", "Reset hard", true))) return;
  run(null, `reset --${mode} to ${short(sha)}`, () => repoApi("POST", "/reset", { target: sha, mode }));
}

// ---------------------------------------------------------------- remotes

async function addRemote() {
  const v = await ask({
    title: "Add remote",
    fields: [
      { key: "name", label: "Name", value: state.remotes.length ? "" : "origin", placeholder: "upstream", required: true },
      { key: "url", label: "URL", placeholder: "https://github.com/user/repo.git", required: true },
      { key: "fetch", label: "Fetch it now", type: "checkbox", value: true },
    ],
    ok: "Add remote",
  });
  if (!v) return;
  const added = await run(null, `add remote ${v.name}`, () => repoApi("POST", "/remote/add", { name: v.name, url: v.url }));
  if (added && v.fetch) remoteNet(v.name, "fetch");
}

function remoteNet(name, action) {
  return run(null, `${action} ${name}`, (job) => repoApi("POST", withJob(`/remote-net/${action}`, job), { name }), { job: true });
}

function remoteMenuItems(name) {
  const info = state.remoteInfo.find((r) => r.name === name) || { fetch_url: "", push_url: "" };
  return [
    { label: `Fetch ${name}`, fn: () => remoteNet(name, "fetch") },
    { label: "Prune deleted branches", fn: () => remoteNet(name, "prune") },
    "-",
    { label: "Edit URL…", fn: async () => {
      const v = await ask({ title: `URL of ${name}`, fields: [{ key: "url", label: "URL", value: info.fetch_url, required: true }], ok: "Save" });
      if (v && v.url !== info.fetch_url) run(null, `set URL of ${name}`, () => repoApi("POST", "/remote/set-url", { name, url: v.url }));
    } },
    { label: "Rename…", fn: async () => {
      const v = await ask({ title: `Rename remote ${name}`, fields: [{ key: "n", label: "New name", value: name, required: true }], ok: "Rename" });
      if (v && v.n !== name) run(null, `rename remote ${name} → ${v.n}`, () => repoApi("POST", "/remote/rename", { name, new_name: v.n }));
    } },
    { label: "Copy URL", fn: () => copy(info.fetch_url) },
    "-",
    { label: `Remove ${name}…`, danger: true, fn: async () => {
      if (await confirmBox("Remove remote", `Remove the remote ${name}?\n\nOnly the link and its remote-tracking branches are removed; nothing on the server changes.`, "Remove", true)) {
        run(null, `remove remote ${name}`, () => repoApi("POST", "/remote/remove", { name }));
      }
    } },
  ];
}

function stashMenuItems(n) {
  const s = state.stashes.find((x) => x.index === n);
  return [
    { label: "Apply (keep stash)", fn: () => stashAction(n, "apply") },
    { label: "Pop (apply & remove)", fn: () => stashAction(n, "pop") },
    { label: "View changes", fn: () => selectCommit(s.sha) },
    "-",
    { label: "Drop…", fn: () => stashAction(n, "drop"), danger: true },
  ];
}

// ---------------------------------------------------------------- drag & drop merge / rebase

/** Drop target under the pointer: a local branch (sidebar or badge) or a commit row. */
function dropTarget(el) {
  const li = el.closest("#localList li[data-ref]");
  if (li) return { el: li, name: li.dataset.ref, sha: li.dataset.sha };
  const badge = el.closest('.row .ref[data-kind="local"]');
  if (badge) return { el: badge.closest(".row"), name: badge.dataset.ref, sha: badge.closest(".row").dataset.sha };
  const row = el.closest(".row[data-sha]");
  if (row && row.dataset.sha !== "WIP") {
    const local = row.querySelector('.ref[data-kind="local"]');
    return { el: row, name: local ? local.dataset.ref : null, sha: row.dataset.sha };
  }
  return null;
}

function dropMenu(src, target, x, y) {
  const cur = currentBranch();
  const items = [];
  if (target.name) {
    const B = target.name;
    if (B === src.name) return;
    if (B === cur) {
      items.push({ label: `Merge ${src.name} into ${B}`, fn: () => mergeInto(src.name) });
      if (src.kind !== "tag") items.push({ label: `Rebase ${B} onto ${src.name}`, fn: () => rebaseOnto(src.name) });
    } else if (src.name === cur) {
      items.push({ label: `Rebase ${src.name} onto ${B}`, fn: () => rebaseOnto(B) });
      items.push({ label: `Merge ${B} into ${src.name}`, fn: () => mergeInto(B) });
    } else {
      items.push({ label: `Checkout ${B}, then merge ${src.name} into it`, fn: () => run(null, `merge ${src.name} into ${B}`, async () => {
        await repoApi("POST", "/checkout", { name: B });
        return repoApi("POST", "/merge", { name: src.name });
      }) });
      if (src.kind === "local") items.push({ label: `Checkout ${src.name}, then rebase it onto ${B}`, fn: () => run(null, `rebase ${src.name} onto ${B}`, async () => {
        await repoApi("POST", "/checkout", { name: src.name });
        return repoApi("POST", "/rebase", { onto: B });
      }) });
    }
  } else if (src.name === cur) {
    items.push({ label: `Rebase ${src.name} onto ${short(target.sha)}`, fn: () => rebaseOnto(target.sha) });
  } else {
    items.push({ label: `Merge ${src.name} into ${headLabel()}`, fn: () => mergeInto(src.name) });
  }
  showMenu(x, y, items);
}

function wireDragAndDrop() {
  let src = null;
  let over = null;
  const clear = () => { if (over) over.classList.remove("drop-target"); over = null; };
  document.addEventListener("dragstart", (e) => {
    const el = e.target.closest && e.target.closest('[draggable="true"][data-ref]');
    if (!el) return;
    src = { name: el.dataset.ref, kind: el.dataset.kind };
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(src));
    e.dataTransfer.setData("text/plain", src.name);
    e.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  document.addEventListener("dragend", (e) => {
    if (e.target.classList) e.target.classList.remove("dragging");
    clear();
    src = null;
  });
  document.addEventListener("dragover", (e) => {
    if (!src || !e.target.closest) return;
    const t = dropTarget(e.target);
    if (!t || t.name === src.name) { clear(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (over !== t.el) { clear(); over = t.el; over.classList.add("drop-target"); }
  });
  document.addEventListener("drop", (e) => {
    if (!src) return;
    const t = dropTarget(e.target);
    const s = src;
    clear();
    if (!t) return;
    e.preventDefault();
    dropMenu(s, t, e.clientX, e.clientY);
  });
}

// ---------------------------------------------------------------- diffs

async function showDiff(title, path) {
  state.conflict = null;
  $("diffView").hidden = false;
  $("diffTitle").textContent = title;
  $("diffActions").innerHTML = "";
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
    } else {
      out.push(`<div class="ln"><span class="n">${a++}</span><span class="n">${b++}</span><span class="t">${esc(line)}</span></div>`);
    }
  }
  return out.join("");
}

function closeDiff() {
  state.conflict = null;
  $("diffView").hidden = true;
  $("diffActions").innerHTML = "";
  for (const el of document.querySelectorAll(".files li.active")) el.classList.remove("active");
}

// ---------------------------------------------------------------- conflict editor

/**
 * Splits a file with conflict markers into plain text and conflict blocks.
 * Handles the diff3 style (`|||||||` base section) too.
 */
function parseConflicts(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const segs = [];
  let plain = "";
  let block = null;
  let part = null;
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "");
    if (!block && /^<{7}( |$)/.test(bare)) {
      if (plain) segs.push({ type: "text", text: plain });
      plain = "";
      block = { type: "conflict", ours: "", base: "", theirs: "", oursLabel: bare.slice(8), theirsLabel: "", choice: null, raw: line };
      part = "ours";
    } else if (block && part === "ours" && /^\|{7}( |$)/.test(bare)) {
      part = "base"; block.raw += line;
    } else if (block && part !== "theirs" && /^={7}$/.test(bare)) {
      part = "theirs"; block.raw += line;
    } else if (block && part === "theirs" && /^>{7}( |$)/.test(bare)) {
      block.theirsLabel = bare.slice(8);
      block.raw += line;
      segs.push(block);
      block = null;
    } else if (block) {
      block[part] += line;
      block.raw += line;
    } else {
      plain += line;
    }
  }
  if (block) plain += block.raw; // unterminated markers: leave the text untouched
  if (plain) segs.push({ type: "text", text: plain });
  return segs;
}

function assembleConflicts(segs) {
  return segs.map((s) => {
    if (s.type === "text") return s.text;
    if (s.choice === "ours") return s.ours;
    if (s.choice === "theirs") return s.theirs;
    if (s.choice === "both") return s.ours + s.theirs;
    if (s.choice === "both-rev") return s.theirs + s.ours;
    return s.raw;
  }).join("");
}

async function openConflict(path) {
  $("diffView").hidden = false;
  $("diffTitle").textContent = `resolve · ${path}`;
  $("diffActions").innerHTML = "";
  $("diffBody").innerHTML = `<div class="nodiff">loading…</div>`;
  try {
    const f = await repoApi("GET", `/file?path=${encodeURIComponent(path)}`);
    const segs = f.content == null ? [] : parseConflicts(f.content);
    state.conflict = { path, segs, manual: false, kind: f.binary ? "binary" : f.too_large ? "large" : segs.some((s) => s.type === "conflict") ? "text" : "nomarkers" };
    renderConflict();
  } catch (e) {
    // e.g. the file was deleted on our side: only whole-file choices make sense.
    state.conflict = { path, segs: [], manual: false, kind: "missing", error: e.message };
    renderConflict();
  }
}

function renderConflict() {
  const c = state.conflict;
  if (!c) return;
  const op = state.status?.operation;
  const sideBtns = `<button class="btn" data-cx="take-ours">Keep current file</button><button class="btn" data-cx="take-theirs">Take incoming file</button>`;
  const rebaseHint = op && op.kind === "rebase"
    ? `<div class="cx-hint">During a rebase, <b>current</b> is the branch you're rebasing onto and <b>incoming</b> is your own commit being replayed.</div>` : "";

  if (c.kind !== "text") {
    const why = {
      binary: "This is a binary file, so it can't be merged line by line.",
      large: "This file is too large for the editor.",
      nomarkers: "This file has no conflict markers. Usually one side deleted or renamed it while the other changed it.",
      missing: "This file no longer exists in the working tree (one side deleted it).",
    }[c.kind];
    $("diffActions").innerHTML = "";
    $("diffBody").innerHTML = `${rebaseHint}<div class="nodiff"><p>${esc(why)}</p><p>Pick which version to keep:</p><p>${sideBtns}</p></div>`;
    return;
  }

  const blocks = c.segs.filter((s) => s.type === "conflict");
  const done = blocks.filter((s) => s.choice).length;
  $("diffActions").innerHTML = c.manual
    ? `<button class="btn" data-cx="guided">Back to guided</button><button class="btn btn-accent" data-cx="save">Save & mark resolved</button>`
    : `<button class="btn" data-cx="manual">Edit manually</button><button class="btn btn-accent" data-cx="save" ${done < blocks.length ? "disabled" : ""}>Save & mark resolved</button>`;

  if (c.manual) {
    $("diffBody").innerHTML = `${rebaseHint}<textarea class="cx-manual" id="cxManual" spellcheck="false"></textarea>`;
    $("cxManual").value = c.manualText;
    $("cxManual").oninput = (e) => { c.manualText = e.target.value; };
    return;
  }

  const ctx = (text) => {
    const lines = text.replace(/\n$/, "").split("\n");
    if (lines.length <= 8) return `<div class="cx-text">${esc(lines.join("\n"))}</div>`;
    return `<div class="cx-text">${esc(lines.slice(0, 3).join("\n"))}</div><div class="cx-fold">… ${lines.length - 6} unchanged lines …</div><div class="cx-text">${esc(lines.slice(-3).join("\n"))}</div>`;
  };
  let n = 0;
  const parts = c.segs.map((s, i) => {
    if (s.type === "text") return ctx(s.text);
    n++;
    const head = `<div class="cx-head"><span>CONFLICT ${n} OF ${blocks.length}</span>${s.choice ? `<button class="mini" data-cx="undo" data-i="${i}">CHANGE</button>` : ""}</div>`;
    if (s.choice) {
      return `<div class="cx-card resolved">${head}<pre class="cx-code result">${esc(assembleConflicts([s]))}</pre></div>`;
    }
    return `<div class="cx-card">${head}
      <div class="cx-sides">
        <div class="cx-side"><div class="cx-label ours">CURRENT · ${esc(s.oursLabel || "HEAD")}</div><pre class="cx-code ours">${esc(s.ours)}</pre></div>
        <div class="cx-side"><div class="cx-label theirs">INCOMING · ${esc(s.theirsLabel || "theirs")}</div><pre class="cx-code theirs">${esc(s.theirs)}</pre></div>
      </div>
      <div class="cx-btns">
        <button class="btn" data-cx="ours" data-i="${i}">Use current</button>
        <button class="btn" data-cx="theirs" data-i="${i}">Use incoming</button>
        <button class="btn" data-cx="both" data-i="${i}">Both (current first)</button>
        <button class="btn" data-cx="both-rev" data-i="${i}">Both (incoming first)</button>
      </div></div>`;
  });
  $("diffBody").innerHTML = `${rebaseHint}<div class="cx-bar"><span><b>${done}</b> of <b>${blocks.length}</b> conflicts resolved</span>
    <span style="flex:1"></span>
    <button class="mini" data-cx="all-ours">ALL CURRENT</button><button class="mini" data-cx="all-theirs">ALL INCOMING</button>
    <button class="mini" data-cx="take-ours">WHOLE FILE: CURRENT</button><button class="mini" data-cx="take-theirs">WHOLE FILE: INCOMING</button></div>${parts.join("")}`;
}

async function conflictAction(action, i, btn) {
  const c = state.conflict;
  if (!c) return;
  const blocks = c.segs.filter((s) => s.type === "conflict");
  if (["ours", "theirs", "both", "both-rev"].includes(action)) { c.segs[i].choice = action; renderConflict(); return; }
  if (action === "undo") { c.segs[i].choice = null; renderConflict(); return; }
  if (action === "all-ours" || action === "all-theirs") { for (const b of blocks) b.choice = action.slice(4); renderConflict(); return; }
  if (action === "manual") { c.manual = true; c.manualText = assembleConflicts(c.segs); renderConflict(); return; }
  if (action === "guided") {
    if (!(await confirmBox("Back to guided mode", "Manual edits will be lost. Continue?", "Discard edits"))) return;
    c.manual = false; renderConflict(); return;
  }
  if (action === "take-ours" || action === "take-theirs") {
    const side = action === "take-ours" ? "ours" : "theirs";
    const res = await run(btn, `resolve ${c.path} (${side === "ours" ? "current" : "incoming"})`, () => repoApi("POST", "/resolve", { path: c.path, side }));
    if (res) afterResolved();
    return;
  }
  if (action === "save") {
    const content = c.manual ? c.manualText : assembleConflicts(c.segs);
    if (/^(<{7}|>{7}) ?/m.test(content) && !(await confirmBox("Conflict markers left", "The file still contains conflict markers (<<<<<<< / >>>>>>>). Save and mark it resolved anyway?", "Save anyway", true))) return;
    const res = await run(btn, `resolve ${c.path}`, () => repoApi("POST", "/file", { path: c.path, content, stage: true }));
    if (res) afterResolved();
  }
}

function afterResolved() {
  const next = (state.status?.files || []).find((f) => f.conflicted);
  if (next) openConflict(next.path);
  else {
    closeDiff();
    selectWip();
    if (state.status?.operation) toast("All conflicts resolved.\nClick Continue / Commit merge in the banner.");
  }
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
  const res = await run($("btnDoClone"), `clone ${url}`, (job) => api("POST", withJob("/repos/clone", job), { url, parent: $("cloneParent").value.trim() || null }), { refresh: false, job: true });
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
  m.innerHTML = items.map((it, i) => (it === "-" ? "<hr>" : `<button data-i="${i}" class="${it.danger ? "danger" : ""}">${esc(it.label)}</button>`)).join("");
  m.hidden = false;
  m.style.left = Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 10)) + "px";
  m.style.top = Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 10)) + "px";
  m.onclick = (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    m.hidden = true;
    items[+b.dataset.i].fn();
  };
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast(`copied ${text.slice(0, 40)}`), () => toast("could not copy", true));
}

// ---------------------------------------------------------------- wiring

function wire() {
  // Toolbar
  $("btnFetch").onclick = (e) => fetchNow(e.currentTarget);
  $("btnPull").onclick = (e) => run(e.currentTarget, `pull (${state.pullMode})`, (job) => repoApi("POST", withJob("/pull", job), { mode: state.pullMode }), { job: true });
  $("btnPush").onclick = (e) => run(e.currentTarget, "push", (job) => repoApi("POST", withJob("/push", job), {}), { job: true });
  $("btnBranch").onclick = () => newBranch(null);
  $("btnStash").onclick = (e) => stashSave(e.currentTarget);
  $("btnPop").onclick = (e) => state.stashes.length && stashAction(state.stashes[0].index, "pop", e.currentTarget);
  $("btnRefresh").onclick = (e) => run(e.currentTarget, "refresh", async () => {}, { refresh: true });
  $("btnPullMode").onclick = (e) => { e.stopPropagation(); $("fetchMenu").hidden = true; $("pullMenu").hidden = !$("pullMenu").hidden; };
  $("btnFetchMode").onclick = (e) => {
    e.stopPropagation();
    $("pullMenu").hidden = true;
    renderFetchMenu();
    $("fetchMenu").hidden = !$("fetchMenu").hidden;
  };
  $("fetchMenu").onclick = (e) => {
    const b = e.target.closest("button[data-auto]");
    if (!b) return;
    $("fetchMenu").hidden = true;
    if (b.dataset.auto === "now") return void fetchNow($("btnFetch"));
    state.autoFetch = +b.dataset.auto;
    try { localStorage.setItem("devtree.autoFetch", String(state.autoFetch)); } catch {}
    toast(state.autoFetch ? `Auto-fetch every ${state.autoFetch} min` : "Auto-fetch off");
    autoFetchTick();
  };
  $("fetchInfo").onclick = () => fetchNow($("btnFetch"));
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
  $("opBanner").onclick = (e) => {
    const b = e.target.closest("button[data-op]");
    if (b && !b.disabled) operationAction(b.dataset.op, b);
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

  // Branch lists: click jumps to the commit, double-click checks out, right-click for more.
  for (const id of ["localList", "remoteList", "tagList"]) {
    const ul = $(id);
    ul.onclick = (e) => {
      const li = e.target.closest("li[data-sha]");
      if (li && state.rows.some((r) => r.sha === li.dataset.sha)) { closeDiff(); selectCommit(li.dataset.sha); }
    };
    ul.ondblclick = (e) => {
      const li = e.target.closest("li[data-ref]");
      if (!li) return;
      if (li.dataset.kind === "tag") checkoutCommit(li.dataset.sha);
      else if (!(li.dataset.kind === "local" && li.dataset.ref === currentBranch())) checkoutRef(li.dataset.ref, li.dataset.kind === "remote");
    };
    ul.oncontextmenu = (e) => {
      const li = e.target.closest("li[data-ref]");
      if (!li) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, refMenuItems(li.dataset.ref, li.dataset.kind, li.dataset.sha));
    };
  }
  $("remoteList").addEventListener("contextmenu", (e) => {
    const head = e.target.closest("li[data-remote]");
    if (!head) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, remoteMenuItems(head.dataset.remote));
  });
  $("remoteList").addEventListener("click", (e) => {
    const head = e.target.closest("li[data-remote]");
    if (head) showMenu(e.clientX, e.clientY, remoteMenuItems(head.dataset.remote));
  });
  $("btnAddRemote").onclick = addRemote;
  $("stashList").onclick = (e) => {
    const li = e.target.closest("li[data-stash]");
    if (li) { closeDiff(); selectCommit(li.dataset.sha); }
  };
  $("stashList").oncontextmenu = (e) => {
    const li = e.target.closest("li[data-stash]");
    if (!li) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, stashMenuItems(+li.dataset.stash));
  };

  // Graph rows
  $("rows").onclick = (e) => {
    const row = e.target.closest(".row[data-sha]");
    if (!row) return;
    closeDiff();
    if (row.dataset.sha === "WIP") selectWip(); else selectCommit(row.dataset.sha);
  };
  $("rows").ondblclick = (e) => {
    const ref = e.target.closest(".ref.branch, .ref.remote");
    if (ref && !(ref.dataset.kind === "local" && ref.dataset.ref === currentBranch())) checkoutRef(ref.dataset.ref, ref.dataset.kind === "remote");
  };
  $("rows").oncontextmenu = (e) => {
    const row = e.target.closest(".row[data-sha]");
    if (!row || row.dataset.sha === "WIP") return;
    e.preventDefault();
    const sha = row.dataset.sha;
    const badge = e.target.closest(".ref[data-ref]");
    if (badge && badge.dataset.kind !== "head") {
      showMenu(e.clientX, e.clientY, refMenuItems(badge.dataset.ref, badge.dataset.kind, sha));
      return;
    }
    showMenu(e.clientX, e.clientY, commitMenuItems(sha));
  };
  $("loadMore").onclick = (e) => { state.limit += PAGE; run(e.currentTarget, "load more commits", async () => {}); };
  $("search").oninput = (e) => { state.filter = e.target.value.trim(); renderGraph(); };

  // Detail panel (delegated: content is re-rendered often)
  $("detail").onclick = (e) => {
    const goto = e.target.closest("[data-goto]");
    if (goto) { selectCommit(goto.dataset.goto); return; }
    const cp = e.target.closest("[data-copy]");
    if (cp) { copy(cp.dataset.copy); return; }
    const sa = e.target.closest("[data-stash-act]");
    if (sa) { stashAction(+sa.dataset.n, sa.dataset.stashAct, sa); return; }
    const conflict = e.target.closest("li[data-conflict]");
    if (conflict) {
      openConflict(conflict.dataset.conflict);
      for (const el of document.querySelectorAll(".files li.active")) el.classList.remove("active");
      conflict.classList.add("active");
      return;
    }
    const li = e.target.closest("li[data-cdiff], li[data-wdiff]");
    if (!li) return;
    if (li.dataset.wdiff !== undefined) {
      const path = li.dataset.wdiff;
      const untracked = li.dataset.untracked === "true";
      if (e.target.closest(".do-stage")) return void run(e.target, `stage ${path}`, () => repoApi("POST", "/stage", { paths: [path] }));
      if (e.target.closest(".do-unstage")) return void run(e.target, `unstage ${path}`, () => repoApi("POST", "/unstage", { paths: [path] }));
      if (e.target.closest(".do-discard")) return void discardFile(path, untracked, e.target);
      const staged = li.dataset.staged === "true";
      const q = `path=${encodeURIComponent(path)}&staged=${staged}&untracked=${untracked}`;
      showDiff(`${path}  ·  ${staged ? "staged" : "unstaged"}`, `/diff?${q}`);
    } else {
      const path = li.dataset.cdiff;
      showDiff(`${path}  ·  ${short(state.selected)}`, `/commit/${state.selected}/diff?path=${encodeURIComponent(path)}`);
    }
    for (const el of document.querySelectorAll(".files li.active")) el.classList.remove("active");
    li.classList.add("active");
  };
  $("btnCloseDiff").onclick = closeDiff;
  const cxClick = (e) => {
    const b = e.target.closest("[data-cx]");
    if (b && !b.disabled) conflictAction(b.dataset.cx, b.dataset.i === undefined ? -1 : +b.dataset.i, b);
  };
  $("diffBody").addEventListener("click", cxClick);
  $("diffActions").addEventListener("click", cxClick);

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

  wireDragAndDrop();

  // Global
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#ctxMenu")) $("ctxMenu").hidden = true;
    if (!e.target.closest(".split")) { $("pullMenu").hidden = true; $("fetchMenu").hidden = true; }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("ctxMenu").hidden = true;
      $("pullMenu").hidden = true;
      $("fetchMenu").hidden = true;
      if (state.closeDialog) state.closeDialog();
      else if (!$("modal").hidden) closeModal();
      else closeDiff();
      return;
    }
    if (state.closeDialog || e.target.matches("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
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
  window.addEventListener("resize", renderBanner);
  setInterval(poll, 4000);
  setInterval(autoFetchTick, 15000);
}

// ---------------------------------------------------------------- boot

(async function boot() {
  try {
    const theme = localStorage.getItem("devtree.theme");
    if (theme) document.documentElement.dataset.theme = theme;
    state.pullMode = localStorage.getItem("devtree.pullMode") || "merge";
    const auto = localStorage.getItem("devtree.autoFetch");
    if (auto !== null && AUTO_FETCH_CHOICES.includes(+auto)) state.autoFetch = +auto;
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
