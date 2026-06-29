# Spotify2YoutubeMusic

A same-origin Node.js + React web app that signs in with Spotify and Google/YouTube, lists your Spotify liked songs, searches matching YouTube music videos, and adds them to a YouTube playlist.

## Local setup

1. Copy `.env.example` to `.env`.
2. Create a Spotify app in the Spotify Developer Dashboard and set the callback URL to `http://localhost:4000/auth/spotify/callback`.
3. In Google Cloud Console, enable **YouTube Data API v3**, configure the OAuth consent screen, create an OAuth **Web application** client, and add `http://localhost:4000/auth/google/callback` as an authorized redirect URI.
4. Fill in `.env` with the Spotify and Google client IDs/secrets.
5. Run `npm run dev` and open `http://localhost:4000`.

The frontend and backend are served from the same origin (`http://localhost:4000`). The React UI is loaded with an import map from `esm.sh`, so there is no dependency install step for local development.

## Matching, batching, and playlist selection

- The app stores successful YouTube matches in `.cache/youtube-matches.json`, keyed by Spotify ISRC when available and otherwise by normalized track/artist text.
- Cached matches skip future expensive `search.list` calls, which helps when you retry failed transfers, split a large library across days, or add the same song to another playlist.
- You can choose an existing YouTube playlist before transfer. If you do not choose one, the app creates or reuses a private playlist named `Spotify2Youtube`.
- Use **Select first 60 for today** to run a daily free-quota-friendly batch, then repeat on later days with the same or another selected playlist.
- If a YouTube match is not found, the frontend shows the missing song list after the transfer finishes so you can search those manually.

## API limits, quota, and cost

- Spotify liked tracks are fetched 50 at a time. Spotify uses a rolling 30-second API window and can return HTTP 429 with a retry header.
- Spotify Web API access is free for this use case, but apps in development mode have quota restrictions. Request extended quota mode if you need production-scale access.
- YouTube Data API v3 uses quota units rather than pay-per-call billing for normal use. The default project quota is free but limited.
- This app estimates YouTube quota as 100 units per uncached `search.list`, 50 units per `playlistItems.insert`, plus small playlist lookup/create overhead. A first-time 50-song transfer can use roughly 7,551 units if every song is found; retries are cheaper when cached matches are reused.
- YouTube Data API manages playlists on YouTube. There is no official public YouTube Music library API, so the app creates or updates a YouTube playlist that is visible in YouTube/YouTube Music rather than editing a hidden YouTube Music-only library.
