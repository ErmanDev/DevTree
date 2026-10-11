"use strict";
// Diff parsing, rendering (unified / side-by-side, syntax colours, word-level changes) and
// building partial patches from selected lines. No dependencies; loaded before app.js.

const Diff = (() => {
  const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- parsing

  /**
   * Parses a single-file unified diff.
   * Returns { header: [lines], hunks: [{ header, oldStart, oldCount, newStart, newCount, lines }],
   *           binary, truncated, newFile, deletedFile, renamed }.
   * Hunk lines: { type: "ctx" | "add" | "del" | "nonl", text, oldNo, newNo }.
   */
  function parse(text) {
    const res = { header: [], hunks: [], binary: false, truncated: false, newFile: false, deletedFile: false, renamed: false };
    const lines = text.replace(/\n$/, "").split("\n");
    let hunk = null, a = 0, b = 0;
    for (const line of lines) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (m) {
        hunk = { header: line, context: m[5].trim(), oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], lines: [] };
        res.hunks.push(hunk);
        a = hunk.oldStart; b = hunk.newStart;
        continue;
      }
      if (line.startsWith("… diff truncated by DevTree")) { res.truncated = true; continue; }
      if (!hunk) {
        if (line === "" && !res.header.length) continue;
        res.header.push(line);
        if (/^Binary files .* differ$/.test(line) || line.startsWith("GIT binary patch")) res.binary = true;
        if (line.startsWith("new file mode")) res.newFile = true;
        if (line.startsWith("deleted file mode")) res.deletedFile = true;
        if (line.startsWith("rename from") || line.startsWith("similarity index")) res.renamed = true;
        continue;
      }
      if (line.startsWith("+")) hunk.lines.push({ type: "add", text: line.slice(1), newNo: b++ });
      else if (line.startsWith("-")) hunk.lines.push({ type: "del", text: line.slice(1), oldNo: a++ });
      else if (line.startsWith("\\")) hunk.lines.push({ type: "nonl", text: line });
      else if (line === "" && res.truncated) continue;
      else hunk.lines.push({ type: "ctx", text: line.slice(1), oldNo: a++, newNo: b++ });
    }
    return res;
  }

  // ---------------------------------------------------------------- syntax highlighting

  const KEYWORDS = {
    rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
    js: "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield interface type enum implements private public protected readonly",
    py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield",
    go: "break case chan const continue default defer else fallthrough for func go goto if import interface map nil package range return select struct switch type var true false",
    c: "auto bool break case catch char class const continue default delete do double else enum explicit extern false final float for friend goto if inline int long namespace new nullptr operator override private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while abstract boolean byte extends implements import instanceof interface native package super synchronized throws transient var val fun when object is in null string",
    sh: "if then else elif fi for while until do done case esac function in return local export readonly echo exit set unset source",
    sql: "select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset and or not null as distinct union all primary key foreign references",
    generic: "if else for while return function true false null",
  };
  const kwSets = Object.fromEntries(Object.entries(KEYWORDS).map(([k, v]) => [k, new Set(v.split(" "))]));
  const LANGS = {
    rs: ["rust", "//"], js: ["js", "//"], mjs: ["js", "//"], cjs: ["js", "//"], jsx: ["js", "//"], ts: ["js", "//"], tsx: ["js", "//"],
    vue: ["js", "//"], svelte: ["js", "//"], py: ["py", "#"], rb: ["py", "#"], go: ["go", "//"],
    c: ["c", "//"], h: ["c", "//"], cc: ["c", "//"], cpp: ["c", "//"], hpp: ["c", "//"], cs: ["c", "//"], java: ["c", "//"],
    kt: ["c", "//"], swift: ["c", "//"], scala: ["c", "//"], dart: ["c", "//"], php: ["c", "//"],
    css: ["generic", "//"], scss: ["generic", "//"], less: ["generic", "//"],
    sh: ["sh", "#"], bash: ["sh", "#"], zsh: ["sh", "#"], fish: ["sh", "#"], ps1: ["sh", "#"],
    yml: ["generic", "#"], yaml: ["generic", "#"], toml: ["generic", "#"], ini: ["generic", ";"], conf: ["generic", "#"],
    dockerfile: ["sh", "#"], makefile: ["sh", "#"], cmake: ["sh", "#"], r: ["py", "#"], pl: ["sh", "#"],
    sql: ["sql", "--"], lua: ["generic", "--"], hs: ["generic", "--"],
    json: ["generic", null], md: [null, null], txt: [null, null], html: ["generic", null], xml: ["generic", null],
  };

  function langFor(path) {
    const base = String(path || "").split("/").pop().toLowerCase();
    const ext = base.includes(".") ? base.split(".").pop() : base;
    const [kw, comment] = LANGS[ext] || ["generic", null];
    return kw === null ? null : { kw: kwSets[kw], comment, sql: kw === "sql" };
  }

  const TOKEN = /(\/\*.*?\*\/|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?|\b0x[\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?\b|[A-Za-z_][\w$]*)/;

  /** Escaped HTML of one line of code with retro syntax colours. */
  function highlight(text, lang) {
    if (!lang || text.length > 2000) return escHtml(text);
    let comment = "";
    let code = text;
    if (lang.comment) {
      const at = findComment(text, lang.comment);
      if (at >= 0) { code = text.slice(0, at); comment = text.slice(at); }
    }
    let out = "";
    for (const part of code.split(TOKEN)) {
      if (!part) continue;
      const c = part[0];
      let cls = null;
      if (part.startsWith("/*")) cls = "c";
      else if (c === '"' || c === "'" || c === "`") cls = "s";
      else if (/\d/.test(c)) cls = "n";
      else if (/[A-Za-z_]/.test(c)) {
        if (lang.kw.has(lang.sql ? part.toLowerCase() : part)) cls = "k";
        else if (/^[A-Z][a-z]\w*$/.test(part)) cls = "t";
      }
      out += cls ? `<span class="tk-${cls}">${escHtml(part)}</span>` : escHtml(part);
    }
    if (comment) out += `<span class="tk-c">${escHtml(comment)}</span>`;
    return out;
  }

  /** Index where a line comment starts, ignoring markers inside strings. */
  function findComment(text, marker) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (text.startsWith(marker, i)) {
        // `#` needs a word boundary before it (e.g. not in "a#b" or "#!" shebangs are fine).
        if (marker !== "#" || i === 0 || /\s/.test(text[i - 1])) return i;
      }
    }
    return -1;
  }

  // ---------------------------------------------------------------- word-level diff

  const WORD = /\w+|\s+|[^\w\s]/g;

  /** Splits two lines into segments, marking the tokens that differ. */
  function wordDiff(a, b) {
    const ta = a.match(WORD) || [], tb = b.match(WORD) || [];
    if (ta.length * tb.length > 40000) return null;
    // LCS table over tokens.
    const n = ta.length, m = tb.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    // Only mark tokens when the lines are clearly two versions of the same line: count the
    // shared words (not spaces or punctuation) against all words on both lines.
    const words = (ts) => ts.filter((t) => /\w/.test(t)).length;
    let shared = 0;
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (ta[i] === tb[j]) { if (/\w/.test(ta[i])) shared++; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
    const total = words(ta) + words(tb);
    if (!total || (2 * shared) / total < 0.5) return null;
    const sa = [], sb = [];
    const push = (arr, text, changed) => {
      const last = arr[arr.length - 1];
      if (last && last.changed === changed) last.text += text; else arr.push({ text, changed });
    };
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ta[i] === tb[j]) { push(sa, ta[i++], false); push(sb, tb[j++], false); }
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) push(sb, tb[j++], true);
      else push(sa, ta[i++], true);
    }
    return [sa, sb];
  }

  function renderSegments(segs, lang) {
    return segs.map((s) => (s.changed && s.text.trim() ? `<mark>${highlight(s.text, lang)}</mark>` : highlight(s.text, lang))).join("");
  }

  /** For each hunk, pairs the i-th deleted with the i-th added line of a change block. */
  function pairChanges(hunk) {
    const pairs = new Map(); // line index -> [segments]
    const ls = hunk.lines;
    for (let i = 0; i < ls.length; ) {
      if (ls[i].type !== "del") { i++; continue; }
      const dels = [];
      while (i < ls.length && (ls[i].type === "del" || ls[i].type === "nonl")) { if (ls[i].type === "del") dels.push(i); i++; }
      const adds = [];
      while (i < ls.length && (ls[i].type === "add" || ls[i].type === "nonl")) { if (ls[i].type === "add") adds.push(i); i++; }
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const wd = wordDiff(ls[dels[k]].text, ls[adds[k]].text);
        if (wd) { pairs.set(dels[k], wd[0]); pairs.set(adds[k], wd[1]); }
      }
    }
    return pairs;
  }

  // ---------------------------------------------------------------- rendering

  /**
   * opts: { path, split, selectable, selected: Set("h:i"), hunkButtons: (h) => html }
   */
  function render(parsed, opts) {
    if (parsed.binary) return `<div class="nodiff">Binary file changed.</div>`;
    if (!parsed.hunks.length) {
      const meta = parsed.header.filter((l) => /^(rename|similarity|new file|deleted file|old mode|new mode|copy)/.test(l));
      return meta.length ? `<div class="meta-block">${meta.map(escHtml).join("<br>")}</div>` : `<div class="nodiff">No textual changes.</div>`;
    }
    const lang = langFor(opts.path);
    const meta = parsed.header.filter((l) => /^(rename|similarity|new file|deleted file|old mode|new mode)/.test(l));
    let html = meta.length ? `<div class="meta-block">${meta.map(escHtml).join("<br>")}</div>` : "";
    parsed.hunks.forEach((h, hi) => {
      const pairs = pairChanges(h);
      const code = (li) => {
        const l = h.lines[li];
        return pairs.has(li) ? renderSegments(pairs.get(li), lang) : highlight(l.text, lang);
      };
      html += `<div class="hunk" data-h="${hi}"><span class="hunk-text">${escHtml(h.header)}</span>${opts.hunkButtons ? opts.hunkButtons(hi) : ""}</div>`;
      html += opts.split ? renderSplit(h, hi, code, opts) : renderUnified(h, hi, code, opts);
    });
    if (parsed.truncated) html += `<div class="nodiff">… diff truncated (file too large) …</div>`;
    return html;
  }

  function lineAttrs(hi, li, l, opts) {
    if (!opts.selectable || (l.type !== "add" && l.type !== "del")) return "";
    return ` data-sel="${hi}:${li}"`;
  }

  function renderUnified(h, hi, code, opts) {
    let out = "";
    h.lines.forEach((l, li) => {
      if (l.type === "nonl") { out += `<div class="meta">${escHtml(l.text)}</div>`; return; }
      const cls = l.type === "add" ? "add" : l.type === "del" ? "del" : "";
      const attrs = lineAttrs(hi, li, l, opts);
      const sel = opts.selected && opts.selected.has(`${hi}:${li}`) ? " sel" : "";
      const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      out += `<div class="ln ${cls}${attrs ? " selectable" : ""}${sel}"${attrs}><span class="n">${l.oldNo ?? ""}</span><span class="n">${l.newNo ?? ""}</span><span class="t"><span class="sign">${sign}</span>${code(li)}</span></div>`;
    });
    return out;
  }

  function renderSplit(h, hi, code, opts) {
    const rows = [];
    const ls = h.lines;
    for (let i = 0; i < ls.length; ) {
      const l = ls[i];
      if (l.type === "ctx") { rows.push([i, i]); i++; continue; }
      if (l.type === "nonl") { i++; continue; }
      const dels = [], adds = [];
      while (i < ls.length && (ls[i].type === "del" || ls[i].type === "nonl")) { if (ls[i].type === "del") dels.push(i); i++; }
      while (i < ls.length && (ls[i].type === "add" || ls[i].type === "nonl")) { if (ls[i].type === "add") adds.push(i); i++; }
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
    }
    const cell = (li, side) => {
      if (li === null) return `<div class="sc empty"></div><div class="sc empty code"></div>`;
      const l = ls[li];
      const cls = l.type === "ctx" ? "" : l.type;
      const no = side === "old" ? l.oldNo : l.newNo;
      const attrs = lineAttrs(hi, li, l, opts);
      const sel = opts.selected && opts.selected.has(`${hi}:${li}`) ? " sel" : "";
      return `<div class="sc n ${cls}">${no ?? ""}</div><div class="sc code ${cls}${attrs ? " selectable" : ""}${sel}"${attrs}>${code(li)}</div>`;
    };
    return `<div class="split">${rows.map(([o, n]) => cell(o, "old") + cell(n, "new")).join("")}</div>`;
  }

  // ---------------------------------------------------------------- partial patches

  /**
   * Builds a patch containing only the selected lines (Set of "hunk:line").
   * reverse=false: stage (apply to the index the patch's old side matches).
   * reverse=true:  unstage / discard (the patch's new side matches the target; applied with --reverse).
   */
  function buildPatch(parsed, selected, reverse) {
    const out = parsed.header.filter((l) => /^(diff --git|--- |\+\+\+ )/.test(l));
    let delta = 0;
    let any = false;
    parsed.hunks.forEach((h, hi) => {
      const ls = h.lines;
      const body = [];
      let oldCount = 0, newCount = 0, changes = 0;
      // A "\ No newline" marker belongs to the line just before it and must follow it.
      const emit = (li, prefix) => {
        body.push(prefix + ls[li].text);
        if (ls[li + 1] && ls[li + 1].type === "nonl") body.push(ls[li + 1].text);
      };
      const isSel = (li) => selected.has(`${hi}:${li}`);
      for (let i = 0; i < ls.length; ) {
        if (ls[i].type === "nonl") { i++; continue; }
        if (ls[i].type === "ctx") { emit(i, " "); oldCount++; newCount++; i++; continue; }
        // A change block: removed lines, then added lines. The k-th removed line pairs with the
        // k-th added one, and each pair is emitted together so partial selections keep line order.
        const dels = [], adds = [];
        while (i < ls.length && (ls[i].type === "del" || ls[i].type === "nonl")) { if (ls[i].type === "del") dels.push(i); i++; }
        while (i < ls.length && (ls[i].type === "add" || ls[i].type === "nonl")) { if (ls[i].type === "add") adds.push(i); i++; }
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
          const d = dels[k], a = adds[k];
          if (d !== undefined) {
            if (isSel(d)) { emit(d, "-"); oldCount++; changes++; }
            else if (!reverse) { emit(d, " "); oldCount++; newCount++; } // stays on both sides
          }
          if (a !== undefined) {
            if (isSel(a)) { emit(a, "+"); newCount++; changes++; }
            else if (reverse) { emit(a, " "); oldCount++; newCount++; } // already in the target
          }
        }
      }
      if (!changes) return;
      any = true;
      const oldStart = reverse ? h.newStart - delta : h.oldStart;
      const newStart = reverse ? h.newStart : h.oldStart + delta;
      out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
      out.push(...body);
      delta += newCount - oldCount;
    });
    return any ? out.join("\n") + "\n" : null;
  }

  /** "h:i" keys of every changed line in a hunk (or the whole diff when hi is null). */
  function changedKeys(parsed, hi = null) {
    const keys = [];
    parsed.hunks.forEach((h, i) => {
      if (hi !== null && i !== hi) return;
      h.lines.forEach((l, li) => { if (l.type === "add" || l.type === "del") keys.push(`${i}:${li}`); });
    });
    return keys;
  }

  const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
  const isImage = (path) => IMAGE.test(path || "");

  return { parse, render, buildPatch, changedKeys, highlight, langFor, wordDiff, isImage };
})();

if (typeof module !== "undefined") module.exports = Diff;
