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
})();
