/* record.js — capture mic audio with MediaRecorder and upload it.
   Chunks are flushed to IndexedDB as they arrive so a killed tab/browser
   doesn't lose the lecture — an orphaned session is offered back on reload. */
(() => {
  const stage = document.getElementById("stage");
  const meter = document.getElementById("meter");
  const timerEl = document.getElementById("timer");
  const recBtn = document.getElementById("recBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const hint = document.getElementById("hint");
  const saveForm = document.getElementById("saveForm");
  const preview = document.getElementById("preview");
  const titleEl = document.getElementById("title");
  const noteEl = document.getElementById("note");
  const discardBtn = document.getElementById("discardBtn");
  const saveBtn = document.getElementById("saveBtn");
  const statusEl = document.getElementById("status");
  const recoverBanner = document.getElementById("recoverBanner");
  const recoverInfo = document.getElementById("recoverInfo");
  const recoverBtn = document.getElementById("recoverBtn");
  const recoverDiscardBtn = document.getElementById("recoverDiscardBtn");

  const MIME_CHOICES = [
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];

  const DB_NAME = "rec-buffer";
  const DB_VERSION = 1;
  const TIMESLICE_MS = 1000; // flush a chunk at least this often

  let stream = null;
  let recorder = null;
  let chunks = [];
  let blob = null;
  let mime = "";
  let startedAt = 0;
  let elapsedBefore = 0;
  let tick = null;
  let audioCtx = null;
  let analyser = null;
  let rafId = 0;
  let wakeLock = null;
  let sessionId = null;
  let seq = 0;
  let db = null;
  let recoveredSessionId = null;

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (const m of MIME_CHOICES) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function currentElapsed() {
    if (!recorder || recorder.state === "inactive") return elapsedBefore;
    if (recorder.state === "paused") return elapsedBefore;
    return elapsedBefore + (Date.now() - startedAt) / 1000;
  }

  function startTimer() {
    stopTimer();
    tick = setInterval(() => { timerEl.textContent = fmt(currentElapsed()); }, 200);
  }
  function stopTimer() { if (tick) { clearInterval(tick); tick = null; } }

  function drawMeter() {
    const ctx = meter.getContext("2d");
    const W = meter.width, H = meter.height;
    const buf = new Uint8Array(analyser.fftSize);
    const render = () => {
      rafId = requestAnimationFrame(render);
      analyser.getByteTimeDomainData(buf);
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 3;
      ctx.strokeStyle = stage.classList.contains("rec") ? "#ff5a4f" : "#5b6570";
      ctx.beginPath();
      const step = W / buf.length;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        const y = H / 2 + v * (H / 2) * 0.9;
        i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y);
      }
      ctx.stroke();
    };
    render();
  }

  function stopMeter() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  }

  // ---------- screen wake lock (best-effort; auto-released when tab hides) ----------
  async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && recorder &&
        recorder.state === "recording" && !wakeLock) {
      acquireWakeLock();
    }
  });

  // ---------- IndexedDB: durable chunk buffer, survives a killed tab ----------
  function openDb() {
    return new Promise((resolve) => {
      if (!window.indexedDB) { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("sessions")) {
          d.createObjectStore("sessions", { keyPath: "id" });
        }
        if (!d.objectStoreNames.contains("chunks")) {
          const store = d.createObjectStore("chunks", { keyPath: "key" });
          store.createIndex("bySession", "sessionId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  async function ensureDb() {
    if (db === null) db = await openDb();
    return db;
  }
  async function putSession(session) {
    const d = await ensureDb();
    if (!d) return;
    return new Promise((resolve) => {
      const t = d.transaction(["sessions"], "readwrite");
      t.objectStore("sessions").put(session);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  }
  async function putChunk(sid, i, data) {
    const d = await ensureDb();
    if (!d) return;
    return new Promise((resolve) => {
      const t = d.transaction(["chunks"], "readwrite");
      t.objectStore("chunks").put({ key: sid + ":" + i, sessionId: sid, seq: i, data });
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  }
  async function getAllSessions() {
    const d = await ensureDb();
    if (!d) return [];
    return new Promise((resolve) => {
      const t = d.transaction(["sessions"], "readonly");
      const req = t.objectStore("sessions").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }
  async function getChunksFor(sid) {
    const d = await ensureDb();
    if (!d) return [];
    return new Promise((resolve) => {
      const t = d.transaction(["chunks"], "readonly");
      const idx = t.objectStore("chunks").index("bySession");
      const req = idx.getAll(IDBKeyRange.only(sid));
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.seq - b.seq));
      req.onerror = () => resolve([]);
    });
  }
  async function clearSession(sid) {
    const d = await ensureDb();
    if (!d) return;
    const chs = await getChunksFor(sid);
    return new Promise((resolve) => {
      const t = d.transaction(["sessions", "chunks"], "readwrite");
      t.objectStore("sessions").delete(sid);
      const cs = t.objectStore("chunks");
      chs.forEach((c) => cs.delete(c.key));
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  }

  // ---------- recording ----------
  async function begin() {
    statusEl.textContent = "";
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      hint.textContent =
        "Microphone blocked. Allow mic access for this site and try again.";
      return;
    }

    mime = pickMime();
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime })
                      : new MediaRecorder(stream);
    } catch (e) {
      recorder = new MediaRecorder(stream);
    }
    mime = recorder.mimeType || mime || "audio/webm";
    chunks = [];
    blob = null;
    elapsedBefore = 0;
    seq = 0;
    sessionId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : "s" + Date.now() + Math.random().toString(16).slice(2);
    putSession({ id: sessionId, mime, startedAt: Date.now() });

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) {
        chunks.push(ev.data);
        putChunk(sessionId, seq++, ev.data);
      }
    };
    recorder.onstop = finalize;
    recorder.onerror = () => {
      hint.textContent = "Recording error — stopped and saved what we have so far.";
      if (recorder && recorder.state !== "inactive") end();
    };
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => {
        hint.textContent = "Microphone disconnected — stopped and saved what we have so far.";
        if (recorder && recorder.state !== "inactive") end();
      };
    }

    // timeslice: flush chunks periodically instead of buffering the whole
    // lecture in the recorder's internal (unrecoverable) memory until stop()
    recorder.start(TIMESLICE_MS);
    startedAt = Date.now();
    acquireWakeLock();

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      drawMeter();
    } catch (e) { /* meter is cosmetic */ }

    stage.classList.remove("idle");
    stage.classList.add("rec");
    recBtn.classList.add("recording");
    recBtn.setAttribute("aria-label", "Stop recording");
    pauseBtn.hidden = false;
    pauseBtn.textContent = "Pause";
    hint.textContent = "Recording… tap the square to stop";
    saveForm.hidden = true;
    startTimer();
  }

  function togglePause() {
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      elapsedBefore += (Date.now() - startedAt) / 1000;
      pauseBtn.textContent = "Resume";
      stage.classList.remove("rec");
      hint.textContent = "Paused";
    } else if (recorder.state === "paused") {
      recorder.resume();
      startedAt = Date.now();
      pauseBtn.textContent = "Pause";
      stage.classList.add("rec");
      hint.textContent = "Recording… tap the square to stop";
    }
  }

  function end() {
    if (!recorder) return;
    if (recorder.state !== "paused") {
      elapsedBefore += (Date.now() - startedAt) / 1000;
    }
    if (recorder.state !== "inactive") recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
    stopTimer();
    stopMeter();
    releaseWakeLock();
    stage.classList.remove("rec");
    stage.classList.add("idle");
    recBtn.classList.remove("recording");
    recBtn.setAttribute("aria-label", "Start recording");
    pauseBtn.hidden = true;
  }

  function finalize() {
    blob = new Blob(chunks, { type: mime.split(";")[0] });
    const url = URL.createObjectURL(blob);
    preview.src = url;
    const now = new Date();
    titleEl.value = "";
    titleEl.placeholder =
      "Recording " +
      now.toLocaleString(undefined, { month: "short", day: "numeric" }) +
      ", " +
      now.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
    noteEl.value = "";
    saveForm.hidden = false;
    hint.textContent = "Review, add a title, then save.";
    timerEl.textContent = fmt(elapsedBefore);
    titleEl.focus();
  }

  function discard() {
    if (sessionId) { clearSession(sessionId); sessionId = null; }
    blob = null;
    chunks = [];
    saveForm.hidden = true;
    preview.removeAttribute("src");
    preview.load();
    timerEl.textContent = "0:00";
    hint.textContent = "Tap to start recording";
  }

  async function save(ev) {
    ev.preventDefault();
    if (!blob) return;
    const ext = mime.includes("mp4") ? "m4a"
      : mime.includes("ogg") ? "ogg" : "webm";
    const fd = new FormData();
    fd.append("audio", blob, "recording." + ext);
    fd.append("title", titleEl.value.trim());
    fd.append("note", noteEl.value.trim());
    fd.append("duration", String(Math.round(elapsedBefore)));

    saveBtn.disabled = true;
    discardBtn.disabled = true;
    statusEl.textContent = "Uploading…";
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      if (r.status === 401) { location.href = "/login"; return; }
      if (!r.ok) throw new Error("server said " + r.status);
      const j = await r.json();
      const lec = j.meta && j.meta.lecture;
      let extra = "";
      if (lec && lec.sent) extra = " · sent to lecture notes (" + lec.course + ")";
      else if (j.meta && j.meta.published_to) extra = " (also copied out)";
      statusEl.textContent = "Saved ✓" + extra;
      if (sessionId) { await clearSession(sessionId); sessionId = null; }
      setTimeout(() => { discard(); statusEl.textContent = ""; }, 1800);
    } catch (e) {
      statusEl.textContent =
        "Upload failed — you're still holding the recording. Tap Save to retry.";
    } finally {
      saveBtn.disabled = false;
      discardBtn.disabled = false;
    }
  }

  // ---------- recovery: an orphaned session means the page died mid-recording ----------
  async function checkForRecovery() {
    const sessions = await getAllSessions();
    if (!sessions.length) return;
    const s = sessions.sort((a, b) => b.startedAt - a.startedAt)[0];
    const chs = await getChunksFor(s.id);
    if (!chs.length) { await clearSession(s.id); checkForRecovery(); return; }

    const when = new Date(s.startedAt);
    const approxDur = fmt(chs.length * (TIMESLICE_MS / 1000));
    recoverInfo.textContent =
      "Found an interrupted recording from " +
      when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) +
      " (~" + approxDur + ")";
    recoverBanner.hidden = false;
    recBtn.disabled = true;

    recoverBtn.onclick = () => {
      mime = s.mime || "audio/webm";
      blob = new Blob(chs.map((c) => c.data), { type: mime.split(";")[0] });
      elapsedBefore = chs.length * (TIMESLICE_MS / 1000);
      recoveredSessionId = s.id;
      recoverBanner.hidden = true;
      recBtn.disabled = false;
      const url = URL.createObjectURL(blob);
      preview.src = url;
      titleEl.value = "";
      titleEl.placeholder = "Recovered recording";
      noteEl.value = "";
      saveForm.hidden = false;
      hint.textContent = "Recovered — review and save.";
      timerEl.textContent = fmt(elapsedBefore);
      sessionId = s.id; // save() will clear it from IndexedDB once uploaded
      titleEl.focus();
    };
    recoverDiscardBtn.onclick = async () => {
      await clearSession(s.id);
      recoverBanner.hidden = true;
      recBtn.disabled = false;
      checkForRecovery(); // in case more than one was orphaned
    };
  }

  recBtn.addEventListener("click", () => {
    if (!recorder || recorder.state === "inactive") begin();
    else end();
  });
  pauseBtn.addEventListener("click", togglePause);
  discardBtn.addEventListener("click", discard);
  saveForm.addEventListener("submit", save);

  window.addEventListener("beforeunload", (e) => {
    if ((recorder && recorder.state !== "inactive") || blob) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    hint.textContent = "This browser can't record audio. Try Safari or Chrome.";
    recBtn.disabled = true;
  } else {
    checkForRecovery();
  }
})();
