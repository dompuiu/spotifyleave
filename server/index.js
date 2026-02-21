import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equals = trimmed.indexOf('=');
    if (equals < 1) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(path.resolve(__dirname, '../.env'));

const dbDir = path.resolve(__dirname, '../data');
const dbPath = path.join(dbDir, 'spotifyleave.db');
const ytmusicAuthFilePath = path.resolve(process.env.YTMUSIC_AUTH_FILE || path.join(dbDir, 'private', 'ytmusic-auth.json'));
const ytmusicPythonBin = process.env.YTMUSIC_PYTHON_BIN || 'python3';
const ytmusicLoadScriptPath = path.resolve(__dirname, './ytmusic_load.py');
const ytmusicMigrateScriptPath = path.resolve(__dirname, './ytmusic_migrate.py');
const port = Number(process.env.PORT) || 8787;

const STATE_LIMITS = {
  maxPlaylistsPerProvider: 200,
  maxSongsPerPlaylist: 10000,
  maxPlaylistIdLength: 256,
  maxPlaylistNameLength: 512,
  maxSongLength: 1024
};

function isTruthyEnvValue(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const shouldLogYtMusicReplayCommand = isTruthyEnvValue(process.env.YTMUSIC_DEBUG);

fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const app = express();
app.use(express.json({ limit: '2mb' }));

function readState() {
  const row = db.prepare('SELECT data FROM app_state WHERE id = 1').get();
  if (!row) return null;

  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function validatePlaylistArray(value, providerKey) {
  if (!Array.isArray(value)) {
    return { ok: false, message: `${providerKey} must be an array.` };
  }

  if (value.length > STATE_LIMITS.maxPlaylistsPerProvider) {
    return {
      ok: false,
      message: `${providerKey} exceeds limit (${STATE_LIMITS.maxPlaylistsPerProvider} playlists max).`
    };
  }

  for (const [playlistIndex, playlist] of value.entries()) {
    if (!playlist || typeof playlist !== 'object') {
      return { ok: false, message: `${providerKey}[${playlistIndex}] must be an object.` };
    }

    if (typeof playlist.id !== 'string' || typeof playlist.name !== 'string') {
      return { ok: false, message: `${providerKey}[${playlistIndex}] must include string id and name.` };
    }

    if (playlist.id.length > STATE_LIMITS.maxPlaylistIdLength) {
      return {
        ok: false,
        message: `${providerKey}[${playlistIndex}].id exceeds max length (${STATE_LIMITS.maxPlaylistIdLength}).`
      };
    }

    if (playlist.name.length > STATE_LIMITS.maxPlaylistNameLength) {
      return {
        ok: false,
        message: `${providerKey}[${playlistIndex}].name exceeds max length (${STATE_LIMITS.maxPlaylistNameLength}).`
      };
    }

    if (!Array.isArray(playlist.songs)) {
      return { ok: false, message: `${providerKey}[${playlistIndex}].songs must be an array.` };
    }

    if (playlist.songs.length > STATE_LIMITS.maxSongsPerPlaylist) {
      return {
        ok: false,
        message: `${providerKey}[${playlistIndex}].songs exceeds limit (${STATE_LIMITS.maxSongsPerPlaylist} songs max).`
      };
    }

    for (const [songIndex, song] of playlist.songs.entries()) {
      if (typeof song !== 'string') {
        return { ok: false, message: `${providerKey}[${playlistIndex}].songs[${songIndex}] must be a string.` };
      }
      if (song.length > STATE_LIMITS.maxSongLength) {
        return {
          ok: false,
          message: `${providerKey}[${playlistIndex}].songs[${songIndex}] exceeds max length (${STATE_LIMITS.maxSongLength}).`
        };
      }
    }
  }

  return { ok: true, message: '' };
}

function validateState(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, message: 'State payload must be an object.' };
  }

  if (typeof value.persistPlaylists !== 'boolean') {
    return { ok: false, message: 'persistPlaylists must be a boolean.' };
  }

  const spotifyValidation = validatePlaylistArray(value.spotifyPlaylists, 'spotifyPlaylists');
  if (!spotifyValidation.ok) return spotifyValidation;

  const youtubeValidation = validatePlaylistArray(value.youtubePlaylists, 'youtubePlaylists');
  if (!youtubeValidation.ok) return youtubeValidation;

  return { ok: true, message: '' };
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildYtMusicReplayCommand(scriptPath, payload) {
  const payloadText = JSON.stringify(payload || {}, null, 2);
  return [
    `YTMUSIC_AUTH_FILE=${shellSingleQuote(ytmusicAuthFilePath)} ${shellSingleQuote(ytmusicPythonBin)} ${shellSingleQuote(scriptPath)} <<'JSON'`,
    payloadText,
    'JSON'
  ].join('\n');
}

async function runYtMusicScript(scriptPath, payload) {
  if (!fs.existsSync(scriptPath)) {
    const error = new Error(`Required script is missing on the API server: ${scriptPath}`);
    error.status = 500;
    throw error;
  }

  const isMigrationScript = scriptPath === ytmusicMigrateScriptPath;
  const replayCommand = isMigrationScript ? buildYtMusicReplayCommand(scriptPath, payload) : '';
  const requestId = isMigrationScript
    ? `ytm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    : '';

  if (isMigrationScript) {
    console.log(`[ytmusic:migrate] ${requestId} launching migration script`);
    console.log(`[ytmusic:migrate] ${requestId} python=${ytmusicPythonBin} script=${scriptPath}`);
    if (shouldLogYtMusicReplayCommand) {
      console.log(`[ytmusic:migrate] ${requestId} replay command for zsh:`);
      console.log(replayCommand);
    }
  }

  return new Promise((resolve, reject) => {
    const processEnv = {
      ...process.env,
      YTMUSIC_AUTH_FILE: ytmusicAuthFilePath
    };
    const subprocess = spawn(ytmusicPythonBin, [scriptPath], {
      env: processEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    subprocess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    subprocess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    subprocess.on('error', (spawnError) => {
      if (isMigrationScript) {
        console.error(`[ytmusic:migrate] ${requestId} failed to launch: ${spawnError.message}`);
      }
      const error = new Error(`Failed to launch ${ytmusicPythonBin}: ${spawnError.message}`);
      error.status = 500;
      reject(error);
    });

    subprocess.on('close', (exitCode) => {
      let parsed = null;
      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();

      if (isMigrationScript) {
        console.log(
          `[ytmusic:migrate] ${requestId} completed exitCode=${exitCode} stdoutBytes=${Buffer.byteLength(stdout)} stderrBytes=${Buffer.byteLength(stderr)}`
        );
      }

      if (trimmedStdout) {
        try {
          parsed = JSON.parse(trimmedStdout);
        } catch {
          if (isMigrationScript) {
            console.error(`[ytmusic:migrate] ${requestId} invalid JSON stdout`);
            if (trimmedStderr) {
              console.error(`[ytmusic:migrate] ${requestId} stderr: ${trimmedStderr}`);
            }
          }
          const error = new Error(trimmedStderr || 'ytmusic script returned invalid JSON output.');
          error.status = 500;
          reject(error);
          return;
        }
      }

      if (!parsed || parsed.ok !== true) {
        if (isMigrationScript) {
          console.error(`[ytmusic:migrate] ${requestId} migration failed`);
          if (trimmedStderr) {
            console.error(`[ytmusic:migrate] ${requestId} stderr: ${trimmedStderr}`);
          }
          if (parsed) {
            console.error(`[ytmusic:migrate] ${requestId} payload: ${JSON.stringify(parsed)}`);
          }
        }
        const error = new Error(parsed?.error || trimmedStderr || `ytmusic script failed with exit code ${exitCode}`);
        error.status = Number(parsed?.status) || 500;
        if (parsed?.code) error.code = parsed.code;
        if (parsed?.details) error.reason = parsed.details;
        reject(error);
        return;
      }

      if (isMigrationScript) {
        const migratedCount = Array.isArray(parsed?.migrated) ? parsed.migrated.length : 0;
        const failedCount = Array.isArray(parsed?.failed) ? parsed.failed.length : 0;
        console.log(`[ytmusic:migrate] ${requestId} success migrated=${migratedCount} failed=${failedCount}`);
      }

      resolve(parsed);
    });

    subprocess.stdin.write(JSON.stringify(payload || {}));
    subprocess.stdin.end();
  });
}

async function checkYtMusicConnection() {
  if (!fs.existsSync(ytmusicAuthFilePath)) {
    return {
      configured: false,
      connected: false,
      message: `ytmusic auth file not found at ${ytmusicAuthFilePath}. Run ytmusicapi setup and set YTMUSIC_AUTH_FILE if needed.`
    };
  }

  try {
    await runYtMusicScript(ytmusicLoadScriptPath, { action: 'status' });
    return { configured: true, connected: true, message: '' };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      message: error?.message || 'Failed to initialize ytmusicapi with the configured auth file.'
    };
  }
}

function normalizeMigrationSong(song, fallbackSongKey) {
  if (!song || typeof song !== 'object') return null;

  const title = typeof song.title === 'string' ? song.title.trim() : '';
  if (!title) return null;

  const artist = typeof song.artist === 'string' ? song.artist.trim() : '';
  const album = typeof song.album === 'string' ? song.album.trim() : '';
  const songKey = typeof song.songKey === 'string' && song.songKey.trim() ? song.songKey.trim() : fallbackSongKey;
  const rawExpectedIndex = Number(song.expectedIndex);
  const expectedIndex = Number.isInteger(rawExpectedIndex) && rawExpectedIndex >= 0 ? rawExpectedIndex : undefined;

  return {
    songKey,
    title,
    artist,
    album,
    expectedIndex
  };
}

function normalizeMigrationSongs(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((song, index) => normalizeMigrationSong(song, `song-${index}`))
    .filter(Boolean);
}

function normalizeYouTubeDeleteSong(value, fallbackSongKey) {
  if (!value || typeof value !== 'object') return null;

  const setVideoId = typeof value.setVideoId === 'string' ? value.setVideoId.trim() : '';
  const videoId = typeof value.videoId === 'string' ? value.videoId.trim() : '';
  if (!setVideoId && !videoId) return null;

  return {
    songKey: typeof value.songKey === 'string' && value.songKey.trim() ? value.songKey.trim() : fallbackSongKey,
    setVideoId,
    videoId
  };
}

function normalizeYouTubeDeleteSongs(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((song, index) => normalizeYouTubeDeleteSong(song, `song-${index}`))
    .filter(Boolean);
}

async function runYouTubeMusicMigration({ playlistId, songs, preservePosition }) {
  return runYtMusicScript(ytmusicMigrateScriptPath, { playlistId, songs, preservePosition });
}

function sendYouTubeError(res, error) {
  const status = Number(error?.status) || 500;
  const message = error?.message || 'YouTube request failed.';
  res.status(status).json({
    error: message,
    code: error?.code || undefined,
    reason: error?.reason || undefined,
    quota: error?.quota || undefined
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/state', (_req, res) => {
  res.json({ state: readState() });
});

app.put('/api/state', (req, res) => {
  const nextState = req.body;
  const validation = validateState(nextState);

  if (!validation.ok) {
    res.status(400).json({
      error: validation.message || 'Invalid state payload. Expected spotifyPlaylists, youtubePlaylists, and persistPlaylists.'
    });
    return;
  }

  db.prepare(
    `
    INSERT INTO app_state (id, data, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `
  ).run(JSON.stringify(nextState), new Date().toISOString());

  res.json({ ok: true });
});

app.get('/api/youtube/status', async (_req, res) => {
  const status = await checkYtMusicConnection();
  res.json(status);
});

app.get('/api/youtube/playlists', async (_req, res) => {
  try {
    const result = await runYtMusicScript(ytmusicLoadScriptPath, { action: 'playlists' });
    const playlists = Array.isArray(result.playlists) ? result.playlists : [];
    res.json({ playlists });
  } catch (error) {
    sendYouTubeError(res, error);
  }
});

app.post('/api/youtube/playlists', async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'name is required.' });
      return;
    }

    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const result = await runYtMusicScript(ytmusicLoadScriptPath, {
      action: 'createPlaylist',
      name,
      description
    });

    const playlist = result?.playlist;
    if (!playlist || typeof playlist !== 'object' || typeof playlist.id !== 'string') {
      res.status(502).json({ error: 'YouTube Music did not return a valid playlist.' });
      return;
    }

    res.json({ playlist });
  } catch (error) {
    sendYouTubeError(res, error);
  }
});

app.delete('/api/youtube/playlists/:playlistId', async (req, res) => {
  try {
    const playlistId = String(req.params.playlistId || '').trim();
    if (!playlistId) {
      res.status(400).json({ error: 'playlistId is required.' });
      return;
    }

    await runYtMusicScript(ytmusicLoadScriptPath, { action: 'deletePlaylist', playlistId });
    res.json({ ok: true, playlistId });
  } catch (error) {
    sendYouTubeError(res, error);
  }
});

app.get('/api/youtube/playlists/:playlistId/songs', async (req, res) => {
  try {
    const playlistId = String(req.params.playlistId || '');
    if (!playlistId) {
      res.status(400).json({ error: 'playlistId is required.' });
      return;
    }

    const result = await runYtMusicScript(ytmusicLoadScriptPath, { action: 'playlistSongs', playlistId });
    const songs = Array.isArray(result.songs) ? result.songs : [];
    const songDetails = Array.isArray(result.songDetails) ? result.songDetails : [];
    res.json({ songs, songDetails });
  } catch (error) {
    sendYouTubeError(res, error);
  }
});

app.delete('/api/youtube/playlists/:playlistId/songs', async (req, res) => {
  try {
    const playlistId = String(req.params.playlistId || '').trim();
    if (!playlistId) {
      res.status(400).json({ error: 'playlistId is required.' });
      return;
    }

    const songs = normalizeYouTubeDeleteSongs(req.body?.songs);
    if (songs.length === 0) {
      res.status(400).json({ error: 'songs must include at least one item with setVideoId or videoId.' });
      return;
    }

    const result = await runYtMusicScript(ytmusicLoadScriptPath, {
      action: 'removePlaylistItems',
      playlistId,
      songs
    });

    res.json({
      ok: true,
      playlistId,
      deletedCount: Number(result?.deletedCount) || songs.length
    });
  } catch (error) {
    sendYouTubeError(res, error);
  }
});

app.post('/api/youtube/playlists/:playlistId/insert-video', async (req, res) => {
  try {
    const playlistId = String(req.params.playlistId || '').trim();
    if (!playlistId) {
      res.status(400).json({ error: 'playlistId is required.' });
      return;
    }

    const videoId = typeof req.body?.videoId === 'string' ? req.body.videoId.trim() : '';
    if (!videoId) {
      res.status(400).json({ error: 'videoId is required.' });
      return;
    }

    const rawExpectedIndex = Number(req.body?.expectedIndex);
    const expectedIndex = Number.isInteger(rawExpectedIndex) && rawExpectedIndex >= 0 ? rawExpectedIndex : -1;
    if (expectedIndex < 0) {
      res.status(400).json({ error: 'expectedIndex must be a non-negative integer.' });
      return;
    }

    const result = await runYtMusicScript(ytmusicLoadScriptPath, {
      action: 'insertVideoAtPosition',
      playlistId,
      videoId,
      expectedIndex
    });

    res.json({
      ok: true,
      playlistId,
      videoId,
      insertedIndex: Number(result?.insertedIndex),
      moved: Boolean(result?.moved)
    });
  } catch (error) {
    sendYouTubeError(res, error);
  }
});

app.post('/api/youtube/playlists/:playlistId/move-song', async (req, res) => {
  try {
    const playlistId = String(req.params.playlistId || '').trim();
    if (!playlistId) {
      res.status(400).json({ error: 'playlistId is required.' });
      return;
    }

    const song = normalizeYouTubeDeleteSong(req.body?.song, 'song-0');
    if (!song) {
      res.status(400).json({ error: 'song must include setVideoId or videoId.' });
      return;
    }

    const direction = typeof req.body?.direction === 'string' ? req.body.direction.trim().toLowerCase() : '';
    if (direction !== 'up' && direction !== 'down') {
      res.status(400).json({ error: "direction must be either 'up' or 'down'." });
      return;
    }

    const rawPositions = Number(req.body?.positions);
    const positions = Number.isInteger(rawPositions) && rawPositions > 0 ? rawPositions : 1;

    const result = await runYtMusicScript(ytmusicLoadScriptPath, {
      action: 'movePlaylistSong',
      playlistId,
      song,
      direction,
      positions
    });

    res.json({
      ok: true,
      playlistId,
      moved: Boolean(result?.moved),
      fromIndex: Number(result?.fromIndex),
      toIndex: Number(result?.toIndex)
    });
  } catch (error) {
    sendYouTubeError(res, error);
  }
});

app.post('/api/youtube/migrate', async (req, res) => {
  try {
    const playlistId = typeof req.body?.playlistId === 'string' ? req.body.playlistId.trim() : '';
    if (!playlistId) {
      res.status(400).json({ error: 'playlistId is required.' });
      return;
    }

    const songs = normalizeMigrationSongs(req.body?.songs);
    if (songs.length === 0) {
      res.status(400).json({ error: 'songs must be a non-empty array with at least song title values.' });
      return;
    }

    const preservePosition = Boolean(req.body?.preservePosition);

    const result = await runYouTubeMusicMigration({ playlistId, songs, preservePosition });
    res.json({
      playlistId,
      totalRequested: songs.length,
      migrated: Array.isArray(result.migrated) ? result.migrated : [],
      failed: Array.isArray(result.failed) ? result.failed : []
    });
  } catch (error) {
    sendYouTubeError(res, error);
  }
});

app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
  console.log(`SQLite database: ${dbPath}`);
});
