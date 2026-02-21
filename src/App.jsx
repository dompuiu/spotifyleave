import { useEffect, useMemo, useRef, useState } from 'react';

function extractSongIndexFromKey(songKey) {
  if (typeof songKey !== 'string') return -1;
  const separatorIndex = songKey.lastIndexOf('|');
  if (separatorIndex < 0) return -1;
  const index = Number.parseInt(songKey.slice(separatorIndex + 1), 10);
  return Number.isNaN(index) ? -1 : index;
}

const ADD_VIDEO_AT_POSITION_ERROR = 'Failed to add video id at this position.';

const SPOTIFY_EXPORT_SCRIPT = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => el?.textContent?.trim() || null;
  const getId = (href, type) => (href?.match(new RegExp('/' + type + '/([A-Za-z0-9]+)')) || [])[1] || null;
  const grid = document.querySelector('[data-testid="playlist-tracklist"]');
  if (!grid) throw new Error('Playlist tracklist not found.');
  const scroller = grid.closest('[data-overlayscrollbars="host"]')?.querySelector('[data-overlayscrollbars-viewport]') || document.scrollingElement;
  const expected = Math.max((Number(grid.getAttribute('aria-rowcount')) || 1) - 1, 0);
  const seen = new Map();

  scroller.scrollTo(0, 0);
  await sleep(250);

  const parseRow = (row) => {
    const track = row.querySelector('a[data-testid="internal-track-link"]');
    if (!track) return null;
    const artists = [...row.querySelectorAll('[aria-colindex="2"] a[href^="/artist/"]')].map((a) => ({
      name: text(a),
      artistId: getId(a.getAttribute('href'), 'artist')
    }));
    const album = row.querySelector('[aria-colindex="3"] a[href^="/album/"]');
    const dateAdded = text(row.querySelector('[aria-colindex="4"] span'));
    const duration = [...row.querySelectorAll('[aria-colindex="5"] div,[aria-colindex="5"] span')]
      .map(text)
      .find((value) => /^\d{1,2}:\d{2}$/.test(value || '')) || null;

    return {
      position: Number(text(row.querySelector('[aria-colindex="1"] span'))) || null,
      title: text(track),
      trackId: getId(track.getAttribute('href'), 'track'),
      artists,
      album: {
        name: text(album),
        albumId: getId(album?.getAttribute('href'), 'album')
      },
      dateAdded,
      duration
    };
  };

  let loops = 0;
  while (loops < 2000) {
    loops += 1;
    for (const row of grid.querySelectorAll('[data-testid="tracklist-row"]')) {
      const item = parseRow(row);
      if (!item) continue;
      const key = item.trackId || [item.title, item.album?.name, item.artists.map((a) => a.name).join(',')].join('|');
      seen.set(key, item);
    }
    if (expected > 0 && seen.size >= expected) break;
    const prevTop = scroller.scrollTop;
    scroller.scrollBy(0, Math.floor(scroller.clientHeight * 0.85));
    await sleep(220);
    if (Math.abs(scroller.scrollTop - prevTop) < 2) break;
  }

  const playlistTitle =
    text(document.querySelector('[data-testid="entityTitle"]')) ||
    text(document.querySelector('h1')) ||
    document.title ||
    null;

  const payload = {
    playlistTitle,
    playlist: {
      name: playlistTitle,
      uri: document.querySelector('[data-testid="playlist-page"]')?.getAttribute('data-test-uri') || null,
      url: location.href,
      extractedTrackCount: seen.size,
      extractedAt: new Date().toISOString()
    },
    tracks: [...seen.values()].sort((a, b) => (a.position || 1e9) - (b.position || 1e9))
  };

  window.spotifyPlaylistDump = payload;
  console.log(JSON.stringify(payload, null, 2));
  return payload;
})();`;

function isValidPlaylistArray(value) {
  return Array.isArray(value) && value.every((playlist) => playlist && typeof playlist.id === 'string' && Array.isArray(playlist.songs));
}

function normalizeSongDetails(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((song) => {
      if (!song || typeof song !== 'object') return null;
      const title = typeof song.title === 'string' ? song.title.trim() : '';
      if (!title) return null;

      return {
        title,
        artist: typeof song.artist === 'string' ? song.artist.trim() : '',
        album: typeof song.album === 'string' ? song.album.trim() : '',
        videoId: typeof song.videoId === 'string' ? song.videoId.trim() : '',
        setVideoId: typeof song.setVideoId === 'string' ? song.setVideoId.trim() : ''
      };
    })
    .filter(Boolean);
}

function formatSongFromDetail(song) {
  if (!song || typeof song !== 'object') return '';
  const title = typeof song.title === 'string' ? song.title.trim() : '';
  if (!title) return '';

  const artist = typeof song.artist === 'string' ? song.artist.trim() : '';
  return artist ? `${artist} - ${title}` : title;
}

function parseSongString(song) {
  if (typeof song !== 'string') return null;
  const text = song.trim();
  if (!text) return null;

  const separatorIndex = text.indexOf(' - ');
  if (separatorIndex < 0) {
    return { title: text, artist: '', album: '' };
  }

  const artist = text.slice(0, separatorIndex).trim();
  const title = text.slice(separatorIndex + 3).trim();
  if (!title) return { title: text, artist: '', album: '' };

  return { title, artist, album: '' };
}

function normalizeSongKeyPart(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function buildSongKey(songDetail, song, index) {
  const title = normalizeSongKeyPart(songDetail?.title || song);
  const artist = normalizeSongKeyPart(songDetail?.artist);
  const album = normalizeSongKeyPart(songDetail?.album);
  return `${title}|${artist}|${album}|${index}`;
}

function buildComparisonSongKey(songDetail, song) {
  const title = normalizeSongKeyPart(songDetail?.title || song);
  if (!title) return '';

  const artist = normalizeSongKeyPart(songDetail?.artist);
  return `${title}|${artist}`;
}

function buildOrderedPlaylistDiff(sourceSongs, sourceSongDetails, targetSongs, targetSongDetails) {
  const targetSongKeysByIndex = targetSongs.map((song, index) =>
    buildComparisonSongKey(targetSongDetails?.[index], song)
  );
  const targetQueueByKey = new Map();

  targetSongKeysByIndex.forEach((songKey, index) => {
    if (!songKey) return;
    const queue = targetQueueByKey.get(songKey) || [];
    queue.push(index);
    targetQueueByKey.set(songKey, queue);
  });

  const consumedTargetIndexes = new Set();
  const sourceStatuses = sourceSongs.map((song, index) => {
    const songKey = buildComparisonSongKey(sourceSongDetails?.[index], song);
    const queue = songKey ? targetQueueByKey.get(songKey) || [] : [];

    if (queue.length === 0) {
      return {
        type: 'missing-at-position',
        expectedIndex: index,
        actualIndex: -1
      };
    }

    const actualIndex = queue.shift();
    consumedTargetIndexes.add(actualIndex);

    if (actualIndex === index) {
      return {
        type: 'matched',
        expectedIndex: index,
        actualIndex
      };
    }

    return {
      type: 'present-wrong-position',
      expectedIndex: index,
      actualIndex
    };
  });

  const extraTargetIndexes = targetSongs
    .map((_song, index) => index)
    .filter((index) => !consumedTargetIndexes.has(index));

  const summary = sourceStatuses.reduce(
    (acc, status) => {
      if (status.type === 'matched') acc.matched += 1;
      if (status.type === 'missing-at-position') acc.missing += 1;
      if (status.type === 'present-wrong-position') acc.shifted += 1;
      return acc;
    },
    {
      matched: 0,
      missing: 0,
      shifted: 0,
      extras: extraTargetIndexes.length
    }
  );

  return {
    sourceStatuses,
    extraTargetIndexes,
    summary
  };
}

function buildMigrationSongFromSpotifyPlaylist(playlist, songKey) {
  if (!playlist || typeof playlist !== 'object') return null;

  const index = extractSongIndexFromKey(songKey);
  if (index < 0) return null;

  const songText = Array.isArray(playlist.songs) ? playlist.songs[index] : '';
  const detail = Array.isArray(playlist.songDetails) ? playlist.songDetails[index] || parseSongString(songText) : parseSongString(songText);

  const title = typeof detail?.title === 'string' ? detail.title.trim() : '';
  if (!title) return null;

  return {
    songKey,
    title,
    artist: typeof detail?.artist === 'string' ? detail.artist.trim() : '',
    album: typeof detail?.album === 'string' ? detail.album.trim() : '',
    expectedIndex: index
  };
}

function buildYouTubeDeleteSongFromPlaylist(playlist, songKey) {
  if (!playlist || typeof playlist !== 'object') return null;

  const index = extractSongIndexFromKey(songKey);
  if (index < 0) return null;

  const detail = Array.isArray(playlist.songDetails) ? playlist.songDetails[index] : null;
  const setVideoId = typeof detail?.setVideoId === 'string' ? detail.setVideoId.trim() : '';
  const videoId = typeof detail?.videoId === 'string' ? detail.videoId.trim() : '';

  if (!setVideoId && !videoId) return null;

  return {
    songKey,
    setVideoId,
    videoId
  };
}

function extractYouTubeVideoId(rawValue) {
  if (typeof rawValue !== 'string') return '';
  const value = rawValue.trim();
  if (!value) return '';

  const watchMatch = value.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
  if (watchMatch?.[1]) return watchMatch[1];

  const shortMatch = value.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
  if (shortMatch?.[1]) return shortMatch[1];

  const musicMatch = value.match(/music\.youtube\.com\/watch\?.*?[?&]v=([a-zA-Z0-9_-]{6,})/);
  if (musicMatch?.[1]) return musicMatch[1];

  const bareMatch = value.match(/^[a-zA-Z0-9_-]{6,}$/);
  if (bareMatch) return value;

  return '';
}

function normalizeSpotifyPlaylist(playlist) {
  const songs = Array.isArray(playlist?.songs) ? playlist.songs.filter((song) => typeof song === 'string') : [];
  const savedDetails = normalizeSongDetails(playlist?.songDetails);
  const songDetails = savedDetails.length > 0 ? savedDetails : songs.map(parseSongString).filter(Boolean);
  const normalizedSongs = songDetails.length > 0 ? songDetails.map(formatSongFromDetail).filter(Boolean) : songs;

  return {
    id: typeof playlist?.id === 'string' ? playlist.id : '',
    name: typeof playlist?.name === 'string' ? playlist.name : 'Untitled playlist',
    songs: normalizedSongs,
    songDetails,
    migratedSongKeys: Array.isArray(playlist?.migratedSongKeys)
      ? playlist.migratedSongKeys.filter((key) => typeof key === 'string')
      : [],
    diffResolvedSongKeys: Array.isArray(playlist?.diffResolvedSongKeys)
      ? playlist.diffResolvedSongKeys.filter((key) => typeof key === 'string')
      : []
  };
}

function normalizeYoutubePlaylist(playlist) {
  const songDetails = normalizeSongDetails(playlist?.songDetails);
  const songs = Array.isArray(playlist?.songs) ? playlist.songs.filter((song) => typeof song === 'string') : [];
  const normalizedSongs = songDetails.length > 0 ? songDetails.map(formatSongFromDetail).filter(Boolean) : songs;

  return {
    id: typeof playlist?.id === 'string' ? playlist.id : '',
    name: typeof playlist?.name === 'string' ? playlist.name : 'Untitled playlist',
    songs: normalizedSongs,
    songDetails,
    songsLoaded: Boolean(playlist?.songsLoaded) || normalizedSongs.length > 0
  };
}

const LOCAL_STORAGE_STATE_KEY = 'spotifyleave.selected-playlists.v1';

function loadSelectedPlaylistIdsFromLocalStorage() {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_STATE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      spotifyPlaylistId: typeof parsed.spotifyPlaylistId === 'string' ? parsed.spotifyPlaylistId : '',
      youtubePlaylistId: typeof parsed.youtubePlaylistId === 'string' ? parsed.youtubePlaylistId : '',
      isDiffEnabled: Boolean(parsed.isDiffEnabled)
    };
  } catch {
    return null;
  }
}

function saveSelectedPlaylistIdsToLocalStorage(state) {
  try {
    window.localStorage.setItem(LOCAL_STORAGE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota/storage errors and keep app functional.
  }
}

function PanelHeader({ title, connected, onConnect, buttonLabel, disableConnect }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      {buttonLabel ? (
        <button className="btn secondary" onClick={onConnect} disabled={connected || disableConnect}>
          {connected ? 'Connected' : buttonLabel}
        </button>
      ) : null}
    </div>
  );
}

function SongList({
  title,
  songs,
  songDetails = [],
  emptyText,
  selectable = false,
  selectedSongKeys = [],
  migratedSongKeys = [],
  onToggleSong,
  onToggleAll,
  selectOptions = null,
  selectValue = 'all',
  onSelectOptionChange,
  onSelectOptionApply,
  listRef = null,
  diffByIndex = [],
  inlineAfterSongIndex = -1,
  inlineAfterSongContent = null
}) {
  const selectedSet = new Set(selectedSongKeys);
  const migratedSet = new Set(migratedSongKeys);
  const allSongKeys = songs.map((song, index) => buildSongKey(songDetails[index], song, index));
  const isAllSongsSelected = allSongKeys.length > 0 && allSongKeys.every((songKey) => selectedSet.has(songKey));

  return (
    <div className="block">
      <div className="song-list-header">
        <h3>{title}</h3>
        {selectable ? (
          selectOptions && onSelectOptionChange ? (
            <label className="list-select-toggle">
              Select
              <select
                value={selectValue}
                onChange={(event) => onSelectOptionChange(event.target.value)}
                disabled={allSongKeys.length === 0}
              >
                {selectOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn secondary"
                onClick={() => onSelectOptionApply(selectValue)}
                disabled={allSongKeys.length === 0}
              >
                Select
              </button>
            </label>
          ) : (
            <label className="list-checkbox-toggle">
              <input
                type="checkbox"
                checked={isAllSongsSelected}
                onChange={(event) => onToggleAll?.(event.target.checked)}
                disabled={allSongKeys.length === 0}
              />
              Select all
            </label>
          )
        ) : null}
      </div>
      {songs.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <ul className="song-list" ref={listRef}>
          {songs.map((song, index) => {
            const songKey = buildSongKey(songDetails[index], song, index);
            const isSelected = selectedSet.has(songKey);
            const isMigrated = migratedSet.has(songKey);
            const diffStatus = diffByIndex[index] || null;
            const shouldRenderInlineContent = Boolean(inlineAfterSongContent) && index === inlineAfterSongIndex;

            return (
                <li
                  key={`${song}-${index}`}
                  className={`${isMigrated ? 'song-migrated' : ''}${shouldRenderInlineContent ? ' song-with-floating-actions' : ''}`}
                  data-song-index={index}
                >
                  <span className="song-row-control" aria-hidden={!selectable}>
                    {selectable ? (
                      <input
                        type="checkbox"
                        className="song-checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSong?.(songKey)}
                        aria-label={`Select ${songDetails[index]?.title || song}`}
                      />
                    ) : null}
                  </span>
                  <span className="track-number">{index + 1}.</span>
                  <span className="song-text">
                    <span className="song-title-row">
                      <span>{songDetails[index]?.title || song}</span>
                      <span className="song-tag-slot">
                        {isMigrated ? <span className="song-tag">Migrated</span> : null}
                        {diffStatus?.type === 'missing-at-position' ? (
                          <span className="song-tag diff-gap">Gap at #{index + 1}</span>
                        ) : null}
                        {diffStatus?.type === 'present-wrong-position' ? (
                          <span className="song-tag diff-shifted">Found at #{diffStatus.actualIndex + 1}</span>
                        ) : null}
                      </span>
                    </span>
                    {songDetails[index]?.artist || songDetails[index]?.album ? (
                      <span className="song-meta">
                        {[songDetails[index]?.artist, songDetails[index]?.album ? `Album: ${songDetails[index].album}` : '']
                          .filter(Boolean)
                          .join(' | ')}
                      </span>
                    ) : null}
                  </span>
                  {shouldRenderInlineContent ? <span className="song-floating-actions">{inlineAfterSongContent}</span> : null}
                </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function App() {
  const spotifySelectOptions = [
    { value: 'all', label: 'all' },
    { value: '10', label: 'next 10' },
    { value: '20', label: 'next 20' },
    { value: '50', label: 'next 50' },
    { value: '100', label: 'next 100' },
    { value: '200', label: 'next 200' }
  ];

  const [apiStatus, setApiStatus] = useState('connecting');
  const [saveState, setSaveState] = useState('idle');
  const hasLoadedInitialState = useRef(false);
  const hasHydratedLocalState = useRef(false);
  const hasStartedPersistingSelectedPlaylistIds = useRef(false);
  const preferredPlaylistIds = useRef({ spotifyPlaylistId: '', youtubePlaylistId: '' });
  const spotifySongListRef = useRef(null);

  const spotifyConnected = true;
  const [youtubeConnected, setYoutubeConnected] = useState(false);
  const [spotifyPlaylists, setSpotifyPlaylists] = useState([]);

  const [spotifyPlaylistId, setSpotifyPlaylistId] = useState('');
  const [youtubePlaylists, setYoutubePlaylists] = useState([]);
  const [youtubePlaylistId, setYoutubePlaylistId] = useState('');
  const [youtubeNotice, setYoutubeNotice] = useState('');
  const [youtubeError, setYoutubeError] = useState('');
  const [isRefreshingYoutubePlaylists, setIsRefreshingYoutubePlaylists] = useState(false);
  const [isCreatingYoutubePlaylist, setIsCreatingYoutubePlaylist] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState('');
  const [copyState, setCopyState] = useState('idle');
  const [selectedSpotifySongKeys, setSelectedSpotifySongKeys] = useState([]);
  const [spotifySelectValue, setSpotifySelectValue] = useState('all');
  const [selectedYoutubeSongKeys, setSelectedYoutubeSongKeys] = useState([]);
  const [isMigratingSongs, setIsMigratingSongs] = useState(false);
  const [isDeletingYoutubeSongs, setIsDeletingYoutubeSongs] = useState(false);
  const [isMovingYoutubeSong, setIsMovingYoutubeSong] = useState(false);
  const [youtubeMovePositionsInput, setYoutubeMovePositionsInput] = useState('1');
  const [isDeletingYoutubePlaylist, setIsDeletingYoutubePlaylist] = useState(false);
  const [isDiffEnabled, setIsDiffEnabled] = useState(false);
  const [insertVideoModalOpen, setInsertVideoModalOpen] = useState(false);
  const [insertVideoIdInput, setInsertVideoIdInput] = useState('');
  const [isAddingVideoAtPosition, setIsAddingVideoAtPosition] = useState(false);
  const [copySearchQueryState, setCopySearchQueryState] = useState('idle');
  const [floatingYoutubeMessage, setFloatingYoutubeMessage] = useState(null);

  useEffect(() => {
    if (!floatingYoutubeMessage?.text) return undefined;

    const timeoutId = window.setTimeout(() => {
      setFloatingYoutubeMessage(null);
    }, 4000);

    return () => window.clearTimeout(timeoutId);
  }, [floatingYoutubeMessage]);

  function showFloatingYoutubeMessage(text, kind = 'notice') {
    if (!text) return;
    setFloatingYoutubeMessage({ text, kind });
  }

  useEffect(() => {
    const localState = loadSelectedPlaylistIdsFromLocalStorage();
    if (localState) {
      preferredPlaylistIds.current = {
        spotifyPlaylistId: localState.spotifyPlaylistId,
        youtubePlaylistId: localState.youtubePlaylistId
      };
      setIsDiffEnabled(localState.isDiffEnabled);
    }

    hasHydratedLocalState.current = true;
  }, []);

  async function loadYoutubePlaylists(preferredPlaylistId = '') {
    const response = await fetch('/api/youtube/playlists');
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to load YouTube playlists.');
    }

    const playlists = Array.isArray(payload.playlists)
      ? payload.playlists.map(normalizeYoutubePlaylist).filter((playlist) => playlist.id)
      : [];

    setYoutubePlaylists(playlists);
    setYoutubePlaylistId((currentId) => {
      if (preferredPlaylistId && playlists.some((playlist) => playlist.id === preferredPlaylistId)) {
        return preferredPlaylistId;
      }
      if (currentId && playlists.some((playlist) => playlist.id === currentId)) {
        return currentId;
      }
      return playlists[0]?.id || '';
    });
  }

  async function fetchYoutubePlaylistSongs(playlistId) {
    const response = await fetch(`/api/youtube/playlists/${encodeURIComponent(playlistId)}/songs`);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to load songs from YouTube playlist.');
    }

    const songs = Array.isArray(payload.songs) ? payload.songs.filter((song) => typeof song === 'string') : [];
    const songDetails = normalizeSongDetails(payload.songDetails);
    return { songs, songDetails };
  }

  useEffect(() => {
    let cancelled = false;

    async function loadStateFromApi() {
      try {
        const response = await fetch('/api/state');
        if (!response.ok) throw new Error('Failed to fetch API state');

        const payload = await response.json();
        const state = payload?.state;

        if (cancelled) return;

        if (state && isValidPlaylistArray(state.spotifyPlaylists) && state.spotifyPlaylists.length > 0) {
          const playlists = state.spotifyPlaylists.map(normalizeSpotifyPlaylist);
          setSpotifyPlaylists(playlists);

          const preferredSpotifyPlaylistId = preferredPlaylistIds.current.spotifyPlaylistId;
          const selectedSpotifyPlaylist = playlists.find((playlist) => playlist.id === preferredSpotifyPlaylistId);
          setSpotifyPlaylistId(selectedSpotifyPlaylist?.id || playlists[0].id);
        }

        // Intentionally do not hydrate YouTube playlists from persisted /api/state.
        // We load them once from the live YouTube endpoint in loadYouTubeStatus()
        // to avoid startup races that can cause playlist flicker.

        setApiStatus('connected');
      } catch {
        if (cancelled) return;
        setApiStatus('offline');
      } finally {
        if (!cancelled) {
          hasLoadedInitialState.current = true;
        }
      }
    }

    loadStateFromApi();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadYouTubeStatus() {
      try {
        const response = await fetch('/api/youtube/status');
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(payload?.error || 'Failed to load YouTube auth status.');
        }

        if (cancelled) return;

        const isConnected = Boolean(payload.connected);
        setYoutubeConnected(isConnected);

        if (isConnected) {
          setYoutubeNotice('');
          await loadYoutubePlaylists(preferredPlaylistIds.current.youtubePlaylistId);
        } else {
          setYoutubeNotice(
            payload?.message ||
              'ytmusicapi is not ready. Run ytmusicapi auth setup and set YTMUSIC_AUTH_FILE if your auth file is elsewhere.'
          );
        }
      } catch (error) {
        if (cancelled) return;
        setYoutubeConnected(false);
        setYoutubeError(error?.message || 'Failed to initialize YouTube connection.');
      }
    }

    loadYouTubeStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedInitialState.current || apiStatus !== 'connected') {
      return;
    }

    const timeoutId = setTimeout(async () => {
      setSaveState('saving');
      try {
        const response = await fetch('/api/state', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            persistPlaylists: true,
            spotifyPlaylists,
            youtubePlaylists
          })
        });

        if (!response.ok) throw new Error('Failed to save state');
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [spotifyPlaylists, youtubePlaylists, apiStatus]);

  useEffect(() => {
    if (!hasHydratedLocalState.current) {
      return;
    }

    if (!hasStartedPersistingSelectedPlaylistIds.current) {
      if (!spotifyPlaylistId && !youtubePlaylistId) {
        return;
      }
      hasStartedPersistingSelectedPlaylistIds.current = true;
    }

    saveSelectedPlaylistIdsToLocalStorage({
      spotifyPlaylistId,
      youtubePlaylistId,
      isDiffEnabled
    });
  }, [spotifyPlaylistId, youtubePlaylistId, isDiffEnabled]);

  useEffect(() => {
    if (!spotifyPlaylists.some((playlist) => playlist.id === spotifyPlaylistId)) {
      setSpotifyPlaylistId(spotifyPlaylists[0]?.id || '');
    }
  }, [spotifyPlaylists, spotifyPlaylistId]);

  useEffect(() => {
    setSelectedSpotifySongKeys([]);
    setSpotifySelectValue('all');
  }, [spotifyPlaylistId]);

  useEffect(() => {
    if (!youtubePlaylists.some((playlist) => playlist.id === youtubePlaylistId)) {
      setYoutubePlaylistId(youtubePlaylists[0]?.id || '');
    }
  }, [youtubePlaylists, youtubePlaylistId]);

  useEffect(() => {
    setSelectedYoutubeSongKeys([]);
  }, [youtubePlaylistId]);

  useEffect(() => {
    if (!youtubeConnected || !youtubePlaylistId) {
      return;
    }

    const selected = youtubePlaylists.find((playlist) => playlist.id === youtubePlaylistId);
    if (!selected || selected.songsLoaded) {
      return;
    }

    let cancelled = false;

    async function loadSongs() {
      try {
        const { songs, songDetails } = await fetchYoutubePlaylistSongs(youtubePlaylistId);

        if (cancelled) return;

        setYoutubePlaylists((prev) =>
          prev.map((playlist) =>
            playlist.id === youtubePlaylistId
              ? {
                  ...playlist,
                  songs,
                  songDetails,
                  songsLoaded: true
                }
              : playlist
          )
        );
      } catch (error) {
        if (cancelled) return;
        setYoutubeError(error?.message || 'Failed to load songs from YouTube playlist.');
      }
    }

    loadSongs();

    return () => {
      cancelled = true;
    };
  }, [youtubeConnected, youtubePlaylistId, youtubePlaylists]);

  const spotifyPlaylist = spotifyPlaylists.find((p) => p.id === spotifyPlaylistId) || spotifyPlaylists[0];
  const spotifySongs = spotifyPlaylist?.songs ?? [];
  const migratedSpotifySongKeys = spotifyPlaylist?.migratedSongKeys ?? [];
  const youtubePlaylist = youtubePlaylists.find((p) => p.id === youtubePlaylistId);
  const isYoutubePlaylistSongsLoaded = Boolean(youtubePlaylist?.songsLoaded);
  const isLoadingPlaylists = apiStatus === 'connecting';

  const targetSongs = youtubePlaylist?.songs ?? [];
  const spotifySongKeys = useMemo(
    () => spotifySongs.map((song, index) => buildSongKey(spotifyPlaylist?.songDetails?.[index], song, index)),
    [spotifySongs, spotifyPlaylist?.songDetails]
  );
  const firstSelectedSpotifySongIndex = selectedSpotifySongKeys
    .map(extractSongIndexFromKey)
    .reduce((minIndex, songIndex) => {
      if (songIndex < 0) return minIndex;
      if (minIndex < 0) return songIndex;
      return songIndex < minIndex ? songIndex : minIndex;
    }, -1);
  const firstSelectedYoutubeSongIndex = selectedYoutubeSongKeys
    .map(extractSongIndexFromKey)
    .reduce((minIndex, songIndex) => {
      if (songIndex < 0) return minIndex;
      if (minIndex < 0) return songIndex;
      return songIndex < minIndex ? songIndex : minIndex;
    }, -1);
  const selectedSingleSpotifySongKey = selectedSpotifySongKeys.length === 1 ? selectedSpotifySongKeys[0] : '';
  const selectedSingleYoutubeSongKey = selectedYoutubeSongKeys.length === 1 ? selectedYoutubeSongKeys[0] : '';
  const selectedSingleSpotifySongIndex = extractSongIndexFromKey(selectedSingleSpotifySongKey);
  const selectedSingleYoutubeSongIndex = extractSongIndexFromKey(selectedSingleYoutubeSongKey);
  const selectedSingleSpotifySongFallbackDetail =
    selectedSingleSpotifySongIndex >= 0 ? parseSongString(spotifySongs[selectedSingleSpotifySongIndex]) : null;
  const selectedSingleSpotifySongDetail =
    selectedSingleSpotifySongIndex >= 0
      ? spotifyPlaylist?.songDetails?.[selectedSingleSpotifySongIndex] || selectedSingleSpotifySongFallbackDetail
      : null;
  const selectedSingleYoutubeSongDetail =
    selectedSingleYoutubeSongIndex >= 0 ? youtubePlaylist?.songDetails?.[selectedSingleYoutubeSongIndex] || null : null;
  const youtubeSearchQuery = [selectedSingleSpotifySongDetail?.artist, selectedSingleSpotifySongDetail?.title]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ')
    .trim();
  const youtubeSearchUrl = youtubeSearchQuery
    ? `https://music.youtube.com/search?q=${encodeURIComponent(youtubeSearchQuery)}`
    : 'https://music.youtube.com/';
  const showInlineSpotifyActions = firstSelectedSpotifySongIndex >= 0;
  const showInlineYoutubeActions = firstSelectedYoutubeSongIndex >= 0;
  const playlistDiff = useMemo(
    () =>
      buildOrderedPlaylistDiff(
        spotifySongs,
        spotifyPlaylist?.songDetails ?? [],
        targetSongs,
        youtubePlaylist?.songDetails ?? []
      ),
    [spotifySongs, spotifyPlaylist?.songDetails, targetSongs, youtubePlaylist?.songDetails]
  );
  const resolvedDiffSongKeySet = useMemo(
    () => new Set(spotifyPlaylist?.diffResolvedSongKeys ?? []),
    [spotifyPlaylist?.diffResolvedSongKeys]
  );
  const visibleDiffByIndex = useMemo(() => {
    if (!isDiffEnabled || !youtubePlaylist || !isYoutubePlaylistSongsLoaded) return [];

    return playlistDiff.sourceStatuses.map((status, index) => {
      if (resolvedDiffSongKeySet.has(spotifySongKeys[index])) {
        return null;
      }

      return status;
    });
  }, [isDiffEnabled, youtubePlaylist, isYoutubePlaylistSongsLoaded, playlistDiff.sourceStatuses, resolvedDiffSongKeySet, spotifySongKeys]);
  const visibleDiffSummary = useMemo(
    () =>
      visibleDiffByIndex.reduce(
        (acc, status) => {
          if (!status) return acc;
          if (status.type === 'matched') acc.matched += 1;
          if (status.type === 'missing-at-position') acc.missing += 1;
          if (status.type === 'present-wrong-position') acc.shifted += 1;
          return acc;
        },
        {
          matched: 0,
          missing: 0,
          shifted: 0,
          extras: playlistDiff.summary.extras
        }
      ),
    [visibleDiffByIndex, playlistDiff.summary.extras]
  );
  const selectedDiffSongKeys = useMemo(
    () =>
      selectedSpotifySongKeys.filter((songKey) => {
        const index = extractSongIndexFromKey(songKey);
        if (index < 0) return false;
        const status = visibleDiffByIndex[index];
        return status?.type === 'missing-at-position' || status?.type === 'present-wrong-position';
      }),
    [selectedSpotifySongKeys, visibleDiffByIndex]
  );
  const selectedSolvedDiffSongKeys = useMemo(
    () => selectedSpotifySongKeys.filter((songKey) => resolvedDiffSongKeySet.has(songKey)),
    [selectedSpotifySongKeys, resolvedDiffSongKeySet]
  );
  async function handleRefreshYoutubePlaylists() {
    if (!youtubeConnected || isRefreshingYoutubePlaylists) return;

    setYoutubeError('');
    setYoutubeNotice('');
    setIsRefreshingYoutubePlaylists(true);

    try {
      await loadYoutubePlaylists(youtubePlaylistId);
    } catch (error) {
      setYoutubeError(error?.message || 'Failed to refresh YouTube playlists.');
    } finally {
      setIsRefreshingYoutubePlaylists(false);
    }
  }

  async function handleCreateYoutubePlaylistFromSpotifyName() {
    if (!youtubeConnected || isCreatingYoutubePlaylist) return;

    const playlistName = typeof spotifyPlaylist?.name === 'string' ? spotifyPlaylist.name.trim() : '';
    if (!playlistName) {
      showFloatingYoutubeMessage('Pick a Spotify playlist first so we can reuse its name.', 'error');
      return;
    }

    setYoutubeError('');
    setYoutubeNotice('');
    setIsCreatingYoutubePlaylist(true);

    try {
      const response = await fetch('/api/youtube/playlists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: playlistName
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to create YouTube playlist.');
      }

      const createdPlaylistId = typeof payload?.playlist?.id === 'string' ? payload.playlist.id : '';
      await loadYoutubePlaylists(createdPlaylistId);
      showFloatingYoutubeMessage(`Created YouTube playlist "${playlistName}".`);
    } catch (error) {
      showFloatingYoutubeMessage(error?.message || 'Failed to create YouTube playlist.', 'error');
    } finally {
      setIsCreatingYoutubePlaylist(false);
    }
  }

  async function handleCopyScript() {
    setCopyState('idle');
    try {
      await navigator.clipboard.writeText(SPOTIFY_EXPORT_SCRIPT);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  function handleImportSpotifyPlaylist() {
    setImportError('');
    let parsed;
    try {
      parsed = JSON.parse(importJson);
    } catch {
      setImportError('Invalid JSON. Paste the exact JSON output from the Spotify browser script.');
      return;
    }

    if (!parsed || !Array.isArray(parsed.tracks) || parsed.tracks.length === 0) {
      setImportError('JSON must contain a non-empty tracks array.');
      return;
    }

    const songDetails = parsed.tracks
      .map((track) => {
        const title = track?.title?.trim();
        if (!title) return null;
        const artistNames = Array.isArray(track?.artists)
          ? track.artists.map((artist) => artist?.name).filter(Boolean)
          : [];
        const album = typeof track?.album?.name === 'string' ? track.album.name.trim() : '';

        return {
          title,
          artist: artistNames.join(', '),
          album
        };
      })
      .filter(Boolean);

    const songs = songDetails.map((song) => (song.artist ? `${song.artist} - ${song.title}` : song.title));

    if (songs.length === 0) {
      setImportError('Could not find songs in the provided JSON.');
      return;
    }

    const playlistName =
      parsed.playlistTitle ||
      parsed.playlist?.name ||
      `Imported Spotify ${new Date().toLocaleDateString()}`;

    const imported = {
      id: `sp-${Date.now()}`,
      name: playlistName,
      songs,
      songDetails
    };

    setSpotifyPlaylists((prev) => [imported, ...prev]);
    setSpotifyPlaylistId(imported.id);
    setImportModalOpen(false);
    setImportJson('');
    setImportError('');
    setCopyState('idle');
  }

  function handleDeleteCurrentSpotifyPlaylist() {
    if (spotifyPlaylists.length <= 1) {
      window.alert('You need at least one Spotify playlist.');
      return;
    }

    const current = spotifyPlaylists.find((playlist) => playlist.id === spotifyPlaylistId);
    if (!current) return;

    const remaining = spotifyPlaylists.filter((playlist) => playlist.id !== current.id);
    setSpotifyPlaylists(remaining);
    setSpotifyPlaylistId(remaining[0].id);
  }

  function handleToggleSpotifySong(songKey) {
    setSelectedSpotifySongKeys((prev) =>
      prev.includes(songKey) ? prev.filter((key) => key !== songKey) : [...prev, songKey]
    );
  }

  function handleToggleAllSpotifySongs(checked) {
    if (!spotifyPlaylist) {
      setSelectedSpotifySongKeys([]);
      return;
    }

    if (!checked) {
      setSelectedSpotifySongKeys([]);
      return;
    }

    const allSongKeys = spotifySongs
      .map((song, index) => buildSongKey(spotifyPlaylist.songDetails?.[index], song, index));
    setSelectedSpotifySongKeys(allSongKeys);
  }

  function handleSpotifySelectOptionChange(value) {
    setSpotifySelectValue(value);
  }

  function handleSpotifySelectOptionApply(value) {
    setSpotifySelectValue(value);

    if (!spotifyPlaylist) {
      setSelectedSpotifySongKeys([]);
      return;
    }

    const allSongKeys = spotifySongs
      .map((song, index) => buildSongKey(spotifyPlaylist.songDetails?.[index], song, index));

    if (value === 'all') {
      setSelectedSpotifySongKeys(allSongKeys);
      if (allSongKeys.length > 0) {
        window.requestAnimationFrame(() => {
          spotifySongListRef.current?.querySelector('[data-song-index="0"]')?.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });
        });
      }
      return;
    }

    const batchSize = Number.parseInt(value, 10);
    if (Number.isNaN(batchSize) || batchSize <= 0) {
      setSelectedSpotifySongKeys([]);
      return;
    }

    const migratedSet = new Set(migratedSpotifySongKeys);
    const nonMigratedSongKeys = allSongKeys.filter((songKey) => !migratedSet.has(songKey));
    const nextSelectedSongKeys = nonMigratedSongKeys.slice(0, batchSize);
    setSelectedSpotifySongKeys(nextSelectedSongKeys);

    const firstSelectedIndex = nextSelectedSongKeys
      .map(extractSongIndexFromKey)
      .reduce((minIndex, songIndex) => {
        if (songIndex < 0) return minIndex;
        if (minIndex < 0) return songIndex;
        return songIndex < minIndex ? songIndex : minIndex;
      }, -1);

    if (firstSelectedIndex >= 0) {
      window.requestAnimationFrame(() => {
        spotifySongListRef.current
          ?.querySelector(`[data-song-index="${firstSelectedIndex}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  function handleToggleYoutubeSong(songKey) {
    setSelectedYoutubeSongKeys((prev) =>
      prev.includes(songKey) ? prev.filter((key) => key !== songKey) : [...prev, songKey]
    );
  }

  function handleToggleAllYoutubeSongs(checked) {
    if (!youtubePlaylist) {
      setSelectedYoutubeSongKeys([]);
      return;
    }

    if (!checked) {
      setSelectedYoutubeSongKeys([]);
      return;
    }

    const allKeys = targetSongs.map((song, index) => buildSongKey(youtubePlaylist.songDetails?.[index], song, index));
    setSelectedYoutubeSongKeys(allKeys);
  }

  function updateCurrentSpotifyPlaylist(updater) {
    setSpotifyPlaylists((prev) =>
      prev.map((playlist) => {
        if (playlist.id !== spotifyPlaylistId) return playlist;
        return updater(playlist);
      })
    );
  }

  function markSongKeysAsMigrated(songKeys) {
    if (!spotifyPlaylist || !Array.isArray(songKeys) || songKeys.length === 0) return;

    updateCurrentSpotifyPlaylist((playlist) => ({
      ...playlist,
      migratedSongKeys: [...new Set([...(playlist.migratedSongKeys || []), ...songKeys])]
    }));
  }

  function handleMarkSelectedAsMigrated() {
    if (!spotifyPlaylist || selectedSpotifySongKeys.length === 0) return;

    markSongKeysAsMigrated(selectedSpotifySongKeys);
    setSelectedSpotifySongKeys([]);
  }

  function handleUnmarkSelectedAsMigrated() {
    if (!spotifyPlaylist || selectedSpotifySongKeys.length === 0) return;

    updateCurrentSpotifyPlaylist((playlist) => ({
      ...playlist,
      migratedSongKeys: (playlist.migratedSongKeys || []).filter((key) => !selectedSpotifySongKeys.includes(key))
    }));
    setSelectedSpotifySongKeys([]);
  }

  function handleMarkSelectedDiffAsSolved() {
    if (!spotifyPlaylist || selectedDiffSongKeys.length === 0) return;

    updateCurrentSpotifyPlaylist((playlist) => ({
      ...playlist,
      diffResolvedSongKeys: [...new Set([...(playlist.diffResolvedSongKeys || []), ...selectedDiffSongKeys])]
    }));
    setSelectedSpotifySongKeys([]);
  }

  function handleResetSolvedDiffs() {
    if (!spotifyPlaylist) return;

    updateCurrentSpotifyPlaylist((playlist) => ({
      ...playlist,
      diffResolvedSongKeys: []
    }));
  }

  function handleUnmarkSelectedDiffAsSolved() {
    if (!spotifyPlaylist || selectedSolvedDiffSongKeys.length === 0) return;

    updateCurrentSpotifyPlaylist((playlist) => ({
      ...playlist,
      diffResolvedSongKeys: (playlist.diffResolvedSongKeys || []).filter(
        (key) => !selectedSolvedDiffSongKeys.includes(key)
      )
    }));
  }

  async function handleMigrateSelectedSongs() {
    if (!spotifyPlaylist || selectedSpotifySongKeys.length === 0 || isMigratingSongs) return;

    if (!youtubePlaylistId) {
      showFloatingYoutubeMessage('Pick a YouTube playlist before migrating songs.', 'error');
      return;
    }

    const songsToMigrate = selectedSpotifySongKeys
      .map((songKey) => buildMigrationSongFromSpotifyPlaylist(spotifyPlaylist, songKey))
      .filter(Boolean);

    if (songsToMigrate.length === 0) {
      return;
    }

    setIsMigratingSongs(true);
    setYoutubeError('');
    setYoutubeNotice('');

    try {
      const allMigratedSongKeys = [];
      const allFailedItems = [];

      const batchSize = 5;
      for (let start = 0; start < songsToMigrate.length; start += batchSize) {
        const batch = songsToMigrate.slice(start, start + batchSize);
        const response = await fetch('/api/youtube/migrate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            playlistId: youtubePlaylistId,
            songs: batch,
            preservePosition: true
          })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || 'Failed to migrate selected songs.');
        }

        const migratedSongKeys = Array.isArray(payload.migrated)
          ? payload.migrated
              .map((item) => (typeof item?.songKey === 'string' ? item.songKey : ''))
              .filter(Boolean)
          : [];
        const failedItems = Array.isArray(payload.failed) ? payload.failed : [];

        if (migratedSongKeys.length > 0) {
          allMigratedSongKeys.push(...migratedSongKeys);
          markSongKeysAsMigrated(migratedSongKeys);

          const migratedSongKeySet = new Set(migratedSongKeys);
          setSelectedSpotifySongKeys((prev) => prev.filter((songKey) => !migratedSongKeySet.has(songKey)));
        }

        if (failedItems.length > 0) {
          allFailedItems.push(...failedItems);
        }

        try {
          const { songs, songDetails } = await fetchYoutubePlaylistSongs(youtubePlaylistId);
          setYoutubePlaylists((prev) =>
            prev.map((playlist) =>
              playlist.id === youtubePlaylistId
                ? {
                    ...playlist,
                    songs,
                    songDetails,
                    songsLoaded: true
                  }
                : playlist
            )
          );
        } catch {
          setYoutubePlaylists((prev) =>
            prev.map((playlist) =>
              playlist.id === youtubePlaylistId
                ? {
                    ...playlist,
                    songsLoaded: false
                  }
                : playlist
            )
          );
        }
      }

      const migratedCount = allMigratedSongKeys.length;
      const failedCount = allFailedItems.length;

      if (migratedCount > 0) {
        setYoutubeNotice('');
      }

      if (failedCount > 0) {
        const firstFailure = allFailedItems.find((item) => typeof item?.error === 'string' && item.error.trim())?.error || '';
        showFloatingYoutubeMessage(
          firstFailure
            ? `${failedCount} song${failedCount === 1 ? '' : 's'} failed. First error: ${firstFailure}`
            : `${failedCount} song${failedCount === 1 ? '' : 's'} failed during migration.`,
          'error'
        );
      }

      if (migratedCount === 0 && failedCount === 0) {
        showFloatingYoutubeMessage('No songs were migrated.');
      }
    } catch (error) {
      showFloatingYoutubeMessage(error?.message || 'Failed to migrate selected songs.', 'error');
    } finally {
      setIsMigratingSongs(false);
    }
  }

  async function handleDeleteSelectedYoutubeSongs() {
    if (!youtubePlaylist || selectedYoutubeSongKeys.length === 0 || isDeletingYoutubeSongs || isMovingYoutubeSong) return;

    const songs = selectedYoutubeSongKeys
      .map((songKey) => buildYouTubeDeleteSongFromPlaylist(youtubePlaylist, songKey))
      .filter(Boolean);

    if (songs.length === 0) {
      showFloatingYoutubeMessage('Could not resolve selected songs for deletion. Refresh playlist songs and try again.', 'error');
      return;
    }

    setYoutubeError('');
    setYoutubeNotice('');
    setIsDeletingYoutubeSongs(true);

    try {
      const response = await fetch(`/api/youtube/playlists/${encodeURIComponent(youtubePlaylist.id)}/songs`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ songs })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to delete songs from YouTube playlist.');
      }

      const deletedCount = Number(payload?.deletedCount) || songs.length;
      setSelectedYoutubeSongKeys([]);
      await loadYoutubePlaylists(youtubePlaylist.id);
      showFloatingYoutubeMessage(`Deleted ${deletedCount} song${deletedCount === 1 ? '' : 's'} from "${youtubePlaylist.name}".`);
    } catch (error) {
      showFloatingYoutubeMessage(error?.message || 'Failed to delete songs from YouTube playlist.', 'error');
    } finally {
      setIsDeletingYoutubeSongs(false);
    }
  }

  async function handleMoveSelectedYoutubeSong(direction) {
    if (!youtubePlaylist || selectedYoutubeSongKeys.length !== 1 || isMovingYoutubeSong || isDeletingYoutubeSongs) return;
    if (direction !== 'up' && direction !== 'down') return;

    const song = buildYouTubeDeleteSongFromPlaylist(youtubePlaylist, selectedSingleYoutubeSongKey);
    if (!song) {
      showFloatingYoutubeMessage('Could not resolve selected song for move. Refresh playlist songs and try again.', 'error');
      return;
    }

    const parsedPositions = Number.parseInt(youtubeMovePositionsInput, 10);
    const positions = Number.isInteger(parsedPositions) && parsedPositions > 0 ? parsedPositions : 1;

    setYoutubeError('');
    setYoutubeNotice('');
    setIsMovingYoutubeSong(true);

    try {
      const response = await fetch(`/api/youtube/playlists/${encodeURIComponent(youtubePlaylist.id)}/move-song`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          song,
          direction,
          positions
        })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to move selected YouTube song.');
      }

      const moved = Boolean(payload?.moved);
      const toIndex = Number(payload?.toIndex);
      await loadYoutubePlaylists(youtubePlaylist.id);

      if (moved && Number.isInteger(toIndex) && toIndex >= 0) {
        const movedSongText = selectedSingleYoutubeSongDetail?.title || targetSongs[selectedSingleYoutubeSongIndex] || '';
        const movedSongKey = buildSongKey(selectedSingleYoutubeSongDetail, movedSongText, toIndex);
        if (movedSongKey) {
          setSelectedYoutubeSongKeys([movedSongKey]);
        } else {
          setSelectedYoutubeSongKeys([]);
        }
      } else {
        setSelectedYoutubeSongKeys([]);
      }

      if (moved) {
        showFloatingYoutubeMessage(
          `Moved song ${direction} by ${positions} position${positions === 1 ? '' : 's'}.`
        );
      } else {
        showFloatingYoutubeMessage('Song is already at the closest possible position.');
      }
    } catch (error) {
      showFloatingYoutubeMessage(error?.message || 'Failed to move selected YouTube song.', 'error');
    } finally {
      setIsMovingYoutubeSong(false);
    }
  }

  function handleOpenInsertVideoModal() {
    if (!selectedSingleSpotifySongKey) return;
    setInsertVideoIdInput('');
    setCopySearchQueryState('idle');
    setInsertVideoModalOpen(true);
    setYoutubeError('');
    setYoutubeNotice('');
  }

  function handleCloseInsertVideoModal() {
    if (isAddingVideoAtPosition) return;
    setInsertVideoModalOpen(false);
    setInsertVideoIdInput('');
    setCopySearchQueryState('idle');
  }

  async function handleCopyYoutubeSearchQuery() {
    if (!youtubeSearchQuery) return;
    setCopySearchQueryState('idle');
    try {
      await navigator.clipboard.writeText(youtubeSearchQuery);
      setCopySearchQueryState('copied');
    } catch {
      setCopySearchQueryState('failed');
    }
  }

  function handleOpenYouTubeMusicSearch() {
    window.open(youtubeSearchUrl, '_blank', 'noopener,noreferrer');
  }

  async function handleAddVideoIdAtPosition() {
    if (!youtubePlaylistId || selectedSingleSpotifySongIndex < 0 || isAddingVideoAtPosition) return;

    const videoId = extractYouTubeVideoId(insertVideoIdInput);
    if (!videoId) {
      showFloatingYoutubeMessage('Paste a valid YouTube video id or URL first.', 'error');
      return;
    }

    setYoutubeError('');
    setYoutubeNotice('');
    setIsAddingVideoAtPosition(true);

    try {
      const response = await fetch(`/api/youtube/playlists/${encodeURIComponent(youtubePlaylistId)}/insert-video`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          videoId,
          expectedIndex: selectedSingleSpotifySongIndex
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || ADD_VIDEO_AT_POSITION_ERROR);
      }

      setYoutubePlaylists((prev) =>
        prev.map((playlist) =>
          playlist.id === youtubePlaylistId
            ? {
                ...playlist,
                songsLoaded: false
              }
            : playlist
        )
      );
      showFloatingYoutubeMessage(`Added video id at YouTube position #${selectedSingleSpotifySongIndex + 1}.`);
      setInsertVideoModalOpen(false);
      setInsertVideoIdInput('');
      setCopySearchQueryState('idle');
      setSelectedSpotifySongKeys([]);
    } catch (error) {
      const message = error?.message || ADD_VIDEO_AT_POSITION_ERROR;
      showFloatingYoutubeMessage(message, 'error');
    } finally {
      setIsAddingVideoAtPosition(false);
    }
  }

  async function handleDeleteCurrentYoutubePlaylist() {
    if (!youtubePlaylist || isDeletingYoutubePlaylist) return;

    setYoutubeError('');
    setYoutubeNotice('');
    setIsDeletingYoutubePlaylist(true);

    try {
      const response = await fetch(`/api/youtube/playlists/${encodeURIComponent(youtubePlaylist.id)}`, {
        method: 'DELETE'
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to delete YouTube playlist.');
      }

      await loadYoutubePlaylists('');
      showFloatingYoutubeMessage(`Deleted YouTube playlist "${youtubePlaylist.name}".`);
    } catch (error) {
      showFloatingYoutubeMessage(error?.message || 'Failed to delete YouTube playlist.', 'error');
    } finally {
      setIsDeletingYoutubePlaylist(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>Spotify to YouTube Music Migrator</h1>
        <p>Select songs and migrate them directly into your YouTube Music playlist.</p>
        <div className="topbar-status">
          <span className={`status-pill status-${apiStatus}`}>
            {apiStatus === 'connecting' ? 'API: connecting' : null}
            {apiStatus === 'connected'
              ? `API: connected ${saveState === 'saving' ? '(saving...)' : ''}${saveState === 'error' ? '(save failed)' : ''}`
              : null}
            {apiStatus === 'offline' ? 'API: offline (using local data only)' : null}
          </span>
        </div>
      </header>

      <section className="split-layout">
        <article className="panel spotify-panel">
          <PanelHeader
            title="Spotify"
            connected={spotifyConnected}
          />

          <div className="block">
            <div className="field-label-row">
              <label htmlFor="spotify-playlist">Playlist</label>
              <div className="field-label-actions">
                <button className="btn secondary" onClick={() => setImportModalOpen(true)}>
                  Add Playlist
                </button>
                <button className="btn danger" onClick={handleDeleteCurrentSpotifyPlaylist}>
                  Delete Playlist
                </button>
              </div>
            </div>
            <select
              id="spotify-playlist"
              value={spotifyPlaylistId}
              onChange={(event) => setSpotifyPlaylistId(event.target.value)}
              disabled={isLoadingPlaylists || spotifyPlaylists.length === 0}
            >
              {isLoadingPlaylists ? <option value="">Loading playlists...</option> : null}
              {!isLoadingPlaylists && spotifyPlaylists.length === 0 ? <option value="">No playlists yet</option> : null}
              {!isLoadingPlaylists
                ? spotifyPlaylists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>
                      {playlist.name}
                    </option>
                  ))
                : null}
            </select>
          </div>

          <div className="block">
            <label className="list-checkbox-toggle">
              <input
                type="checkbox"
                checked={isDiffEnabled}
                onChange={(event) => setIsDiffEnabled(event.target.checked)}
              />
              Show order diff (Spotify vs YouTube)
            </label>
          </div>

          <SongList
            title="Songs in Spotify Playlist"
            songs={spotifySongs}
            songDetails={spotifyPlaylist?.songDetails ?? []}
            selectable
            selectedSongKeys={selectedSpotifySongKeys}
            migratedSongKeys={migratedSpotifySongKeys}
            onToggleSong={handleToggleSpotifySong}
            onToggleAll={handleToggleAllSpotifySongs}
            selectOptions={spotifySelectOptions}
            selectValue={spotifySelectValue}
            onSelectOptionChange={handleSpotifySelectOptionChange}
            onSelectOptionApply={handleSpotifySelectOptionApply}
            listRef={spotifySongListRef}
            diffByIndex={visibleDiffByIndex}
            inlineAfterSongIndex={showInlineSpotifyActions ? firstSelectedSpotifySongIndex : -1}
            inlineAfterSongContent={
              showInlineSpotifyActions ? (
                <div className="batch-actions inline-batch-actions">
                  <p className="muted">
                    {selectedSpotifySongKeys.length} selected | {migratedSpotifySongKeys.length} migrated |{' '}
                    {Math.max(spotifySongs.length - migratedSpotifySongKeys.length, 0)} remaining
                  </p>
                  <div className="batch-actions-row">
                    <button
                      className="btn"
                      onClick={handleMigrateSelectedSongs}
                      disabled={
                        selectedSpotifySongKeys.length === 0 ||
                        !youtubePlaylistId ||
                        isMigratingSongs
                      }
                    >
                      {isMigratingSongs ? 'Migrating...' : 'Migrate'}
                    </button>
                    {selectedSpotifySongKeys.length === 1 ? (
                      <button
                        className="btn secondary"
                        onClick={handleOpenInsertVideoModal}
                        disabled={!youtubePlaylistId || isMigratingSongs || isAddingVideoAtPosition}
                      >
                        Add Video Id at This Position
                      </button>
                    ) : null}
                    <button
                      className="btn secondary"
                      onClick={handleMarkSelectedAsMigrated}
                      disabled={selectedSpotifySongKeys.length === 0 || isMigratingSongs}
                    >
                      Mark as Migrated
                    </button>
                    <button
                      className="btn secondary"
                      onClick={handleUnmarkSelectedAsMigrated}
                      disabled={selectedSpotifySongKeys.length === 0 || isMigratingSongs}
                    >
                      Unmark as Migrated
                    </button>
                    <button
                      className="btn secondary"
                      onClick={handleMarkSelectedDiffAsSolved}
                      disabled={!isDiffEnabled || selectedDiffSongKeys.length === 0 || isMigratingSongs}
                    >
                      Mark Diff Solved
                    </button>
                    <button
                      className="btn secondary"
                      onClick={handleUnmarkSelectedDiffAsSolved}
                      disabled={!isDiffEnabled || selectedSolvedDiffSongKeys.length === 0 || isMigratingSongs}
                    >
                      Unmark Diff Solved
                    </button>
                  </div>
                </div>
              ) : null
            }
            emptyText={isLoadingPlaylists ? 'Loading songs...' : 'Pick a playlist to see songs.'}
          />

          {isDiffEnabled && youtubePlaylist && isYoutubePlaylistSongsLoaded ? (
            <div className="block diff-summary">
              <p className="muted">
                Order diff | matched: {visibleDiffSummary.matched} | gaps: {visibleDiffSummary.missing} | shifted:{' '}
                {visibleDiffSummary.shifted} | YouTube extras: {visibleDiffSummary.extras} | solved:{' '}
                {(spotifyPlaylist?.diffResolvedSongKeys || []).length}
              </p>
              <div className="batch-actions-row">
                <button
                  className="btn secondary"
                  onClick={handleResetSolvedDiffs}
                  disabled={(spotifyPlaylist?.diffResolvedSongKeys || []).length === 0}
                >
                  Reset Solved Diffs
                </button>
              </div>
            </div>
          ) : null}

          {!showInlineSpotifyActions ? (
            <div className="block batch-actions">
              <p className="muted">
                {selectedSpotifySongKeys.length} selected | {migratedSpotifySongKeys.length} migrated |{' '}
                {Math.max(spotifySongs.length - migratedSpotifySongKeys.length, 0)} remaining
              </p>
              <div className="batch-actions-row">
                <button
                  className="btn"
                  onClick={handleMigrateSelectedSongs}
                  disabled={
                    selectedSpotifySongKeys.length === 0 ||
                    !youtubePlaylistId ||
                    isMigratingSongs
                  }
                >
                  {isMigratingSongs ? 'Migrating...' : 'Migrate'}
                </button>
                {selectedSpotifySongKeys.length === 1 ? (
                  <button
                    className="btn secondary"
                    onClick={handleOpenInsertVideoModal}
                    disabled={!youtubePlaylistId || isMigratingSongs || isAddingVideoAtPosition}
                  >
                    Add Video Id at This Position
                  </button>
                ) : null}
                <button
                  className="btn secondary"
                  onClick={handleMarkSelectedAsMigrated}
                  disabled={selectedSpotifySongKeys.length === 0 || isMigratingSongs}
                >
                  Mark as Migrated
                </button>
                <button
                  className="btn secondary"
                  onClick={handleUnmarkSelectedAsMigrated}
                  disabled={selectedSpotifySongKeys.length === 0 || isMigratingSongs}
                >
                  Unmark as Migrated
                </button>
                <button
                  className="btn secondary"
                  onClick={handleMarkSelectedDiffAsSolved}
                  disabled={!isDiffEnabled || selectedDiffSongKeys.length === 0 || isMigratingSongs}
                >
                  Mark Diff Solved
                </button>
                <button
                  className="btn secondary"
                  onClick={handleUnmarkSelectedDiffAsSolved}
                  disabled={!isDiffEnabled || selectedSolvedDiffSongKeys.length === 0 || isMigratingSongs}
                >
                  Unmark Diff Solved
                </button>
              </div>
            </div>
          ) : null}

        </article>

        <article className="panel youtube-panel">
          <PanelHeader
            title="YouTube Music"
            connected={youtubeConnected}
          />

          {youtubeError ? <p className="error-text">{youtubeError}</p> : null}
          {youtubeNotice ? <p className="muted">{youtubeNotice}</p> : null}

          {youtubeConnected ? (
            <>
              <div className="block">
                <div className="field-label-row">
                  <label htmlFor="youtube-playlist">YouTube Playlist</label>
                  <div className="field-label-actions">
                    <button
                      className="btn secondary"
                      onClick={handleCreateYoutubePlaylistFromSpotifyName}
                      disabled={isLoadingPlaylists || isRefreshingYoutubePlaylists || isCreatingYoutubePlaylist || !spotifyPlaylist}
                    >
                      {isCreatingYoutubePlaylist ? 'Creating...' : 'Create from Spotify'}
                    </button>
                    <button
                      className="btn danger"
                      onClick={handleDeleteCurrentYoutubePlaylist}
                      disabled={isLoadingPlaylists || youtubePlaylists.length === 0 || isDeletingYoutubePlaylist}
                    >
                      {isDeletingYoutubePlaylist ? 'Deleting...' : 'Delete Playlist'}
                    </button>
                  </div>
                </div>
                <select
                  id="youtube-playlist"
                  value={youtubePlaylistId}
                  onChange={(event) => setYoutubePlaylistId(event.target.value)}
                  disabled={isLoadingPlaylists || youtubePlaylists.length === 0}
                >
                  {isLoadingPlaylists ? <option value="">Loading playlists...</option> : null}
                  {!isLoadingPlaylists && youtubePlaylists.length === 0 ? <option value="">No playlists yet</option> : null}
                  {!isLoadingPlaylists
                    ? youtubePlaylists.map((playlist) => (
                        <option key={playlist.id} value={playlist.id}>
                          {playlist.name}
                        </option>
                      ))
                    : null}
                </select>
              </div>

              <div className="youtube-song-list-offset" aria-hidden="true" />
              {floatingYoutubeMessage?.text ? (
                <div
                  className={`youtube-floating-message ${floatingYoutubeMessage.kind === 'error' ? 'is-error' : 'is-notice'}`}
                  role={floatingYoutubeMessage.kind === 'error' ? 'alert' : 'status'}
                  aria-live={floatingYoutubeMessage.kind === 'error' ? 'assertive' : 'polite'}
                >
                  {floatingYoutubeMessage.text}
                </div>
              ) : null}

              <SongList
                title="Songs in YouTube Playlist"
                songs={targetSongs}
                songDetails={youtubePlaylist?.songDetails ?? []}
                selectable
                selectedSongKeys={selectedYoutubeSongKeys}
                onToggleSong={handleToggleYoutubeSong}
                onToggleAll={handleToggleAllYoutubeSongs}
                inlineAfterSongIndex={showInlineYoutubeActions ? firstSelectedYoutubeSongIndex : -1}
                inlineAfterSongContent={
                  showInlineYoutubeActions ? (
                    <div className="batch-actions inline-batch-actions">
                      <p className="muted">
                        {selectedYoutubeSongKeys.length} selected | {targetSongs.length} total
                      </p>
                      <div className="batch-actions-row">
                        {selectedYoutubeSongKeys.length === 1 ? (
                          <>
                            <label className="move-position-input">
                              Move by
                              <input
                                type="number"
                                min="1"
                                step="1"
                                value={youtubeMovePositionsInput}
                                onChange={(event) => setYoutubeMovePositionsInput(event.target.value)}
                                aria-label="Move selected song by number of positions"
                              />
                              <span>position(s)</span>
                            </label>
                            <button
                              className="btn secondary"
                              onClick={() => handleMoveSelectedYoutubeSong('up')}
                              disabled={isMovingYoutubeSong || isDeletingYoutubeSongs}
                            >
                              {isMovingYoutubeSong ? 'Moving...' : 'Move Up'}
                            </button>
                            <button
                              className="btn secondary"
                              onClick={() => handleMoveSelectedYoutubeSong('down')}
                              disabled={isMovingYoutubeSong || isDeletingYoutubeSongs}
                            >
                              {isMovingYoutubeSong ? 'Moving...' : 'Move Down'}
                            </button>
                          </>
                        ) : null}
                        <button
                          className="btn danger"
                          onClick={handleDeleteSelectedYoutubeSongs}
                          disabled={selectedYoutubeSongKeys.length === 0 || isDeletingYoutubeSongs || isMovingYoutubeSong}
                        >
                          {isDeletingYoutubeSongs ? 'Deleting Songs...' : 'Delete Selected Songs'}
                        </button>
                      </div>
                    </div>
                  ) : null
                }
                emptyText={isLoadingPlaylists ? 'Loading songs...' : 'No songs yet. New playlists start empty.'}
              />

              <button
                className="btn secondary playlist-refresh-btn"
                onClick={handleRefreshYoutubePlaylists}
                disabled={isLoadingPlaylists || isRefreshingYoutubePlaylists}
              >
                {isRefreshingYoutubePlaylists ? 'Refreshing...' : 'Refresh'}
              </button>

            </>
          ) : (
            <div className="block well">
              <p>
                Add a valid ytmusic auth file to browse playlists and songs, or paste a target playlist ID below and
                migrate selected songs directly.
              </p>
              <label htmlFor="youtube-playlist-id-manual">Target YouTube Playlist ID</label>
              <input
                id="youtube-playlist-id-manual"
                value={youtubePlaylistId}
                onChange={(event) => setYoutubePlaylistId(event.target.value)}
                placeholder="PL..."
              />
            </div>
          )}
        </article>
      </section>

      {insertVideoModalOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="insert-video-modal-title">
          <div className="modal-card">
            <h2 id="insert-video-modal-title">Add Video Id at This Position</h2>
            <p className="muted">
              Position #{selectedSingleSpotifySongIndex + 1} | {selectedSingleSpotifySongDetail?.artist || 'Unknown artist'} -{' '}
              {selectedSingleSpotifySongDetail?.title || 'Unknown title'}
            </p>

            <div className="block">
              <label htmlFor="youtube-search-query">YouTube Music search query</label>
              <textarea
                id="youtube-search-query"
                className="json-input search-query-input"
                value={youtubeSearchQuery}
                readOnly
              />
            </div>

            <div className="modal-actions-row">
              <button className="btn secondary" onClick={handleCopyYoutubeSearchQuery} disabled={!youtubeSearchQuery}>
                Copy Query
              </button>
              <button className="btn secondary" onClick={handleOpenYouTubeMusicSearch} disabled={!youtubeSearchQuery}>
                Open YouTube Music Search
              </button>
              {copySearchQueryState === 'copied' ? <span className="muted">Query copied.</span> : null}
              {copySearchQueryState === 'failed' ? <span className="muted">Could not copy query.</span> : null}
            </div>

            <div className="block">
              <label htmlFor="video-id-input">Video id (or YouTube URL)</label>
              <textarea
                id="video-id-input"
                className="json-input video-id-input"
                value={insertVideoIdInput}
                onChange={(event) => setInsertVideoIdInput(event.target.value)}
                placeholder="Paste video id or full YouTube URL"
              />
            </div>

            <div className="modal-footer">
              <button className="btn secondary" onClick={handleCloseInsertVideoModal} disabled={isAddingVideoAtPosition}>
                Cancel
              </button>
              <button className="btn" onClick={handleAddVideoIdAtPosition} disabled={isAddingVideoAtPosition || !youtubePlaylistId}>
                {isAddingVideoAtPosition ? 'Adding...' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {importModalOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="import-modal-title">
          <div className="modal-card">
            <h2 id="import-modal-title">Import Spotify Playlist JSON</h2>
            <ol className="instruction-list">
              <li>Open your Spotify playlist in the browser.</li>
              <li>Open DevTools Console.</li>
              <li>Click Copy Script, run it in Spotify, then copy the JSON from console.</li>
              <li>Paste JSON below and click Save Playlist.</li>
            </ol>

            <div className="modal-actions-row">
              <button className="btn" onClick={handleCopyScript}>
                Copy Script
              </button>
              {copyState === 'copied' ? <span className="muted">Script copied.</span> : null}
              {copyState === 'failed' ? <span className="muted">Could not copy. Use manual copy from code.</span> : null}
            </div>

            <textarea
              className="json-input"
              value={importJson}
              onChange={(event) => setImportJson(event.target.value)}
              placeholder="Paste playlist JSON here"
            />

            {importError ? <p className="error-text">{importError}</p> : null}

            <div className="modal-footer">
              <button
                className="btn secondary"
                onClick={() => {
                  setImportModalOpen(false);
                  setImportError('');
                }}
              >
                Cancel
              </button>
              <button className="btn" onClick={handleImportSpotifyPlaylist}>
                Save Playlist
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
