/* library.js — list, play, rename, download and delete recordings. */
(() => {
  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  const pubnote = document.getElementById("pubnote");

  function fmtDur(s) {
    s = Math.round(s || 0);
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }
  function fmtWhen(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }
  function fmtSize(b) {
    if (!b) return "";
    const mb = b / 1048576;
    return mb >= 1 ? mb.toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
  }

  function row(rec) {
    const li = document.createElement("li");
    li.className = "rec";
    li.innerHTML = `
      <div class="rec-main">
        <input class="rec-title" value="${rec.title.replace(/"/g, "&quot;")}"
               aria-label="Title">
        <div class="rec-meta">
          ${fmtWhen(rec.created)} · ${fmtDur(rec.duration)} · ${fmtSize(rec.size)}
          ${rec.published_to ? " · copied out" : ""}
        </div>
        ${rec.note ? `<div class="rec-note"></div>` : ""}
        <audio controls preload="none" src="/media/${rec.id}"></audio>
      </div>
      <div class="rec-actions">
        <a class="btn" href="/media/${rec.id}" download>Download</a>
        <button class="btn danger" data-del>Delete</button>
      </div>`;
    if (rec.note) li.querySelector(".rec-note").textContent = rec.note;

    const titleInput = li.querySelector(".rec-title");
    let saved = rec.title;
    const commit = async () => {
      const v = titleInput.value.trim();
      if (!v || v === saved) { titleInput.value = saved; return; }
      try {
        const r = await fetch("/api/recordings/" + rec.id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: v }),
        });
        if (!r.ok) throw new Error();
        saved = v;
        titleInput.classList.add("ok");
        setTimeout(() => titleInput.classList.remove("ok"), 800);
      } catch (e) { titleInput.value = saved; }
    };
    titleInput.addEventListener("blur", commit);
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
    });

    li.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm("Delete “" + saved + "”? This can't be undone.")) return;
      const r = await fetch("/api/recordings/" + rec.id, { method: "DELETE" });
      if (r.ok) li.remove();
      if (!list.children.length) empty.hidden = false;
    });
    return li;
  }

  async function load() {
    const r = await fetch("/api/recordings");
    if (r.status === 401) { location.href = "/login"; return; }
    const j = await r.json();
    list.innerHTML = "";
    if (!j.recordings.length) { empty.hidden = false; return; }
    empty.hidden = true;
    j.recordings.forEach((rec) => list.appendChild(row(rec)));
    pubnote.textContent = j.publish_dir
      ? "New recordings are also copied to " + j.publish_dir
      : "";
  }

  load();
})();
