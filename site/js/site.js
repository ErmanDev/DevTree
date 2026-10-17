// Small enhancements: theme toggle, mobile menu, copy buttons, table-of-contents highlight.
(function () {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem("devtree-docs.theme");
    if (saved) root.dataset.theme = saved;
  } catch {}

  document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("themeToggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        const dark = root.dataset.theme
          ? root.dataset.theme === "dark"
          : !window.matchMedia("(prefers-color-scheme: light)").matches;
        root.dataset.theme = dark ? "light" : "dark";
        try { localStorage.setItem("devtree-docs.theme", root.dataset.theme); } catch {}
      });
    }

    const menu = document.getElementById("menuBtn");
    const nav = document.getElementById("nav");
    if (menu && nav) {
      menu.addEventListener("click", () => {
        const open = nav.classList.toggle("open");
        menu.setAttribute("aria-expanded", String(open));
      });
    }

    // Copy buttons on code blocks (prompt markers and comments are left out).
    for (const pre of document.querySelectorAll("pre")) {
      if (!navigator.clipboard) break;
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "copy";
      btn.addEventListener("click", async () => {
        const clone = pre.querySelector("code").cloneNode(true);
        for (const el of clone.querySelectorAll(".p, .c")) el.remove();
        try {
          await navigator.clipboard.writeText(clone.textContent.replace(/\n{2,}/g, "\n").trim());
          btn.textContent = "copied";
        } catch {
          btn.textContent = "failed";
        }
        setTimeout(() => (btn.textContent = "copy"), 1500);
      });
      pre.appendChild(btn);
    }

    // Install page: show one operating system at a time, guessing the visitor's.
    const tabs = [...document.querySelectorAll(".os-tabs [data-os]")];
    const panels = [...document.querySelectorAll(".os-panel")];
    if (tabs.length && panels.length) {
      root.classList.add("tabs-on");
      const select = (os) => {
        for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.os === os));
        for (const p of panels) p.hidden = p.dataset.os !== os;
      };
      const fromHash = () => {
        const target = location.hash && document.getElementById(location.hash.slice(1));
        const panel = target && target.closest(".os-panel");
        return panel ? panel.dataset.os : null;
      };
      const platform = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent).toLowerCase();
      const guess = platform.includes("win") ? "windows" : platform.includes("mac") ? "macos" : "linux";
      select(fromHash() || guess);
      for (const t of tabs) {
        t.addEventListener("click", (e) => {
          e.preventDefault();
          select(t.dataset.os);
          history.replaceState(null, "", "#" + t.dataset.os);
        });
      }
      window.addEventListener("hashchange", () => {
        const os = fromHash();
        if (os) {
          select(os);
          document.getElementById(location.hash.slice(1)).scrollIntoView();
        }
      });
    }

    showReleases();

    // Highlight the section being read in the table of contents.
    const links = [...document.querySelectorAll(".toc a[href^='#']")];
    if (links.length && "IntersectionObserver" in window) {
      const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
      const observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          for (const a of links) a.classList.remove("active");
          const a = byId.get(e.target.id);
          if (a) a.classList.add("active");
        }
      }, { rootMargin: "-80px 0px -70% 0px" });
      for (const id of byId.keys()) {
        const el = document.getElementById(id);
        if (el) observer.observe(el);
      }
    }
  });

  // ---------------------------------------------------------------- releases
  // Release info comes live from GitHub, so a new release shows up here without
  // redeploying the site. Without it, pages keep their plain "latest download" links.

  const RELEASES = "https://api.github.com/repos/ErmanDev/DevTree/releases?per_page=30";

  async function releases() {
    // GitHub allows 60 unauthenticated requests an hour; one per visit is plenty.
    try {
      const cached = JSON.parse(sessionStorage.getItem("devtree-docs.releases") || "null");
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.list;
    } catch {}
    const res = await fetch(RELEASES, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const list = (await res.json())
      .filter((r) => !r.draft && !r.prerelease)
      .map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        date: r.published_at,
        url: r.html_url,
        body: r.body || "",
        assets: (r.assets || []).map((a) => a.name),
      }));
    try { sessionStorage.setItem("devtree-docs.releases", JSON.stringify({ at: Date.now(), list })); } catch {}
    return list;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const day = (iso) => new Date(iso).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });

  /** Just enough Markdown for release notes: headings, lists, bold, italics, code, links. */
  function markdown(text) {
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    const out = [];
    let list = false;
    for (const raw of text.replace(/\r/g, "").split("\n")) {
      const line = raw.trim();
      const item = line.match(/^[-*] (.*)$/);
      if (!item && list) { out.push("</ul>"); list = false; }
      if (item) {
        if (!list) { out.push("<ul>"); list = true; }
        out.push(`<li>${inline(item[1])}</li>`);
      } else if (/^#{1,6} /.test(line)) {
        out.push(`<h4>${inline(line.replace(/^#+ /, ""))}</h4>`);
      } else if (line) {
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    if (list) out.push("</ul>");
    return out.join("");
  }

  async function showReleases() {
    const slots = document.querySelectorAll("[data-release]");
    const list = document.getElementById("releaseList");
    if (!slots.length && !list) return;
    let all;
    try {
      all = await releases();
    } catch {
      return; // offline or rate-limited: the static links still work
    }
    const latest = all[0];
    if (!latest) return;
    for (const el of slots) {
      const kind = el.dataset.release;
      if (kind === "version") el.textContent = latest.tag;
      else if (kind === "version-dot") el.textContent = `${latest.tag} · `;
      else if (kind === "date") el.textContent = `, released ${day(latest.date)}`;
      else if (kind === "note") {
        el.innerHTML = `Latest: <b>${esc(latest.tag)}</b> · ${esc(day(latest.date))} · <a href="/docs/releases">What's new →</a>`;
        el.hidden = false;
      }
    }
    if (list) {
      list.innerHTML = all.map((r, i) => `
        <section class="release${i === 0 ? " latest" : ""}" id="${esc(r.tag)}">
          <header>
            <h3><a href="${esc(r.url)}">${esc(r.tag)}</a></h3>
            ${i === 0 ? '<span class="badge">LATEST</span>' : ""}
            <time datetime="${esc(r.date)}">${esc(day(r.date))}</time>
          </header>
          ${markdown(r.body)}
          ${r.assets.length ? `<p class="assets">Files: ${r.assets.map(esc).join(" · ")}</p>` : ""}
        </section>`).join("");
      // Arriving from a link like /docs/releases#v0.1.2: scroll to it now that it exists.
      const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target && target.classList.contains("release")) target.scrollIntoView();
    }
  }
})();
