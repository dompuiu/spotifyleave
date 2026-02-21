#!/usr/bin/env python3

from __future__ import annotations

import importlib
import json
import os
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
        return {}

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        emit_error(
            "Invalid ytmusic payload.",
            code="invalid_input",
            status=400,
            details=str(exc),
        )

    if not isinstance(parsed, dict):
        emit_error("Payload must be a JSON object.", code="invalid_input", status=400)
    return cast(dict[str, Any], parsed)


def safe_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


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


def extract_artist_text(track: dict[str, Any]) -> str:
    artists = track.get("artists")
    if not isinstance(artists, list):
        return ""

    names: list[str] = []
    for artist in artists:
        if isinstance(artist, dict):
            name = safe_str(artist.get("name"))
            if name:
                names.append(name)
    return ", ".join(names)


def extract_album_text(track: dict[str, Any]) -> str:
    album = track.get("album")
    if isinstance(album, dict):
        return safe_str(album.get("name"))
    return ""


def build_song_detail(track: dict[str, Any]) -> dict[str, str] | None:
    title = safe_str(track.get("title"))
    if not title:
        return None

    return {
        "title": title,
        "artist": extract_artist_text(track),
        "album": extract_album_text(track),
        "videoId": safe_str(track.get("videoId")),
        "setVideoId": safe_str(track.get("setVideoId")),
    }


def with_ytmusic() -> Any:
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

    try:
        return ytmusic_constructor(auth_file)
    except Exception as exc:
        emit_error(
            "Failed to initialize ytmusicapi. Check your auth file.",
            code="auth_init_failed",
            status=400,
            details=str(exc),
        )


def handle_status() -> dict[str, Any]:
    with_ytmusic()
    return {"ok": True, "connected": True}


def handle_playlists(ytmusic: Any) -> dict[str, Any]:
    try:
        raw_playlists = ytmusic.get_library_playlists(limit=500)
    except Exception as exc:
        emit_error(
            "Failed to load YouTube Music playlists.",
            code="playlist_load_failed",
            status=502,
            details=str(exc),
        )

    playlists: list[dict[str, Any]] = []
    if isinstance(raw_playlists, list):
        for item in raw_playlists:
            if not isinstance(item, dict):
                continue
            playlist_id = safe_str(item.get("playlistId") or item.get("browseId"))
            if not playlist_id:
                continue
            name = safe_str(item.get("title")) or "Untitled playlist"
            playlists.append({"id": playlist_id, "name": name, "songs": []})

    return {"ok": True, "playlists": playlists}


def handle_playlist_songs(ytmusic: Any, payload: dict[str, Any]) -> dict[str, Any]:
    playlist_id = safe_str(payload.get("playlistId"))
    if not playlist_id:
        emit_error("playlistId is required.", code="invalid_input", status=400)

    try:
        result = ytmusic.get_playlist(playlist_id, limit=5000)
    except Exception as exc:
        emit_error(
            "Failed to load playlist songs.",
            code="song_load_failed",
            status=502,
            details=str(exc),
        )

    tracks = result.get("tracks") if isinstance(result, dict) else []
    song_details: list[dict[str, str]] = []
    if isinstance(tracks, list):
        for track in tracks:
            if not isinstance(track, dict):
                continue
            detail = build_song_detail(track)
            if detail:
                song_details.append(detail)

    songs = [
        f"{detail['artist']} - {detail['title']}"
        if detail.get("artist")
        else detail["title"]
        for detail in song_details
    ]

    return {"ok": True, "songs": songs, "songDetails": song_details}


def handle_create_playlist(ytmusic: Any, payload: dict[str, Any]) -> dict[str, Any]:
    name = safe_str(payload.get("name"))
    if not name:
        emit_error("name is required.", code="invalid_input", status=400)

    description = safe_str(payload.get("description"))

    try:
        playlist_id = ytmusic.create_playlist(
            title=name,
            description=description,
            privacy_status="PRIVATE",
        )
    except Exception as exc:
        emit_error(
            "Failed to create YouTube Music playlist.",
            code="playlist_create_failed",
            status=502,
            details=str(exc),
        )

    created_id = safe_str(playlist_id)
    if not created_id:
        emit_error(
            "YouTube Music returned an invalid playlist ID.",
            code="playlist_create_failed",
            status=502,
        )

    return {
        "ok": True,
        "playlist": {
            "id": created_id,
            "name": name,
            "songs": [],
        },
    }


