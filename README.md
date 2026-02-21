# Spotifyleave

Spotifyleave is a local web app for migrating playlist songs
from Spotify to YouTube Music.

It lets you:

- Import Spotify playlist data from a browser script.
- Connect to your YouTube Music account using `ytmusicapi`.
- Create/delete YouTube playlists and manage songs.
- Migrate songs in batches while preserving playlist order.
- Compare Spotify vs YouTube track positions and mark resolved diffs.

## Tech Stack

- Frontend: React + Vite
- API: Express (Node.js)
- Persistence: SQLite (`node:sqlite`)
- YouTube integration: Python scripts + `ytmusicapi`

## Requirements

- Node.js 22+ (required for built-in `node:sqlite`)
- pnpm
- Python 3.10+
- `ytmusicapi` Python package

## Setup

- Install Node dependencies:

```bash
pnpm install
```

- Create environment file:

```bash
cp .env.example .env
```

- Install Python dependency:

```bash
python3 -m pip install ytmusicapi
```

- Generate YouTube Music auth JSON with `ytmusicapi` and place it at:

```text
./data/browser.json
```

If you use a different location, update `YTMUSIC_AUTH_FILE` in `.env`.

## Environment Variables

See `.env.example`:

- `YTMUSIC_AUTH_FILE` path to `ytmusicapi` auth JSON
- `YTMUSIC_PYTHON_BIN` Python executable used by the Node API

Optional:

- `PORT` API server port (default: `8787`)
- `YTMUSIC_DEBUG` set to `1/true` to log extra migration diagnostics

## Run Locally

Start frontend + API together:

```bash
pnpm dev
```

Useful scripts:

- `pnpm dev:web` run Vite frontend only
- `pnpm dev:api` run API only
- `pnpm build` build frontend
- `pnpm preview` preview production frontend build

## How It Works

1. Open Spotifyleave and copy the Spotify export script.
2. Run it in your Spotify playlist page browser console.
3. Paste the exported JSON back into Spotifyleave.
4. Connect/load YouTube Music playlists.
5. Migrate selected songs and review ordering diffs.

App state is persisted to `data/spotifyleave.db`.

## Project Structure

- `src/` React frontend
- `server/index.js` Express API + SQLite state management
- `server/ytmusic_load.py` YouTube playlist/song operations
- `server/ytmusic_migrate.py` migration logic and matching
- `data/` local runtime data (ignored by git)

## Notes

- This project runs locally and stores state on your machine.
- Keep `.env` and auth JSON private.

## License

Apache License 2.0 (see `LICENSE`).
