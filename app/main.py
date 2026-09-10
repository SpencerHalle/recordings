"""main.py — a phone-friendly voice recorder that saves audio onto bigbox.

One container (`recordings`) on bigbox. Records come in from the browser's
MediaRecorder, land under $REC_DATA/recordings/<id>/, and — if $REC_PUBLISH_DIR
is set — a copy is dropped there too so another system (e.g. Audiobookshelf)
can pick them up.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets as pysecrets
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("recordings")

APP_DIR = Path(__file__).resolve().parent
DATA = Path(os.environ.get("REC_DATA", "/data"))
SECRETS = Path(os.environ.get("REC_SECRETS", "/secrets"))
REC_DIR = DATA / "recordings"
REC_DIR.mkdir(parents=True, exist_ok=True)

TZ = ZoneInfo(os.environ.get("TZ", "America/Denver"))

# Optional: also copy every finished recording into this directory.
PUBLISH_DIR = os.environ.get("REC_PUBLISH_DIR", "").strip()

# ── auth ───────────────────────────────────────────────────────────
# Single shared password. Read from secrets/app_password, or $REC_PASSWORD.
_pw_file = SECRETS / "app_password"
PASSWORD = (_pw_file.read_text().strip() if _pw_file.exists()
            else os.environ.get("REC_PASSWORD", "").strip())

# Cookie-signing key: persisted so sessions survive a restart.
_key_file = SECRETS / "session_key"
if _key_file.exists():
    SESSION_KEY = _key_file.read_text().strip().encode()
else:
    SESSION_KEY = pysecrets.token_hex(32).encode()
    try:
        _key_file.write_text(SESSION_KEY.decode())
        _key_file.chmod(0o600)
    except OSError:
        log.warning("could not persist session_key; sessions reset on restart")

COOKIE = "rec_session"
SESSION_DAYS = 30


def _sign(payload: str) -> str:
    mac = hmac.new(SESSION_KEY, payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{mac}"


def _valid(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    payload, _, mac = token.rpartition(".")
    good = hmac.new(SESSION_KEY, payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, good):
        return False
    try:
        issued = int(payload)
    except ValueError:
        return False
    return (time.time() - issued) < SESSION_DAYS * 86400


def require_auth(request: Request) -> None:
    if not PASSWORD:            # no password configured → open (dev only)
        return
    if _valid(request.cookies.get(COOKIE)):
        return
    if request.url.path.startswith(("/api/", "/media/")):
        raise HTTPException(401, "not signed in")
    raise HTTPException(302, headers={"Location": "/login"})


# ── app ────────────────────────────────────────────────────────────
app = FastAPI(title="Recordings")
app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
templates = Jinja2Templates(directory=APP_DIR / "templates")


@app.exception_handler(HTTPException)
async def _redirecting_errors(request: Request, exc: HTTPException):
    if exc.status_code == 302 and exc.headers and "Location" in exc.headers:
        return RedirectResponse(exc.headers["Location"], status_code=302)
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True, "publish_dir": PUBLISH_DIR or None}


# ── PWA plumbing ───────────────────────────────────────────────────
@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(APP_DIR / "static" / "sw.js",
                        media_type="text/javascript",
                        headers={"Service-Worker-Allowed": "/",
                                 "Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(APP_DIR / "static" / "manifest.webmanifest",
                        media_type="application/manifest+json")


# ── login ──────────────────────────────────────────────────────────
@app.get("/login", response_class=HTMLResponse)
def login_form(request: Request, bad: int = 0):
    if not PASSWORD or _valid(request.cookies.get(COOKIE)):
        return RedirectResponse("/", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request, "bad": bad})


@app.post("/login")
def login_submit(password: str = Form(...)):
    if not PASSWORD or not pysecrets.compare_digest(password.strip(), PASSWORD):
        time.sleep(1)
        return RedirectResponse("/login?bad=1", status_code=302)
    token = _sign(str(int(time.time())))
    resp = RedirectResponse("/", status_code=302)
    resp.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400,
                    httponly=True, samesite="lax", secure=True)
    return resp


@app.get("/logout")
def logout():
    resp = RedirectResponse("/login", status_code=302)
    resp.delete_cookie(COOKIE)
    return resp


# ── pages ──────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def record_page(request: Request, _: None = Depends(require_auth)):
    return templates.TemplateResponse("record.html", {"request": request})


@app.get("/library", response_class=HTMLResponse)
def library_page(request: Request, _: None = Depends(require_auth)):
    return templates.TemplateResponse("library.html", {"request": request})


# ── recordings API ─────────────────────────────────────────────────
_SLUG_RE = re.compile(r"[^A-Za-z0-9._ -]+")
_EXT_BY_MIME = {
    "audio/mp4": "m4a", "audio/aac": "m4a", "audio/x-m4a": "m4a",
    "audio/mpeg": "mp3", "audio/webm": "webm", "audio/ogg": "ogg",
    "audio/wav": "wav", "audio/x-wav": "wav",
}


def _slug(text: str, fallback: str) -> str:
    text = _SLUG_RE.sub("", (text or "").strip()).strip(". ")
    text = re.sub(r"\s+", " ", text)
    return (text or fallback)[:80]


def _meta_path(rid: str) -> Path:
    return REC_DIR / rid / "meta.json"


def _load(rid: str) -> dict | None:
    p = _meta_path(rid)
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    audio = REC_DIR / rid / f"audio.{d['ext']}"
    d["exists"] = audio.exists()
    d["size"] = audio.stat().st_size if audio.exists() else 0
    return d


def _publish(rid: str, meta: dict) -> str | None:
    if not PUBLISH_DIR:
        return None
    dest_dir = Path(PUBLISH_DIR)
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        name = f"{rid}__{_slug(meta['title'], rid)}.{meta['ext']}"
        src = REC_DIR / rid / f"audio.{meta['ext']}"
        shutil.copy2(src, dest_dir / name)
        return str(dest_dir / name)
    except OSError as e:
        log.error("publish failed for %s: %s", rid, e)
        return None


@app.post("/api/upload")
async def upload(
    request: Request,
    audio: UploadFile,
    title: str = Form(""),
    note: str = Form(""),
    duration: float = Form(0.0),
    _: None = Depends(require_auth),
):
    now = datetime.now(TZ)
    rid = now.strftime("%Y%m%d-%H%M%S") + "-" + pysecrets.token_hex(2)
    mime = (audio.content_type or "").split(";")[0].strip().lower()
    ext = _EXT_BY_MIME.get(mime)
    if not ext and audio.filename and "." in audio.filename:
        ext = audio.filename.rsplit(".", 1)[1].lower()[:5]
    ext = ext or "webm"

    folder = REC_DIR / rid
    folder.mkdir(parents=True, exist_ok=True)
    data = await audio.read()
    if not data:
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(400, "empty upload")
    (folder / f"audio.{ext}").write_bytes(data)

    meta = {
        "id": rid,
        "title": (title or "").strip() or now.strftime("Recording %b %-d, %-I:%M %p"),
        "note": (note or "").strip(),
        "created": now.isoformat(),
        "created_epoch": now.timestamp(),
        "duration": round(float(duration or 0), 1),
        "ext": ext,
        "mime": mime,
        "bytes": len(data),
        "orig_filename": audio.filename or "",
    }
    published = _publish(rid, meta)
    if published:
        meta["published_to"] = published
    (folder / "meta.json").write_text(json.dumps(meta, indent=2))
    log.info("saved %s (%s, %.1fs, %d bytes)%s", rid, ext, meta["duration"],
             len(data), " -> " + published if published else "")
    return {"ok": True, "id": rid, "meta": meta}


@app.get("/api/recordings")
def list_recordings(_: None = Depends(require_auth)):
    out = []
    for d in sorted(REC_DIR.iterdir(), reverse=True):
        if d.is_dir() and (d / "meta.json").exists():
            m = _load(d.name)
            if m:
                out.append(m)
    return {"recordings": out, "publish_dir": PUBLISH_DIR or None}


@app.patch("/api/recordings/{rid}")
async def rename_recording(rid: str, request: Request, _: None = Depends(require_auth)):
    m = _load(rid)
    if not m:
        raise HTTPException(404, "not found")
    body = await request.json()
    if "title" in body:
        m["title"] = (body["title"] or "").strip() or m["title"]
    if "note" in body:
        m["note"] = (body["note"] or "").strip()
    (_meta_path(rid)).write_text(json.dumps(m, indent=2))
    return {"ok": True, "meta": m}


@app.delete("/api/recordings/{rid}")
def delete_recording(rid: str, _: None = Depends(require_auth)):
    folder = REC_DIR / rid
    if not (folder / "meta.json").exists():
        raise HTTPException(404, "not found")
    shutil.rmtree(folder, ignore_errors=True)
    return {"ok": True}


@app.get("/media/{rid}")
def media(rid: str, _: None = Depends(require_auth)):
    m = _load(rid)
    if not m or not m["exists"]:
        raise HTTPException(404, "not found")
    audio = REC_DIR / rid / f"audio.{m['ext']}"
    return FileResponse(audio, media_type=m.get("mime") or "application/octet-stream",
                        filename=f"{_slug(m['title'], rid)}.{m['ext']}")
