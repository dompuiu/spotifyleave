#!/usr/bin/env python3

from __future__ import annotations

import json
import importlib
import os
import re
import sys
import time
from typing import Any, NoReturn, cast


def emit(payload: dict[str, Any], exit_code: int = 0) -> NoReturn:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    raise SystemExit(exit_code)


def emit_error(
    message: str, *, code: str, status: int = 400, details: str = ""
) -> NoReturn:
    payload: dict[str, Any] = {
        "ok": False,
        "error": message,
        "code": code,
        "status": status,
    }
    if details:
        payload["details"] = details
    emit(payload, 1)


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        emit_error("Missing migration payload.", code="invalid_input", status=400)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        emit_error(
            "Invalid migration payload.",
            code="invalid_input",
            status=400,
            details=str(exc),
        )

    if not isinstance(parsed, dict):
        emit_error("Payload must be a JSON object.", code="invalid_input", status=400)
    return cast(dict[str, Any], parsed)


def normalize(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", " ", value.lower())
    return " ".join(cleaned.split())


def safe_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def is_truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(value, (int, float)):
        return bool(value)
    return False


def safe_non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            parsed = int(stripped)
        except ValueError:
            return None
        return parsed if parsed >= 0 else None
    return None


def extract_artist_text(search_result: dict[str, Any]) -> str:
    artists = search_result.get("artists")
    if isinstance(artists, list):
        names: list[str] = []
        for artist in artists:
            if isinstance(artist, dict):
                name = safe_str(artist.get("name"))
                if name:
                    names.append(name)
            elif isinstance(artist, str):
                name = safe_str(artist)
                if name:
                    names.append(name)
        if names:
            return ", ".join(names)

    fallback = safe_str(search_result.get("artist"))
    return fallback


def score_search_result(
    search_result: dict[str, Any], target_title: str, target_artist: str
) -> int:
    score = 0
    result_title = normalize(safe_str(search_result.get("title")))
    result_artists = normalize(extract_artist_text(search_result))
    title = normalize(target_title)
    artist = normalize(target_artist)

    if title and result_title == title:
        score += 8
    elif title and title in result_title:
        score += 5

    if artist and result_artists == artist:
        score += 5
    elif artist and artist in result_artists:
        score += 3
    elif artist and any(
        token and token in result_artists for token in artist.split(" ")
    ):
        score += 1

    if safe_str(search_result.get("videoId")):
        score += 2

    return score


def artist_match_level(search_result: dict[str, Any], target_artist: str) -> int:
    artist = normalize(target_artist)
    if not artist:
        return 0

    result_artists = normalize(extract_artist_text(search_result))
    if not result_artists:
        return 0

    if result_artists == artist:
        return 3
    if artist in result_artists:
        return 2
    if any(token and token in result_artists for token in artist.split(" ")):
        return 1
    return 0


def album_match_level(search_result: dict[str, Any], target_album: str) -> int:
    album = normalize(target_album)
    if not album:
        return 0

    search_album = search_result.get("album")
    result_album = ""
    if isinstance(search_album, dict):
        result_album = normalize(safe_str(search_album.get("name")))
    elif isinstance(search_album, str):
        result_album = normalize(search_album)

    if not result_album:
        return 0
    if result_album == album:
        return 2
    if album in result_album:
        return 1
    return 0


def pick_best_match(
    results: list[Any],
    title: str,
    artist: str,
    album: str = "",
    require_artist_match: bool = True,
) -> dict[str, Any] | None:
    valid_results = [
        result
        for result in results
        if isinstance(result, dict) and safe_str(result.get("videoId"))
    ]

    if not valid_results:
        return None

    if artist:
        artist_filtered = [
            result for result in valid_results if artist_match_level(result, artist) > 0
        ]
        if artist_filtered:
            valid_results = artist_filtered
        elif require_artist_match:
            return None

    def total_score(item: dict[str, Any]) -> int:
        return score_search_result(item, title, artist) + (
            album_match_level(item, album) * 4
        )

    return max(valid_results, key=total_score)


def migrate_songs(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        ytmusic_module = importlib.import_module("ytmusicapi")
        ytmusic_constructor = getattr(ytmusic_module, "YTMusic")
    except Exception as exc:
        emit_error(
            "ytmusicapi is not installed. Install it with: pip install ytmusicapi",
            code="missing_dependency",
            status=500,
            details=str(exc),
        )

    auth_file = os.environ.get("YTMUSIC_AUTH_FILE", "").strip()
    if not auth_file:
        emit_error(
            "YTMUSIC_AUTH_FILE is not configured.", code="missing_auth_file", status=500
        )

    if not os.path.exists(auth_file):
        emit_error(
            f"Auth file does not exist: {auth_file}",
            code="missing_auth_file",
            status=400,
        )

    playlist_id = safe_str(payload.get("playlistId"))
    if not playlist_id:
        emit_error("playlistId is required.", code="invalid_input", status=400)

    songs = payload.get("songs")
    if not isinstance(songs, list) or not songs:
        emit_error("songs must be a non-empty array.", code="invalid_input", status=400)
    normalized_songs = cast(list[Any], songs)

    try:
        ytmusic = ytmusic_constructor(auth_file)
    except Exception as exc:
        emit_error(
            "Failed to initialize ytmusicapi. Check your auth file.",
            code="auth_init_failed",
            status=400,
            details=str(exc),
        )

    debug_enabled = is_truthy(payload.get("debug")) or is_truthy(
        os.environ.get("YTMUSIC_DEBUG")
    )
    preserve_position = is_truthy(payload.get("preservePosition"))

    pending_migrations: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    debug_searches: list[dict[str, Any]] = []

    for index, song in enumerate(normalized_songs):
        if not isinstance(song, dict):
            failed.append(
                {
                    "songKey": f"song-{index}",
                    "error": "Song payload must be an object.",
                }
            )
            continue

        song_key = safe_str(song.get("songKey")) or f"song-{index}"
        title = safe_str(song.get("title"))
        artist = safe_str(song.get("artist"))
        album = safe_str(song.get("album"))

        if not title:
            failed.append(
                {
                    "songKey": song_key,
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "error": "Song title is required.",
                }
            )
            continue

        query = f"{artist} {title}".strip()

        queries = [query]
        if album:
            queries.append(f"{artist} {title} {album}".strip())

        merged_results: list[Any] = []
        seen_video_ids: set[str] = set()

        try:
            for query_variant in queries:
                variant_results = ytmusic.search(
                    query_variant, filter="songs", limit=20
                )
                if not isinstance(variant_results, list):
                    continue

                for result in variant_results:
                    if not isinstance(result, dict):
                        continue
                    video_id = safe_str(result.get("videoId"))
                    if not video_id or video_id in seen_video_ids:
                        continue
                    seen_video_ids.add(video_id)
                    merged_results.append(result)
        except Exception as exc:
            if debug_enabled:
                debug_searches.append(
                    {
                        "songKey": song_key,
                        "title": title,
                        "artist": artist,
                        "album": album,
                        "query": query,
                        "queries": queries,
                        "error": str(exc),
                    }
                )
            failed.append(
                {
                    "songKey": song_key,
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "error": f"Search failed: {exc}",
                }
            )
            continue

        if debug_enabled:
            debug_searches.append(
                {
                    "songKey": song_key,
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "query": query,
                    "queries": queries,
                    "response": merged_results,
                }
            )

        best_match = pick_best_match(merged_results, title, artist, album)
        if not best_match:
            video_results: list[Any] = []
            seen_video_ids = set()
            try:
                for query_variant in queries:
                    variant_results = ytmusic.search(
                        query_variant, filter="videos", limit=20
                    )
                    if not isinstance(variant_results, list):
                        continue

                    for result in variant_results:
                        if not isinstance(result, dict):
                            continue
                        video_id = safe_str(result.get("videoId"))
                        if not video_id or video_id in seen_video_ids:
                            continue
                        seen_video_ids.add(video_id)
                        video_results.append(result)
            except Exception as exc:
                if debug_enabled:
                    debug_searches.append(
                        {
                            "songKey": song_key,
                            "title": title,
                            "artist": artist,
                            "album": album,
                            "query": query,
                            "queries": queries,
                            "videoFallbackError": str(exc),
                        }
                    )

            if debug_enabled:
                debug_searches.append(
                    {
                        "songKey": song_key,
                        "title": title,
                        "artist": artist,
                        "album": album,
                        "query": query,
                        "queries": queries,
                        "videoFallbackResponse": video_results,
                    }
                )

            best_match = pick_best_match(
                video_results,
                title,
                artist,
                album,
                require_artist_match=False,
            )

        if not best_match:
            failed.append(
                {
                    "songKey": song_key,
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "error": "No matching song found on YouTube Music.",
                }
            )
            continue

        video_id = safe_str(best_match.get("videoId"))
        if not video_id:
            failed.append(
                {
                    "songKey": song_key,
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "error": "Search result did not include a videoId.",
                }
            )
            continue

        pending_migrations.append(
            {
                "songKey": song_key,
                "title": title,
                "artist": artist,
                "album": album,
                "expectedIndex": safe_non_negative_int(song.get("expectedIndex")),
                "videoId": video_id,
                "matchedTitle": safe_str(best_match.get("title")),
                "matchedArtists": extract_artist_text(best_match),
            }
        )

    successful_migrations: list[dict[str, Any]] = []

    if pending_migrations:
        try:
            if not preserve_position:
                ytmusic.add_playlist_items(
                    playlist_id,
                    [song["videoId"] for song in pending_migrations],
                    duplicates=False,
                )
                successful_migrations = list(pending_migrations)
            else:
                for song in pending_migrations:
                    try:
                        before_set_video_ids: set[str] = set()
                        try:
                            before_snapshot = ytmusic.get_playlist(
                                playlist_id, limit=5000
                            )
                            before_tracks = (
                                before_snapshot.get("tracks")
                                if isinstance(before_snapshot, dict)
                                else []
                            )
                            if isinstance(before_tracks, list):
                                for track in before_tracks:
                                    if isinstance(track, dict):
                                        set_video_id = safe_str(track.get("setVideoId"))
                                        if set_video_id:
                                            before_set_video_ids.add(set_video_id)
                        except Exception:
                            before_set_video_ids = set()

                        ytmusic.add_playlist_items(
                            playlist_id,
                            [song["videoId"]],
                            duplicates=False,
                        )

                        successful_migrations.append(song)

                        expected_index = safe_non_negative_int(
                            song.get("expectedIndex")
                        )
                        if expected_index is None:
                            continue

                        # Best-effort repositioning: if this fails, keep the song as migrated
                        # because it was already added to the playlist.
                        try:
                            inserted_set_video_id = ""
                            inserted_index = -1
                            fallback_set_video_id = ""
                            fallback_index = -1

                            after_tracks: list[Any] = []
                            for attempt in range(5):
                                after_snapshot = ytmusic.get_playlist(
                                    playlist_id, limit=5000
                                )
                                candidate_tracks = (
                                    after_snapshot.get("tracks")
                                    if isinstance(after_snapshot, dict)
                                    else []
                                )
                                after_tracks = (
                                    candidate_tracks
                                    if isinstance(candidate_tracks, list)
                                    else []
                                )
                                if not after_tracks:
                                    if attempt < 4:
                                        time.sleep(0.25)
                                    continue

                                inserted_set_video_id = ""
                                inserted_index = -1
                                fallback_set_video_id = ""
                                fallback_index = -1

                                for track_index in range(len(after_tracks) - 1, -1, -1):
                                    track = after_tracks[track_index]
                                    if not isinstance(track, dict):
                                        continue
                                    track_video_id = safe_str(track.get("videoId"))
                                    if track_video_id != song["videoId"]:
                                        continue

                                    track_set_video_id = safe_str(
                                        track.get("setVideoId")
                                    )
                                    if (
                                        track_set_video_id
                                        and track_set_video_id
                                        not in before_set_video_ids
                                    ):
                                        inserted_set_video_id = track_set_video_id
                                        inserted_index = track_index
                                        break

                                    if track_set_video_id and not fallback_set_video_id:
                                        fallback_set_video_id = track_set_video_id
                                        fallback_index = track_index

                                if inserted_set_video_id or fallback_set_video_id:
                                    break
                                if attempt < 4:
                                    time.sleep(0.25)

                            if not after_tracks:
                                continue

                            if not inserted_set_video_id and fallback_set_video_id:
                                inserted_set_video_id = fallback_set_video_id
                                inserted_index = fallback_index

                            if not inserted_set_video_id:
                                continue

                            bounded_expected_index = min(
                                expected_index, len(after_tracks) - 1
                            )
                            if inserted_index == bounded_expected_index:
                                continue

                            successor_set_video_id = ""
                            successor_index = bounded_expected_index
                            if (
                                inserted_index >= 0
                                and inserted_index < bounded_expected_index
                            ):
                                successor_index = bounded_expected_index + 1

                            if successor_index >= len(after_tracks):
                                continue

                            for candidate_index in range(
                                successor_index, len(after_tracks)
                            ):
                                successor_track = after_tracks[candidate_index]
                                if not isinstance(successor_track, dict):
                                    continue

                                candidate_set_video_id = safe_str(
                                    successor_track.get("setVideoId")
                                )
                                if (
                                    candidate_set_video_id
                                    and candidate_set_video_id != inserted_set_video_id
                                ):
                                    successor_set_video_id = candidate_set_video_id
                                    break

                            if not successor_set_video_id:
                                continue

                            ytmusic.edit_playlist(
                                playlist_id,
                                moveItem=(
                                    inserted_set_video_id,
                                    successor_set_video_id,
                                ),
                            )
                        except Exception:
                            continue
                    except Exception as exc:
                        failed.append(
                            {
                                "songKey": song.get("songKey"),
                                "title": song.get("title"),
                                "artist": song.get("artist"),
                                "album": song.get("album"),
                                "error": f"Failed to add song to playlist: {exc}",
                            }
                        )
                        continue
        except Exception as exc:
            failure_message = f"Failed to add songs to playlist: {exc}"
            for song in pending_migrations:
                failed.append(
                    {
                        "songKey": song.get("songKey"),
                        "title": song.get("title"),
                        "artist": song.get("artist"),
                        "album": song.get("album"),
                        "error": failure_message,
                    }
                )
            pending_migrations = []
            successful_migrations = []

    result: dict[str, Any] = {
        "ok": True,
        "playlistId": playlist_id,
        "migrated": successful_migrations,
        "failed": failed,
    }

    if debug_enabled:
        result["debug"] = {
            "enabled": True,
            "searches": debug_searches,
        }

    return result


def main() -> None:
    payload = read_payload()
    result = migrate_songs(payload)
    emit(result)


if __name__ == "__main__":
    main()
