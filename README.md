# Recordings

Open **https://record.halleserver.cc** on your phone, tap the red button, talk,
tap again to stop, add a title, **Save**. The audio lands on bigbox at
`~/homelab/recordings/data/recordings/<id>/`. "Add to Home Screen" and it behaves
like a native app (offline-capable shell, opens straight to the recorder).

Runs as one container (`recordings`) on bigbox, behind Caddy on
`nextcloud.network`. FastAPI + browser `MediaRecorder`, no external services.

## Layout

```
~/homelab/recordings/
  app/                  container build context (FastAPI + PWA front-end)
  recordings.container   Quadlet unit
  data/recordings/       one folder per recording: audio.<ext> + meta.json  (gitignored)
  secrets/               GITIGNORED
    app_password          one line — the sign-in password
    session_key           auto-generated cookie-signing key
```

## Where recordings go

By default they only live in `data/recordings/` and are browsable at
`/library` (play, rename, download, delete).

To **also** copy each finished recording somewhere else (e.g. into an
Audiobookshelf library folder), set `REC_PUBLISH_DIR` to a path that is also
bind-mounted into the container, then restart:

```ini
# recordings.container
Environment=REC_PUBLISH_DIR=/publish
Volume=/media/storage/audiobookshelf/podcasts/Voice Memos:/publish:z
```

```bash
cp recordings.container ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user restart recordings
```

Copies are named `<id>__<title>.<ext>`.

## Setup / rebuild

```bash
podman build -t recordings-app app/
cp recordings.container ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user restart recordings
curl localhost:8099/healthz
```

Caddy: `record.halleserver.cc { import proxy recordings:8000 }` (cert via
Cloudflare DNS-01, covered by the `*.halleserver.cc` A record). After editing
the Caddyfile, `systemctl --user restart caddy` — the file is a bind mount and
`caddy reload` misses a changed inode.

## Change the password

```bash
echo 'new-password' > secrets/app_password
systemctl --user restart recordings   # existing sessions stay valid (session_key unchanged)
```

## Notes

- iOS records `audio/mp4` (`.m4a`); desktop Chrome/Firefox record `audio/webm`.
- HTTPS is required for microphone access — always reach it via the Caddy URL,
  not `bigbox:8099`.
- Sessions last 30 days (signed cookie).
