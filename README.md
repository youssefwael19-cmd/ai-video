# Motion Studio

One product photo in, one 15-second product video out. Three 5-second beats are
generated across a pool of free AI video providers, then stitched into an exact
15.0s h.264 MP4 with ffmpeg. Beats that no provider can render are filled by a
local Ken Burns motion pass, so a render always completes.

## Run locally

```bash
npm ci
npm run dev          # http://localhost:3000
```

No keys are required: Hugging Face Spaces answers anonymous callers on a small
shared daily GPU quota. Adding keys in the **Settings** tab (or via env) gives
each provider its own free allowance, so more beats come back as AI video.

Other commands:

```bash
npm run typecheck
npm run build        # builds the client into dist/
npm start            # serves dist/ + the API (NODE_ENV=production)
```

## Configuration

Everything is optional; see [`.env.example`](.env.example) for signup links.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listener, bound to `0.0.0.0` |
| `DATA_DIR` | `./data` | Uploads, intermediate beats, renders, `settings.json` |
| `HUGGING_FACE_TOKEN` | – | Raises the anonymous Spaces quota |
| `NOVITA_API_KEY` | – | Novita AI free signup credits |
| `MAGIC_HOUR_API_KEY` | – | Magic Hour free-tier credits |
| `REPLICATE_API_TOKEN` | – | Replicate free test runs |
| `AGNES_API_KEY` | – | Agnes AI free trial model |
| `ATMEE_API_KEY` | – | Atmee Free plan |
| `PUBLIC_IMAGE_URL_OVERRIDE` | – | Serve photos from your own host instead of catbox/tmpfiles |
| `ENABLE_LOCAL_FALLBACK` | `true` | Set `false` to fail instead of filling beats locally |
| `SETTINGS_PASSWORD` | – | Locks the Settings tab when set |

Keys pasted in the Settings tab are written to `DATA_DIR/settings.json` (mode
0600) and override the matching env var; that file is what makes an in-app key
survive a restart. Clearing a slot removes the key.

## API

- `POST /api/jobs` — multipart `image`, plus `brief`, `style`, `aspect`
- `GET /api/jobs/:id` — status, per-beat provider, log
- `GET /api/state` — provider pool and health
- `GET|POST /api/settings` — key slots (`x-settings-password` when locked)
- `POST /api/settings/test` — check a key with a read-only provider call (no render, no credits)
- `GET /healthz` — liveness
- `GET /media/renders/<id>.mp4` — finished video (`?download=1` to attach)

## Deploying

The app needs Node 20 and a writable data volume. It bundles its own ffmpeg
binary (`ffmpeg-static`), so no system ffmpeg is needed. It is a long-running
Express server, not a static site or a serverless function.

```bash
npm ci
npm run build
NODE_ENV=production PORT=3000 DATA_DIR=/data npm start
```

A `Dockerfile` is included:

```bash
docker build -t motion-studio .
docker run -p 3000:3000 -v motion-data:/data motion-studio
```

Host notes:

- Mount `DATA_DIR` on persistent storage, otherwise keys pasted in Settings and
  finished renders disappear on redeploy.
- Health checks should hit `/healthz`.
- Jobs live in memory, so a restart drops in-flight and previous jobs (their
  video files stay on disk until pruned).
- Built-in retention: uploads and intermediate beats are deleted after 24h,
  renders after 7 days; at most 100 job records are kept.
- `SETTINGS_PASSWORD` protects only the Settings API. The render endpoints are
  open — put the whole app behind your host's auth or a private network before
  publishing it to the open internet, otherwise anyone can spend your provider
  quota.