def normalize_playlist_song_ref(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None

    set_video_id = safe_str(value.get("setVideoId"))
    video_id = safe_str(value.get("videoId"))
    if not set_video_id and not video_id:
        return None

    normalized: dict[str, str] = {}
    if set_video_id:
        normalized["setVideoId"] = set_video_id
    if video_id:
        normalized["videoId"] = video_id
    return normalized


def locate_playlist_song_index(
    tracks: list[Any], song_ref: dict[str, str]
) -> tuple[int, str]:
    target_set_video_id = safe_str(song_ref.get("setVideoId"))
    if target_set_video_id:
        for index, track in enumerate(tracks):
            if not isinstance(track, dict):
                continue
            candidate_set_video_id = safe_str(track.get("setVideoId"))
            if candidate_set_video_id == target_set_video_id:
                return index, candidate_set_video_id

    target_video_id = safe_str(song_ref.get("videoId"))
    if target_video_id:
        for index, track in enumerate(tracks):
            if not isinstance(track, dict):
                continue
            candidate_video_id = safe_str(track.get("videoId"))
            candidate_set_video_id = safe_str(track.get("setVideoId"))
            if candidate_video_id == target_video_id and candidate_set_video_id:
                return index, candidate_set_video_id

    return -1, ""


def operation_explicitly_failed(result: Any) -> bool:
    if result is False:
        return True

    if isinstance(result, dict):
        status = safe_str(result.get("status")).lower()
        if status in {"failed", "error"}:
            return True

        for key in ("ok", "success"):
            if key in result and result.get(key) is False:
                return True

    return False


def handle_remove_playlist_items(
    ytmusic: Any, payload: dict[str, Any]
) -> dict[str, Any]:
    playlist_id = safe_str(payload.get("playlistId"))
    if not playlist_id:
        emit_error("playlistId is required.", code="invalid_input", status=400)

    raw_songs = payload.get("songs")
    if not isinstance(raw_songs, list):
        emit_error("songs must be an array.", code="invalid_input", status=400)

    songs: list[dict[str, str]] = []
    for raw_song in raw_songs:
        normalized_song = normalize_playlist_song_ref(raw_song)
        if normalized_song:
            songs.append(normalized_song)

    if not songs:
        emit_error(
            "songs must include at least one item with setVideoId or videoId.",
            code="invalid_input",
            status=400,
        )

    try:
        try:
            result = ytmusic.remove_playlist_items(playlist_id, videos=songs)
        except TypeError:
            result = ytmusic.remove_playlist_items(playlist_id, songs)
    except Exception as exc:
        emit_error(
            "Failed to delete songs from YouTube Music playlist.",
            code="playlist_song_delete_failed",
            status=502,
            details=str(exc),
        )

    if operation_explicitly_failed(result):
        emit_error(
            "YouTube Music reported failure when deleting playlist songs.",
            code="playlist_song_delete_failed",
            status=502,
            details=json.dumps(result),
        )

    return {"ok": True, "playlistId": playlist_id, "deletedCount": len(songs)}


def handle_delete_playlist(ytmusic: Any, payload: dict[str, Any]) -> dict[str, Any]:
    playlist_id = safe_str(payload.get("playlistId"))
    if not playlist_id:
        emit_error("playlistId is required.", code="invalid_input", status=400)

    try:
        result = ytmusic.delete_playlist(playlist_id)
    except Exception as exc:
        emit_error(
            "Failed to delete YouTube Music playlist.",
            code="playlist_delete_failed",
            status=502,
            details=str(exc),
        )

    if operation_explicitly_failed(result):
        emit_error(
            "YouTube Music reported failure when deleting playlist.",
            code="playlist_delete_failed",
            status=502,
            details=json.dumps(result),
        )

    return {"ok": True, "playlistId": playlist_id}


def handle_insert_video_at_position(
    ytmusic: Any, payload: dict[str, Any]
) -> dict[str, Any]:
    playlist_id = safe_str(payload.get("playlistId"))
    if not playlist_id:
        emit_error("playlistId is required.", code="invalid_input", status=400)

    video_id = safe_str(payload.get("videoId"))
    if not video_id:
        emit_error("videoId is required.", code="invalid_input", status=400)

    expected_index = safe_non_negative_int(payload.get("expectedIndex"))
    if expected_index is None:
        emit_error(
            "expectedIndex must be a non-negative integer.",
            code="invalid_input",
            status=400,
        )

    try:
        before_snapshot = ytmusic.get_playlist(playlist_id, limit=5000)
    except Exception as exc:
        emit_error(
            "Failed to load playlist songs before insert.",
            code="song_load_failed",
            status=502,
            details=str(exc),
        )

    before_tracks = (
        before_snapshot.get("tracks") if isinstance(before_snapshot, dict) else []
    )
    before_set_video_ids: set[str] = set()
    if isinstance(before_tracks, list):
        for track in before_tracks:
            if not isinstance(track, dict):
                continue
            set_video_id = safe_str(track.get("setVideoId"))
            if set_video_id:
                before_set_video_ids.add(set_video_id)

    try:
        ytmusic.add_playlist_items(playlist_id, [video_id], duplicates=False)
    except Exception as exc:
        emit_error(
            "Failed to add video to YouTube Music playlist.",
            code="playlist_song_add_failed",
            status=502,
            details=str(exc),
        )

    after_tracks: list[Any] = []
    inserted_set_video_id = ""
    inserted_index = -1
    fallback_set_video_id = ""
    fallback_index = -1

    for attempt in range(5):
        try:
            after_snapshot = ytmusic.get_playlist(playlist_id, limit=5000)
        except Exception as exc:
            if attempt < 4:
                time.sleep(0.25)
                continue
            emit_error(
                "Video was added but playlist reload failed.",
                code="song_load_failed",
                status=502,
                details=str(exc),
            )

        candidate_tracks = (
            after_snapshot.get("tracks") if isinstance(after_snapshot, dict) else []
        )
        after_tracks = candidate_tracks if isinstance(candidate_tracks, list) else []
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
            if track_video_id != video_id:
                continue

            track_set_video_id = safe_str(track.get("setVideoId"))
            if track_set_video_id and track_set_video_id not in before_set_video_ids:
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
        return {
            "ok": True,
            "playlistId": playlist_id,
            "videoId": video_id,
            "insertedIndex": expected_index,
            "moved": False,
        }

    if not inserted_set_video_id and fallback_set_video_id:
        inserted_set_video_id = fallback_set_video_id
        inserted_index = fallback_index

    if not inserted_set_video_id:
        return {
            "ok": True,
            "playlistId": playlist_id,
            "videoId": video_id,
            "insertedIndex": expected_index,
            "moved": False,
        }

    bounded_expected_index = min(expected_index, len(after_tracks) - 1)
    if inserted_index == bounded_expected_index:
        return {
            "ok": True,
            "playlistId": playlist_id,
            "videoId": video_id,
            "insertedIndex": bounded_expected_index,
            "moved": False,
        }

    successor_index = bounded_expected_index
    if inserted_index >= 0 and inserted_index < bounded_expected_index:
        successor_index = bounded_expected_index + 1

    if successor_index >= len(after_tracks):
        return {
            "ok": True,
            "playlistId": playlist_id,
            "videoId": video_id,
            "insertedIndex": len(after_tracks) - 1,
            "moved": False,
        }

    successor_set_video_id = ""
    for candidate_index in range(successor_index, len(after_tracks)):
        successor_track = after_tracks[candidate_index]
        if not isinstance(successor_track, dict):
            continue
        candidate_set_video_id = safe_str(successor_track.get("setVideoId"))
        if candidate_set_video_id and candidate_set_video_id != inserted_set_video_id:
            successor_set_video_id = candidate_set_video_id
            break

    if not successor_set_video_id:
        return {
            "ok": True,
            "playlistId": playlist_id,
            "videoId": video_id,
            "insertedIndex": len(after_tracks) - 1,
            "moved": False,
        }

    try:
        ytmusic.edit_playlist(
            playlist_id,
            moveItem=(inserted_set_video_id, successor_set_video_id),
        )
    except Exception as exc:
        emit_error(
            "Video was added but could not be moved to requested position.",
            code="playlist_song_move_failed",
            status=502,
            details=str(exc),
        )

    return {
        "ok": True,
        "playlistId": playlist_id,
        "videoId": video_id,
        "insertedIndex": bounded_expected_index,
        "moved": True,
    }


def handle_move_playlist_song(ytmusic: Any, payload: dict[str, Any]) -> dict[str, Any]:
    playlist_id = safe_str(payload.get("playlistId"))
    if not playlist_id:
        emit_error("playlistId is required.", code="invalid_input", status=400)

    raw_song = normalize_playlist_song_ref(payload.get("song"))
    if not raw_song:
        emit_error(
            "song must include setVideoId or videoId.",
            code="invalid_input",
            status=400,
        )

    direction = safe_str(payload.get("direction")).lower()
    if direction not in {"up", "down"}:
        emit_error(
            "direction must be either 'up' or 'down'.",
            code="invalid_input",
            status=400,
        )

    positions = safe_non_negative_int(payload.get("positions"))
    if positions is None or positions <= 0:
        emit_error(
            "positions must be a positive integer.",
            code="invalid_input",
            status=400,
        )

    try:
        snapshot = ytmusic.get_playlist(playlist_id, limit=5000)
    except Exception as exc:
        emit_error(
            "Failed to load playlist songs before move.",
            code="song_load_failed",
            status=502,
            details=str(exc),
        )

    tracks = snapshot.get("tracks") if isinstance(snapshot, dict) else []
    if not isinstance(tracks, list) or len(tracks) < 2:
        return {
            "ok": True,
            "playlistId": playlist_id,
            "moved": False,
            "fromIndex": 0,
            "toIndex": 0,
        }

    current_index, moved_set_video_id = locate_playlist_song_index(tracks, raw_song)
    if current_index < 0 or not moved_set_video_id:
        emit_error(
            "Could not find selected song in playlist.",
            code="playlist_song_not_found",
            status=404,
        )

    if direction == "up":
        steps = min(positions, current_index)
    else:
        steps = min(positions, len(tracks) - 1 - current_index)

    if steps <= 0:
        return {
            "ok": True,
            "playlistId": playlist_id,
            "moved": False,
            "fromIndex": current_index,
            "toIndex": current_index,
        }

    from_index = current_index
    final_index = current_index

    for _ in range(steps):
        if direction == "up":
            predecessor_track = tracks[final_index - 1]
            predecessor_set_video_id = (
                safe_str(predecessor_track.get("setVideoId"))
                if isinstance(predecessor_track, dict)
                else ""
            )
            if not predecessor_set_video_id:
                break

            try:
                ytmusic.edit_playlist(
                    playlist_id,
                    moveItem=(moved_set_video_id, predecessor_set_video_id),
                )
            except Exception as exc:
                emit_error(
                    "Failed to move song in YouTube Music playlist.",
                    code="playlist_song_move_failed",
                    status=502,
                    details=str(exc),
                )

            tracks[final_index - 1], tracks[final_index] = (
                tracks[final_index],
                tracks[final_index - 1],
            )
            final_index -= 1
        else:
            successor_track = tracks[final_index + 1]
            successor_set_video_id = (
                safe_str(successor_track.get("setVideoId"))
                if isinstance(successor_track, dict)
                else ""
            )
            if not successor_set_video_id:
                break

            try:
                ytmusic.edit_playlist(
                    playlist_id,
                    moveItem=(successor_set_video_id, moved_set_video_id),
                )
            except Exception as exc:
                emit_error(
                    "Failed to move song in YouTube Music playlist.",
                    code="playlist_song_move_failed",
                    status=502,
                    details=str(exc),
                )

            tracks[final_index], tracks[final_index + 1] = (
                tracks[final_index + 1],
                tracks[final_index],
            )
            final_index += 1

    return {
        "ok": True,
        "playlistId": playlist_id,
        "moved": final_index != from_index,
        "fromIndex": from_index,
        "toIndex": final_index,
    }


def main() -> None:
    payload = read_payload()
    action = safe_str(payload.get("action")) or "status"

    if action == "status":
        emit(handle_status())

    ytmusic = with_ytmusic()
    if action == "playlists":
        emit(handle_playlists(ytmusic))
    if action == "playlistSongs":
        emit(handle_playlist_songs(ytmusic, payload))
    if action == "createPlaylist":
        emit(handle_create_playlist(ytmusic, payload))
    if action == "removePlaylistItems":
        emit(handle_remove_playlist_items(ytmusic, payload))
    if action == "deletePlaylist":
        emit(handle_delete_playlist(ytmusic, payload))
    if action == "insertVideoAtPosition":
        emit(handle_insert_video_at_position(ytmusic, payload))
    if action == "movePlaylistSong":
        emit(handle_move_playlist_song(ytmusic, payload))

    emit_error("Unknown ytmusic action.", code="invalid_input", status=400)


if __name__ == "__main__":
    main()
