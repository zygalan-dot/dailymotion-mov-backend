# Dailymotion to MOV backend

Railway-ready conversion service for `dailymotion-mov.higgsfield.app`.

## Safety and limits

- HTTPS `dailymotion.com` and `dai.ly` links only.
- Public or unlisted videos only; no passwords or browser cookies.
- Requires confirmation that the caller may download the video.
- Defaults: 10 minutes, 90 MB, one active conversion, four queued jobs.
- Files expire after 30 minutes.

## Railway setup

Deploy this directory with its Dockerfile and set:

```text
FRONTEND_ORIGIN=https://dailymotion-mov.higgsfield.app
```

Optional: `MAX_DURATION_SECONDS`, `MAX_OUTPUT_MB`, `MAX_QUEUE`,
`JOB_TTL_MINUTES`, and `RATE_LIMIT_PER_15_MIN`.

Railway provides `PORT`. Generate a public domain and connect that URL to the frontend.

## API

- `GET /health`
- `POST /jobs` with `{ "url": "https://...", "rightsConfirmed": true }`
- `GET /jobs/:id`
- `GET /jobs/:id/download`
- `DELETE /jobs/:id`
