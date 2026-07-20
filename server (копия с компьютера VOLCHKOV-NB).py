#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Локальный сервер проекта: статические файлы + SQLite API.

Запуск:
  python server.py

При первом запуске база data/archive.sqlite3 создаётся автоматически и
заполняется из data/events.csv, если таблица событий пустая.
"""
from __future__ import annotations

import csv
import datetime
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "archive.sqlite3"
CSV_PATH = DATA_DIR / "events.csv"
TIMELINE_JSON_PATH = DATA_DIR / "timeline_data.json"
SCALE_JSON_PATH = DATA_DIR / "scale_data.json"
UPLOADS_DIR = DATA_DIR / "uploads"
MIGRATIONS_DIR = ROOT / "migrations"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
UPLOAD_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".svg",
    ".mp4",
    ".webm",
    ".mp3",
    ".wav",
    ".pdf",
    ".doc",
    ".docx",
}
UPLOAD_MIME_PREFIXES = ("image/", "video/", "audio/", "application/pdf")

HASHTAG_RE = re.compile(r"^[\w-]+$", re.UNICODE)

EVENT_COLUMNS = [
    "id",
    "hashtag",
    "start_year",
    "start_month",
    "start_day",
    "end_year",
    "end_month",
    "end_day",
    "start_date_precision",
    "end_date_precision",
    "start_date_approximate",
    "end_date_approximate",
    "headline",
    "summary",
    "text",
    "media_url",
    "media_caption",
    "media_credit",
    "group",
    "tags",
    "importance",
    "status",
    "verification_status",
    "event_type",
    "scale",
    "domain",
    "category",
    "subcategory",
    "country_name",
    "region",
    "city",
    "related_events",
    "attached_to",
    "composite_headline",
    "use_composite_headline",
    "attachment_order",
]

EVENT_STATUSES = {"draft", "review", "published"}
VERIFICATION_STATUSES = {"verified", "needs_review", "disputed", "unconfirmed"}
DATE_PRECISION_VALUES = {"day", "month", "year", "approximate"}
SCALE_VALUES = {"local", "national", "regional", "international"}

EVENT_TIMELINE_META = {
    "hashtag": "_hashtag",
    "summary": "_summary",
    "event_type": "_event_type",
    "scale": "_scale",
    "domain": "_domain",
    "category": "_category",
    "subcategory": "_subcategory",
    "country_name": "_country_name",
    "region": "_region",
    "city": "_city",
    "verification_status": "_verification_status",
    "start_date_precision": "_start_date_precision",
    "end_date_precision": "_end_date_precision",
    "start_date_approximate": "_start_date_approximate",
    "end_date_approximate": "_end_date_approximate",
    "related_events": "_related_events",
}
USER_ROLES = {"admin", "editor", "viewer"}
SESSION_COOKIE = "archive_session"
SESSION_TTL_SECONDS = 60 * 60 * 12
PASSWORD_ITERATIONS = 120_000

EVENT_LINKS = {
    "source_ids": ("event_sources", "source_id"),
    "media_ids": ("event_media", "media_id"),
    "tag_ids": ("event_tags", "tag_id"),
    "group_ids": ("event_groups", "group_id"),
}

REFERENCE_CONFIG = {
    "sources": {
        "table": "sources",
        "columns": [
            "id",
            "title",
            "url",
            "type",
            "author",
            "source_date",
            "citation",
            "reliability_score",
            "evidence_quote",
        ],
        "required": ["id", "title"],
        "order": "title, id",
    },
    "media": {
        "table": "media",
        "columns": ["id", "url", "type", "caption", "credit", "license", "alt_text"],
        "required": ["id", "url"],
        "order": "id",
    },
    "tags": {
        "table": "tags",
        "columns": ["id", "name", "slug", "description"],
        "required": ["id", "name"],
        "order": "name, id",
    },
    "groups": {
        "table": "groups",
        "columns": ["id", "name", "slug", "description", "parent_id"],
        "required": ["id", "name"],
        "order": "COALESCE(parent_id, id), parent_id IS NOT NULL, name, id",
    },
}

DRAFT_BATCH_COLUMNS = ["id", "title", "target_date", "status"]

DRAFT_EVENT_COLUMNS = [
    "id",
    "batch_id",
    "row_order",
    "headline",
    "start_year",
    "start_month",
    "start_day",
    "start_date_precision",
    "summary",
    "text",
    "event_type",
    "scale",
    "domain",
    "country_name",
    "region",
    "city",
    "import_status",
    "imported_event_id",
]

DRAFT_SOURCE_COLUMNS = [
    "id",
    "draft_event_id",
    "title",
    "url",
    "type",
    "author",
    "source_date",
    "citation",
    "reliability_score",
    "evidence_quote",
    "imported_source_id",
]


def _int_or_none(value: str | None) -> int | None:
    value = (value or "").strip()
    return int(value) if value else None


def _row_get(row: dict[str, object], key: str) -> str:
    value = row.get(key)
    if value is not None and str(value).strip() != "":
        return str(value).strip()
    bom_key = "\ufeff" + key
    value = row.get(bom_key)
    return str(value).strip() if value is not None else ""


def get_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def ensure_migrations_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def applied_migrations(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
    return {str(row["version"]) for row in rows}


def run_migrations(conn: sqlite3.Connection) -> None:
    ensure_migrations_table(conn)
    applied = applied_migrations(conn)
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    for path in migration_files:
        version = path.stem
        if version in applied:
            continue
        sql = path.read_text(encoding="utf-8")
        conn.executescript(sql)
        conn.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))


def init_db() -> None:
    with get_db() as conn:
        run_migrations(conn)
        seed_default_users(conn)
        count = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        if count == 0 and CSV_PATH.exists():
            import_csv(conn, CSV_PATH)
        write_timeline_files(conn)


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, iterations, salt, expected = stored_hash.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), int(iterations))
        return hmac.compare_digest(digest.hex(), expected)
    except Exception:
        return False


def seed_default_users(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if count:
        return
    defaults = [
        ("usr-001", "Администратор", "admin@archive.local", "admin", "admin"),
        ("usr-002", "Редактор", "editor@archive.local", "editor", "editor"),
    ]
    for user_id, name, email, role, password in defaults:
        conn.execute(
            """
            INSERT INTO users (id, name, email, role, password_hash, active)
            VALUES (?, ?, ?, ?, ?, 1)
            """,
            (user_id, name, email, role, hash_password(password)),
        )


def normalize_flag(value: object) -> str:
    return "1" if str(value or "").strip().lower() in {"1", "true", "yes"} else "0"


def normalize_hashtag(value: str) -> str:
    value = (value or "").strip()
    if value.startswith("#"):
        value = value[1:].strip()
    if not value:
        return ""
    if not HASHTAG_RE.fullmatch(value):
        raise ValueError(
            "Хештег может содержать только буквы, цифры, дефис и подчёркивание, без пробелов."
        )
    return value


def _validate_side_precision(
    label: str,
    precision: str,
    day: int | None,
    month: int | None,
    year: int | None,
    approximate_key: str,
    event: dict[str, object],
) -> None:
    if not precision:
        return
    if precision not in DATE_PRECISION_VALUES:
        raise ValueError(f"Недопустимая точность даты ({label}).")
    if precision == "day" and day is None:
        raise ValueError(f"Точность «День» ({label}) требует день.")
    if precision == "month" and month is None:
        raise ValueError(f"Точность «Месяц» ({label}) требует месяц.")
    if precision == "day" and month is None and day is not None:
        raise ValueError(f"Точность «День» ({label}) требует месяц.")
    if precision == "approximate" and year is not None and event.get(approximate_key) != "1":
        event[approximate_key] = "1"


def validate_event_dates(event: dict[str, object]) -> None:
    start_day = _int_or_none(str(event.get("start_day") or ""))
    start_month = _int_or_none(str(event.get("start_month") or ""))
    start_year = _int_or_none(str(event.get("start_year") or ""))
    end_day = _int_or_none(str(event.get("end_day") or ""))
    end_month = _int_or_none(str(event.get("end_month") or ""))
    end_year = _int_or_none(str(event.get("end_year") or ""))

    if not event.get("start_date_precision") and str(event.get("date_precision") or "").strip():
        legacy = str(event.get("date_precision") or "").strip()
        if legacy != "period":
            event["start_date_precision"] = legacy

    start_precision = str(event.get("start_date_precision") or "").strip()
    end_precision = str(event.get("end_date_precision") or "").strip()

    _validate_side_precision(
        "начало",
        start_precision,
        start_day,
        start_month,
        start_year,
        "start_date_approximate",
        event,
    )
    if end_year is not None:
        _validate_side_precision(
            "окончание",
            end_precision,
            end_day,
            end_month,
            end_year,
            "end_date_approximate",
            event,
        )

    if start_year is not None and end_year is not None:
        start_key = (start_year, start_month or 1, start_day or 1)
        end_key = (end_year, end_month or 12, end_day or 31)
        if end_key < start_key:
            raise ValueError("Дата окончания не может быть раньше даты начала.")
        if end_year - start_year > 30:
            raise ValueError(
                "Интервал длиннее 30 лет — проверьте даты (если это не ошибка, разбейте на отдельные события)."
            )


def import_csv(conn: sqlite3.Connection, csv_path: Path) -> None:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            raw: dict[str, object] = {column: _row_get(row, column) for column in EVENT_COLUMNS}
            if not raw["hashtag"]:
                raw["hashtag"] = _row_get(row, "slug")
            if not raw["start_date_precision"]:
                legacy_precision = _row_get(row, "date_precision")
                if legacy_precision and legacy_precision != "period":
                    raw["start_date_precision"] = legacy_precision
            if normalize_flag(raw.get("is_date_approximate")) == "1" and normalize_flag(raw.get("start_date_approximate")) == "0":
                raw["start_date_approximate"] = "1"
            if not raw["id"] or not raw["start_year"]:
                continue
            try:
                event = clean_event(raw)
                upsert_event(conn, event)
            except ValueError as exc:
                print(f"CSV import: пропуск {raw.get('id')}: {exc}")


def event_db_columns() -> list[str]:
    return [f'"{column}"' if column == "group" else column for column in EVENT_COLUMNS]


def list_events(conn: sqlite3.Connection) -> list[dict[str, object]]:
    rows = conn.execute(
        f"""
        SELECT {", ".join(event_db_columns())}
        FROM events
        ORDER BY CAST(start_year AS INTEGER), CAST(COALESCE(NULLIF(start_month, ''), '1') AS INTEGER),
                 CAST(COALESCE(NULLIF(start_day, ''), '1') AS INTEGER), id
        """
    ).fetchall()
    events = []
    for row in rows:
        event: dict[str, object] = {key: "" if row[key] is None else str(row[key]) for key in EVENT_COLUMNS}
        for link_key, (table, column) in EVENT_LINKS.items():
            link_rows = conn.execute(
                f"SELECT {column} FROM {table} WHERE event_id = ? ORDER BY {column}",
                (row["id"],),
            ).fetchall()
            event[link_key] = [str(link_row[column]) for link_row in link_rows]
        event["participant_countries"] = [
            str(r["country"])
            for r in conn.execute(
                "SELECT country FROM event_countries WHERE event_id = ? AND role = 'participant' ORDER BY country",
                (row["id"],),
            ).fetchall()
        ]
        event["source_items"] = [
            {key: "" if source[key] is None else str(source[key]) for key in REFERENCE_CONFIG["sources"]["columns"]}
            for source in conn.execute(
                """
                SELECT s.id, s.title, s.url, s.type, s.author, s.source_date, s.citation,
                       s.reliability_score, s.evidence_quote
                FROM event_sources es
                JOIN sources s ON s.id = es.source_id
                WHERE es.event_id = ?
                ORDER BY s.title, s.id
                """,
                (row["id"],),
            ).fetchall()
        ]
        event["media_items"] = [
            {key: "" if media[key] is None else str(media[key]) for key in REFERENCE_CONFIG["media"]["columns"]}
            for media in conn.execute(
                """
                SELECT m.id, m.url, m.type, m.caption, m.credit, m.license, m.alt_text
                FROM event_media em
                JOIN media m ON m.id = em.media_id
                WHERE em.event_id = ?
                ORDER BY m.id
                """,
                (row["id"],),
            ).fetchall()
        ]
        event["tag_items"] = [
            {key: "" if tag[key] is None else str(tag[key]) for key in REFERENCE_CONFIG["tags"]["columns"]}
            for tag in conn.execute(
                """
                SELECT t.id, t.name, t.slug, t.description
                FROM event_tags et
                JOIN tags t ON t.id = et.tag_id
                WHERE et.event_id = ?
                ORDER BY t.name, t.id
                """,
                (row["id"],),
            ).fetchall()
        ]
        event["group_items"] = [
            {key: "" if group[key] is None else str(group[key]) for key in REFERENCE_CONFIG["groups"]["columns"]}
            for group in conn.execute(
                """
                SELECT g.id, g.name, g.slug, g.description
                FROM event_groups eg
                JOIN groups g ON g.id = eg.group_id
                WHERE eg.event_id = ?
                ORDER BY g.name, g.id
                """,
                (row["id"],),
            ).fetchall()
        ]
        events.append(event)
    return events


def get_event_for_update(conn: sqlite3.Connection, event_id: str) -> dict[str, object] | None:
    """Читает событие целиком (EVENT_COLUMNS + текущие *_ids) для точечной правки одного
    поля перед upsert_event() — без этого replace_event_links() стёр бы существующие связи."""
    row = conn.execute(
        f"SELECT {', '.join(event_db_columns())} FROM events WHERE id = ?",
        (event_id,),
    ).fetchone()
    if not row:
        return None
    event: dict[str, object] = {key: "" if row[key] is None else str(row[key]) for key in EVENT_COLUMNS}
    for link_key, (table, column) in EVENT_LINKS.items():
        link_rows = conn.execute(
            f"SELECT {column} FROM {table} WHERE event_id = ? ORDER BY {column}",
            (event_id,),
        ).fetchall()
        event[link_key] = [str(link_row[column]) for link_row in link_rows]
    event["participant_countries"] = [
        str(r["country"])
        for r in conn.execute(
            "SELECT country FROM event_countries WHERE event_id = ? AND role = 'participant' ORDER BY country",
            (event_id,),
        ).fetchall()
    ]
    return event


def _clean_id_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in re.split(r"[;,]", value) if item.strip()]
    return []


def normalize_event_statuses(event: dict[str, object]) -> dict[str, object]:
    """Связывает статус публикации и статус проверки фактов."""
    status = str(event.get("status") or "published")
    verification = str(event.get("verification_status") or "").strip()

    if status == "published":
        if verification in {"needs_review", "disputed", "unconfirmed"}:
            raise ValueError(
                "Опубликовать можно только проверенные события: установите «Проверка фактов» = verified."
            )
        if not verification:
            event["verification_status"] = "verified"
    elif status == "review":
        if not verification or verification == "unconfirmed":
            event["verification_status"] = "needs_review"
    elif status == "draft":
        if not verification:
            event["verification_status"] = "unconfirmed"

    return event


def is_event_public_ready(row: dict[str, str]) -> bool:
    return (
        row.get("status", "published") == "published"
        and row.get("verification_status", "") == "verified"
    )


def clean_event(data: dict[str, object]) -> dict[str, object]:
    event: dict[str, object] = {column: str(data.get(column, "") or "").strip() for column in EVENT_COLUMNS}
    if not event["hashtag"] and str(data.get("slug", "") or "").strip():
        event["hashtag"] = str(data.get("slug", "") or "").strip()
    event["hashtag"] = normalize_hashtag(str(event.get("hashtag") or ""))
    if not event["start_date_precision"] and str(data.get("date_precision") or "").strip():
        legacy_precision = str(data.get("date_precision") or "").strip()
        if legacy_precision != "period":
            event["start_date_precision"] = legacy_precision
    for link_key in EVENT_LINKS:
        event[link_key] = _clean_id_list(data.get(link_key))
    event["participant_countries"] = _clean_id_list(data.get("participant_countries"))
    if not event["status"]:
        event["status"] = "published"
    if not event["id"]:
        raise ValueError("Не указан id события.")
    if not event["start_year"]:
        raise ValueError("Не указан год начала.")
    if not event["headline"]:
        raise ValueError("Не указан заголовок.")
    if event["status"] not in EVENT_STATUSES:
        raise ValueError("Недопустимый статус события.")
    if event["verification_status"] and event["verification_status"] not in VERIFICATION_STATUSES:
        raise ValueError("Недопустимый статус проверки.")
    event = normalize_event_statuses(event)
    for key in ("start_date_precision", "end_date_precision"):
        if event[key] and event[key] not in DATE_PRECISION_VALUES:
            raise ValueError("Недопустимая точность даты.")
    if event["scale"] and event["scale"] not in SCALE_VALUES:
        raise ValueError("Недопустимый масштаб события.")
    if normalize_flag(data.get("is_date_approximate")) == "1" and normalize_flag(event.get("start_date_approximate")) == "0":
        event["start_date_approximate"] = "1"
    event["start_date_approximate"] = normalize_flag(event.get("start_date_approximate"))
    event["end_date_approximate"] = normalize_flag(event.get("end_date_approximate"))
    event["use_composite_headline"] = normalize_flag(event.get("use_composite_headline"))
    if event["attached_to"] and event["attached_to"] == event["id"]:
        raise ValueError("Событие не может быть привязано само к себе.")
    validate_event_dates(event)
    int(event["start_year"])
    for column in ("start_month", "start_day", "end_year", "end_month", "end_day", "importance", "attachment_order"):
        if event[column]:
            int(event[column])
    return event


def validate_event_attachment(conn: sqlite3.Connection, event: dict[str, object]) -> None:
    """Проверяет поле «Привязано к»: основное событие существует, не является само
    привязанным (без цепочек), дата совпадает, и вторичное не публикуется без основного."""
    attached_to = str(event.get("attached_to") or "").strip()
    event_id = str(event.get("id") or "").strip()

    if not attached_to:
        return

    has_children = conn.execute(
        "SELECT 1 FROM events WHERE attached_to = ? LIMIT 1",
        (event_id,),
    ).fetchone()
    if has_children:
        raise ValueError(
            "У этого события уже есть свои привязанные события — нельзя привязать его к другому основному."
        )

    target = conn.execute(
        "SELECT id, start_year, start_month, start_day, status, verification_status, attached_to "
        "FROM events WHERE id = ?",
        (attached_to,),
    ).fetchone()
    if not target:
        raise ValueError("Основное событие, указанное в «Привязано к», не найдено.")
    if str(target["attached_to"] or "").strip():
        raise ValueError(
            "Нельзя привязать к событию, которое само привязано к другому — привяжите к основному событию."
        )

    same_date = (
        str(target["start_year"] or "") == str(event.get("start_year") or "")
        and str(target["start_month"] or "") == str(event.get("start_month") or "")
        and str(target["start_day"] or "") == str(event.get("start_day") or "")
    )
    if not same_date:
        raise ValueError(
            "Дата привязанного события должна совпадать с датой основного — иначе сохраните его как отдельное событие."
        )

    if is_event_public_ready(event) and not is_event_public_ready(
        {"status": str(target["status"] or ""), "verification_status": str(target["verification_status"] or "")}
    ):
        raise ValueError(
            "Нельзя публиковать привязанное событие, пока основное не опубликовано и не проверено."
        )


def default_group(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT id, name FROM groups WHERE id = 'grp-0001' OR name = 'История' LIMIT 1"
    ).fetchone()


def upsert_event(conn: sqlite3.Connection, event: dict[str, object]) -> None:
    if event.get("hashtag"):
        hashtag_row = conn.execute(
            "SELECT id FROM events WHERE hashtag = ? AND id != ?",
            (str(event["hashtag"]), str(event["id"])),
        ).fetchone()
        if hashtag_row:
            raise ValueError("Хештег уже используется другим событием.")
    is_new = not conn.execute("SELECT 1 FROM events WHERE id = ?", (str(event["id"]),)).fetchone()
    if is_new and not event.get("group_ids"):
        group = default_group(conn)
        if group:
            event["group_ids"] = [str(group["id"])]
            if not str(event.get("group") or "").strip():
                event["group"] = str(group["name"])
    placeholders = ", ".join("?" for _ in EVENT_COLUMNS)
    update_columns = [column for column in EVENT_COLUMNS if column != "id"]
    db_columns = {column: f'"{column}"' if column == "group" else column for column in EVENT_COLUMNS}
    update_sql = ", ".join(f"{db_columns[column]} = excluded.{db_columns[column]}" for column in update_columns)
    conn.execute(
        f"""
        INSERT INTO events ({", ".join(db_columns[column] for column in EVENT_COLUMNS)})
        VALUES ({placeholders})
        ON CONFLICT(id) DO UPDATE SET
            {update_sql},
            updated_at = CURRENT_TIMESTAMP
        """,
        [str(event[column]) for column in EVENT_COLUMNS],
    )
    replace_event_links(conn, str(event["id"]), event)


def replace_event_links(conn: sqlite3.Connection, event_id: str, event: dict[str, object]) -> None:
    for link_key, (table, column) in EVENT_LINKS.items():
        conn.execute(f"DELETE FROM {table} WHERE event_id = ?", (event_id,))
        for linked_id in event.get(link_key, []):
            conn.execute(
                f"INSERT OR IGNORE INTO {table} (event_id, {column}) VALUES (?, ?)",
                (event_id, linked_id),
            )
    replace_event_countries(conn, event_id, event)


def replace_event_countries(conn: sqlite3.Connection, event_id: str, event: dict[str, object]) -> None:
    """Синхронизация event_countries (open-spec-country-lanes.md, п. 5):
    role='place' — из строки country_name (split по запятой), role='participant' — из participant_countries."""
    conn.execute("DELETE FROM event_countries WHERE event_id = ?", (event_id,))
    places = [item.strip() for item in str(event.get("country_name") or "").split(",") if item.strip()]
    for country in places:
        conn.execute(
            "INSERT OR IGNORE INTO event_countries (event_id, country, role) VALUES (?, ?, 'place')",
            (event_id, country),
        )
    for country in event.get("participant_countries", []) or []:
        conn.execute(
            "INSERT OR IGNORE INTO event_countries (event_id, country, role) VALUES (?, ?, 'participant')",
            (event_id, str(country).strip()),
        )


def delete_event(conn: sqlite3.Connection, event_id: str) -> bool:
    for table, _column in EVENT_LINKS.values():
        conn.execute(f"DELETE FROM {table} WHERE event_id = ?", (event_id,))
    cur = conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
    return cur.rowcount > 0


def public_user(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "role": row["role"],
        "active": bool(row["active"]),
    }


def list_users(conn: sqlite3.Connection) -> list[dict[str, object]]:
    rows = conn.execute(
        """
        SELECT id, name, email, role, active
        FROM users
        ORDER BY name, email
        """
    ).fetchall()
    return [public_user(row) for row in rows]


def clean_user(data: dict[str, object], *, require_password: bool) -> dict[str, object]:
    user = {
        "id": str(data.get("id", "") or "").strip(),
        "name": str(data.get("name", "") or "").strip(),
        "email": str(data.get("email", "") or "").strip().lower(),
        "role": str(data.get("role", "editor") or "editor").strip(),
        "active": bool(data.get("active", True)),
        "password": str(data.get("password", "") or ""),
    }
    if not user["id"]:
        raise ValueError("Не указан id пользователя.")
    if not user["name"] or not user["email"]:
        raise ValueError("Укажите имя и email пользователя.")
    if user["role"] not in USER_ROLES:
        raise ValueError("Недопустимая роль пользователя.")
    if require_password and not user["password"]:
        raise ValueError("Для нового пользователя укажите пароль.")
    return user


def upsert_user(conn: sqlite3.Connection, user: dict[str, object]) -> dict[str, object]:
    existing = conn.execute("SELECT id, password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
    if existing:
        if user["password"]:
            conn.execute(
                """
                UPDATE users
                SET name = ?, email = ?, role = ?, active = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (user["name"], user["email"], user["role"], int(bool(user["active"])), hash_password(str(user["password"])), user["id"]),
            )
        else:
            conn.execute(
                """
                UPDATE users
                SET name = ?, email = ?, role = ?, active = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (user["name"], user["email"], user["role"], int(bool(user["active"])), user["id"]),
            )
    else:
        conn.execute(
            """
            INSERT INTO users (id, name, email, role, active, password_hash)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (user["id"], user["name"], user["email"], user["role"], int(bool(user["active"])), hash_password(str(user["password"]))),
        )
    row = conn.execute("SELECT id, name, email, role, active FROM users WHERE id = ?", (user["id"],)).fetchone()
    return public_user(row)


def delete_user(conn: sqlite3.Connection, user_id: str) -> bool:
    cur = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return cur.rowcount > 0


def list_reference_items(conn: sqlite3.Connection, kind: str) -> list[dict[str, str]]:
    config = REFERENCE_CONFIG[kind]
    columns = config["columns"]
    rows = conn.execute(
        f"""
        SELECT {", ".join(columns)}
        FROM {config["table"]}
        ORDER BY {config["order"]}
        """
    ).fetchall()
    return [{column: "" if row[column] is None else str(row[column]) for column in columns} for row in rows]


def clean_reference_item(kind: str, data: dict[str, object]) -> dict[str, str]:
    config = REFERENCE_CONFIG[kind]
    item = {column: str(data.get(column, "") or "").strip() for column in config["columns"]}
    for column in config["required"]:
        if not item[column]:
            raise ValueError(f"Заполните обязательное поле: {column}.")
    return item


def upsert_reference_item(conn: sqlite3.Connection, kind: str, item: dict[str, str]) -> dict[str, str]:
    config = REFERENCE_CONFIG[kind]
    columns = config["columns"]
    placeholders = ", ".join("?" for _ in columns)
    update_columns = [column for column in columns if column != "id"]
    update_sql = ", ".join(f"{column} = excluded.{column}" for column in update_columns)
    conn.execute(
        f"""
        INSERT INTO {config["table"]} ({", ".join(columns)})
        VALUES ({placeholders})
        ON CONFLICT(id) DO UPDATE SET
            {update_sql},
            updated_at = CURRENT_TIMESTAMP
        """,
        [item[column] for column in columns],
    )
    return item


def delete_reference_item(conn: sqlite3.Connection, kind: str, item_id: str) -> bool:
    config = REFERENCE_CONFIG[kind]
    link_tables = {
        "sources": ("event_sources", "source_id"),
        "media": ("event_media", "media_id"),
        "tags": ("event_tags", "tag_id"),
        "groups": ("event_groups", "group_id"),
    }
    table, column = link_tables[kind]
    conn.execute(f"DELETE FROM {table} WHERE {column} = ?", (item_id,))
    cur = conn.execute(f"DELETE FROM {config['table']} WHERE id = ?", (item_id,))
    return cur.rowcount > 0


def record_audit(
    conn: sqlite3.Connection,
    actor: dict[str, object] | None,
    action: str,
    entity_type: str,
    entity_id: str,
    summary: str = "",
) -> None:
    conn.execute(
        """
        INSERT INTO audit_log (actor_user_id, actor_email, action, entity_type, entity_id, summary)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            actor.get("id") if actor else None,
            actor.get("email") if actor else None,
            action,
            entity_type,
            entity_id,
            summary,
        ),
    )


def list_audit_log(conn: sqlite3.Connection, limit: int = 100) -> list[dict[str, object]]:
    rows = conn.execute(
        """
        SELECT id, actor_user_id, actor_email, action, entity_type, entity_id, summary, created_at
        FROM audit_log
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "actor_user_id": row["actor_user_id"],
            "actor_email": row["actor_email"],
            "action": row["action"],
            "entity_type": row["entity_type"],
            "entity_id": row["entity_id"],
            "summary": row["summary"] or "",
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def create_session(conn: sqlite3.Connection, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + SESSION_TTL_SECONDS
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
        (token, user_id, expires_at),
    )
    return token


def delete_session(conn: sqlite3.Connection, token: str) -> None:
    if token:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def user_by_session(conn: sqlite3.Connection, token: str | None) -> dict[str, object] | None:
    if not token:
        return None
    row = conn.execute(
        """
        SELECT u.id, u.name, u.email, u.role, u.active
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?
        """,
        (token, int(time.time())),
    ).fetchone()
    if not row or not row["active"]:
        return None
    return public_user(row)


def write_timeline_files(conn: sqlite3.Connection) -> None:
    events = list_events(conn)
    TIMELINE_JSON_PATH.write_text(
        json.dumps(events_to_timeline(events), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    SCALE_JSON_PATH.write_text(
        json.dumps(events_to_scale(events), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def quote_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def database_schema(conn: sqlite3.Connection) -> dict[str, object]:
    rows = conn.execute(
        """
        SELECT name, type, sql
        FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name
        """
    ).fetchall()

    tables = []
    for row in rows:
        name = str(row["name"])
        table_info = conn.execute(f"PRAGMA table_info({quote_identifier(name)})").fetchall()
        indexes = conn.execute(f"PRAGMA index_list({quote_identifier(name)})").fetchall()
        count = None
        if row["type"] == "table":
            count = conn.execute(f"SELECT COUNT(*) FROM {quote_identifier(name)}").fetchone()[0]

        tables.append(
            {
                "name": name,
                "type": row["type"],
                "row_count": count,
                "columns": [
                    {
                        "cid": column["cid"],
                        "name": column["name"],
                        "type": column["type"],
                        "notnull": bool(column["notnull"]),
                        "default": column["dflt_value"],
                        "pk": bool(column["pk"]),
                    }
                    for column in table_info
                ],
                "indexes": [
                    {
                        "name": index["name"],
                        "unique": bool(index["unique"]),
                        "origin": index["origin"],
                    }
                    for index in indexes
                ],
                "sql": row["sql"],
            }
        )

    return {"database": str(DB_PATH.name), "tables": tables}


def allocate_id(conn: sqlite3.Connection, table: str, prefix: str) -> str:
    """Следующий свободный id вида prefix-0001 для таблицы table (аналог nextEventId/nextReferenceId в admin.js)."""
    rows = conn.execute(f"SELECT id FROM {table}").fetchall()
    pattern = re.compile(r"^" + re.escape(prefix) + r"-(\d+)$", re.IGNORECASE)
    max_n = 0
    for row in rows:
        match = pattern.match(str(row["id"] or ""))
        if match:
            max_n = max(max_n, int(match.group(1)))
    return f"{prefix}-{max_n + 1:04d}"


def list_drafts(conn: sqlite3.Connection) -> dict[str, object]:
    batches = [
        {column: "" if row[column] is None else str(row[column]) for column in DRAFT_BATCH_COLUMNS}
        for row in conn.execute(
            f"SELECT {', '.join(DRAFT_BATCH_COLUMNS)} FROM draft_batches ORDER BY created_at, id"
        ).fetchall()
    ]
    events = []
    for row in conn.execute(
        f"SELECT {', '.join(DRAFT_EVENT_COLUMNS)} FROM draft_events ORDER BY batch_id, row_order, id"
    ).fetchall():
        event = {column: "" if row[column] is None else str(row[column]) for column in DRAFT_EVENT_COLUMNS}
        event["sources"] = [
            {column: "" if source[column] is None else str(source[column]) for column in DRAFT_SOURCE_COLUMNS}
            for source in conn.execute(
                f"SELECT {', '.join(DRAFT_SOURCE_COLUMNS)} FROM draft_sources WHERE draft_event_id = ? ORDER BY id",
                (row["id"],),
            ).fetchall()
        ]
        events.append(event)
    return {"batches": batches, "events": events}


def clean_draft_batch(data: dict[str, object]) -> dict[str, str]:
    item = {column: str(data.get(column, "") or "").strip() for column in DRAFT_BATCH_COLUMNS}
    if not item["title"]:
        raise ValueError("Укажите название листа.")
    if not item["status"]:
        item["status"] = "open"
    return item


def upsert_draft_batch(conn: sqlite3.Connection, item: dict[str, str]) -> dict[str, str]:
    columns = DRAFT_BATCH_COLUMNS
    placeholders = ", ".join("?" for _ in columns)
    update_sql = ", ".join(f"{column} = excluded.{column}" for column in columns if column != "id")
    conn.execute(
        f"""
        INSERT INTO draft_batches ({", ".join(columns)})
        VALUES ({placeholders})
        ON CONFLICT(id) DO UPDATE SET {update_sql}, updated_at = CURRENT_TIMESTAMP
        """,
        [item[column] for column in columns],
    )
    return item


def delete_draft_batch(conn: sqlite3.Connection, batch_id: str) -> bool:
    cur = conn.execute("DELETE FROM draft_batches WHERE id = ?", (batch_id,))
    return cur.rowcount > 0


def clean_draft_event(data: dict[str, object]) -> dict[str, str]:
    item = {column: str(data.get(column, "") or "").strip() for column in DRAFT_EVENT_COLUMNS}
    if not item["batch_id"]:
        raise ValueError("Не указан лист черновика.")
    if not item["row_order"]:
        item["row_order"] = "0"
    if not item["import_status"]:
        item["import_status"] = "pending"
    return item


def upsert_draft_event(conn: sqlite3.Connection, item: dict[str, str]) -> dict[str, str]:
    columns = DRAFT_EVENT_COLUMNS
    placeholders = ", ".join("?" for _ in columns)
    update_sql = ", ".join(f"{column} = excluded.{column}" for column in columns if column != "id")
    conn.execute(
        f"""
        INSERT INTO draft_events ({", ".join(columns)})
        VALUES ({placeholders})
        ON CONFLICT(id) DO UPDATE SET {update_sql}, updated_at = CURRENT_TIMESTAMP
        """,
        [item[column] for column in columns],
    )
    return item


def delete_draft_event(conn: sqlite3.Connection, draft_event_id: str) -> bool:
    cur = conn.execute("DELETE FROM draft_events WHERE id = ?", (draft_event_id,))
    return cur.rowcount > 0


def clean_draft_source(data: dict[str, object]) -> dict[str, str]:
    item = {column: str(data.get(column, "") or "").strip() for column in DRAFT_SOURCE_COLUMNS}
    if not item["draft_event_id"]:
        raise ValueError("Не указано событие-черновик.")
    return item


def upsert_draft_source(conn: sqlite3.Connection, item: dict[str, str]) -> dict[str, str]:
    columns = DRAFT_SOURCE_COLUMNS
    placeholders = ", ".join("?" for _ in columns)
    update_sql = ", ".join(f"{column} = excluded.{column}" for column in columns if column != "id")
    conn.execute(
        f"""
        INSERT INTO draft_sources ({", ".join(columns)})
        VALUES ({placeholders})
        ON CONFLICT(id) DO UPDATE SET {update_sql}, updated_at = CURRENT_TIMESTAMP
        """,
        [item[column] for column in columns],
    )
    return item


def delete_draft_source(conn: sqlite3.Connection, draft_source_id: str) -> bool:
    cur = conn.execute("DELETE FROM draft_sources WHERE id = ?", (draft_source_id,))
    return cur.rowcount > 0


def import_draft_event(conn: sqlite3.Connection, draft_id: str, actor: dict[str, object] | None) -> dict[str, object]:
    draft_row = conn.execute(
        f"SELECT {', '.join(DRAFT_EVENT_COLUMNS)} FROM draft_events WHERE id = ?", (draft_id,)
    ).fetchone()
    if not draft_row:
        raise ValueError("Черновик не найден.")
    draft = {column: "" if draft_row[column] is None else str(draft_row[column]) for column in DRAFT_EVENT_COLUMNS}
    if not draft["headline"]:
        raise ValueError("Заполните заголовок перед импортом.")
    if not draft["start_year"]:
        raise ValueError("Заполните год начала перед импортом.")

    source_rows = conn.execute(
        f"SELECT {', '.join(DRAFT_SOURCE_COLUMNS)} FROM draft_sources WHERE draft_event_id = ?", (draft_id,)
    ).fetchall()

    source_ids: list[str] = []
    for source_row in source_rows:
        draft_source = {
            column: "" if source_row[column] is None else str(source_row[column]) for column in DRAFT_SOURCE_COLUMNS
        }
        source_id = draft_source["imported_source_id"]
        if not source_id:
            source_id = allocate_id(conn, "sources", "src")
            source_item = clean_reference_item(
                "sources",
                {
                    "id": source_id,
                    "title": draft_source["title"] or draft["headline"],
                    "url": draft_source["url"],
                    "type": draft_source["type"],
                    "author": draft_source["author"],
                    "source_date": draft_source["source_date"],
                    "citation": draft_source["citation"],
                    "reliability_score": draft_source["reliability_score"],
                    "evidence_quote": draft_source["evidence_quote"],
                },
            )
            upsert_reference_item(conn, "sources", source_item)
            conn.execute(
                "UPDATE draft_sources SET imported_source_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (source_id, draft_source["id"]),
            )
        source_ids.append(source_id)

    event_id = allocate_id(conn, "events", "ev")
    event_input: dict[str, object] = {
        "id": event_id,
        "headline": draft["headline"],
        "start_year": draft["start_year"],
        "start_month": draft["start_month"],
        "start_day": draft["start_day"],
        "start_date_precision": draft["start_date_precision"],
        "summary": draft["summary"],
        "text": draft["text"],
        "event_type": draft["event_type"],
        "scale": draft["scale"],
        "domain": draft["domain"],
        "country_name": draft["country_name"],
        "region": draft["region"],
        "city": draft["city"],
        "status": "draft",
        "source_ids": source_ids,
    }
    event = clean_event(event_input)
    upsert_event(conn, event)

    conn.execute(
        """
        UPDATE draft_events
        SET import_status = 'imported', imported_event_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (event_id, draft_id),
    )
    record_audit(conn, actor, "create", "event", event_id, str(event.get("headline") or ""))
    write_timeline_files(conn)
    return event


def _attached_member_payload(row: dict[str, object]) -> dict[str, object]:
    """Полезная нагрузка вторичного (привязанного) события для карточки основного."""
    member: dict[str, object] = {
        "id": row.get("id"),
        "headline": row.get("headline", ""),
        "summary": row.get("summary", ""),
        "text": row.get("text", ""),
    }
    media_url = row.get("media_url", "")
    if media_url:
        media = {"url": media_url}
        if row.get("media_caption"):
            media["caption"] = row["media_caption"]
        if row.get("media_credit"):
            media["credit"] = row["media_credit"]
        member["media"] = media
    if row.get("source_items"):
        member["source_items"] = row["source_items"]
    if row.get("media_items"):
        member["media_items"] = row["media_items"]
    if row.get("tag_items"):
        member["tag_items"] = row["tag_items"]
    return member


def _attached_members_by_primary(
    events: list[dict[str, object]],
) -> dict[str, list[dict[str, object]]]:
    """Группирует опубликованные+проверенные вторичные события по id основного.

    Вторичное событие попадает в группу, только если и оно само, и основное
    прошли is_event_public_ready() — иначе оно не показывается ни отдельно,
    ни в составе объединённой карточки (см. правило публикации в open-spec.md)."""
    by_id = {row.get("id"): row for row in events}
    grouped: dict[str, list[dict[str, object]]] = {}
    for row in events:
        primary_id = str(row.get("attached_to") or "").strip()
        if not primary_id:
            continue
        primary = by_id.get(primary_id)
        if not primary or not is_event_public_ready(row) or not is_event_public_ready(primary):
            continue
        grouped.setdefault(primary_id, []).append(row)

    def sort_key(row: dict[str, object]) -> tuple:
        order = _int_or_none(row.get("attachment_order"))
        return (order is None, order or 0, str(row.get("id") or ""))

    for members in grouped.values():
        members.sort(key=sort_key)
    return grouped


def events_to_timeline(events: list[dict[str, str]]) -> dict[str, object]:
    attached_members = _attached_members_by_primary(events)
    hidden_ids = {str(member.get("id")) for members in attached_members.values() for member in members}

    timeline_events = []
    for row in events:
        if str(row.get("id")) in hidden_ids:
            continue
        if not is_event_public_ready(row):
            continue
        start_year = _int_or_none(row.get("start_year"))
        if start_year is None:
            continue

        headline = row.get("headline", "")
        members = attached_members.get(str(row.get("id")))
        if members and row.get("use_composite_headline") == "1" and str(row.get("composite_headline") or "").strip():
            headline = str(row["composite_headline"]).strip()

        event: dict[str, object] = {
            "unique_id": row.get("id") or None,
            "start_date": {"year": start_year},
            "text": {
                "headline": headline,
                "text": row.get("text", ""),
            },
        }
        if members:
            event["_attached_events"] = [_attached_member_payload(member) for member in members]

        for source, target in (("start_month", "month"), ("start_day", "day")):
            value = _int_or_none(row.get(source))
            if value is not None:
                event["start_date"][target] = value

        end_year = _int_or_none(row.get("end_year"))
        if end_year is not None:
            end_date = {"year": end_year}
            for source, target in (("end_month", "month"), ("end_day", "day")):
                value = _int_or_none(row.get(source))
                if value is not None:
                    end_date[target] = value
            event["end_date"] = end_date

        media_url = row.get("media_url", "")
        if media_url:
            media = {"url": media_url}
            if row.get("media_caption"):
                media["caption"] = row["media_caption"]
            if row.get("media_credit"):
                media["credit"] = row["media_credit"]
            event["media"] = media

        if row.get("group"):
            event["group"] = row["group"]
        if row.get("tags"):
            event["_tags"] = [tag.strip() for tag in re.split(r"[;,]", row["tags"]) if tag.strip()]
        if row.get("source_items"):
            event["_sources"] = row["source_items"]
        if row.get("media_items"):
            event["_media_items"] = row["media_items"]
        if row.get("tag_items"):
            event["_tag_items"] = row["tag_items"]
        if row.get("group_items"):
            event["_group_items"] = row["group_items"]
        importance = _int_or_none(row.get("importance"))
        if importance is not None:
            event["_importance"] = importance

        for source_key, timeline_key in EVENT_TIMELINE_META.items():
            value = row.get(source_key, "")
            if value:
                if source_key in {"start_date_approximate", "end_date_approximate"}:
                    event[timeline_key] = value == "1"
                elif source_key == "related_events":
                    event[timeline_key] = [item.strip() for item in re.split(r"[;,]", str(value)) if item.strip()]
                else:
                    event[timeline_key] = value

        timeline_events.append(event)

    return {"events": timeline_events}


def events_to_scale(events: list[dict[str, str]]) -> dict[str, object]:
    attached_members = _attached_members_by_primary(events)
    hidden_ids = {str(member.get("id")) for members in attached_members.values() for member in members}

    years: list[int] = []
    scale_events = []
    for row in events:
        if str(row.get("id")) in hidden_ids:
            continue
        if not is_event_public_ready(row):
            continue
        start_year = _int_or_none(row.get("start_year"))
        if start_year is None:
            continue
        years.append(start_year)
        end_year = _int_or_none(row.get("end_year"))
        if end_year is not None:
            years.append(end_year)

        headline = row.get("headline", "")
        if (
            attached_members.get(str(row.get("id")))
            and row.get("use_composite_headline") == "1"
            and str(row.get("composite_headline") or "").strip()
        ):
            headline = str(row["composite_headline"]).strip()

        scale_events.append(
            {
                "id": row.get("id"),
                "year": start_year,
                "headline": headline,
                "group": row.get("group") or None,
                "importance": _int_or_none(row.get("importance")) or 1,
            }
        )

    return {
        "minYear": min(years) if years else -2000,
        "maxYear": max(years) if years else datetime.date.today().year,
        "events": scale_events,
    }


def timeline_nearest(conn: sqlite3.Connection, date_str: str) -> dict[str, object]:
    """Поиск по дате (canvas-спека + open-spec-country-lanes.md пп. 2-3, 7, 9):
    точные попадания, «покрывающие» события (точность месяц/год/approximate),
    идущие интервалы (start <= date <= end), ближайшие в обе стороны с расстоянием в днях."""
    import calendar
    from datetime import date as _date

    target = _date.fromisoformat(date_str)

    def _mk_date(y: int, m: int | None, d: int | None, *, end_side: bool = False) -> _date:
        month = m or (12 if end_side else 1)
        if d:
            day = min(d, calendar.monthrange(y, month)[1])
        else:
            day = calendar.monthrange(y, month)[1] if end_side else 1
        return _date(y, month, day)

    rows = conn.execute(
        f"""
        SELECT {", ".join(event_db_columns())} FROM events
        WHERE status = 'published' AND verification_status = 'verified'
          AND COALESCE(attached_to, '') = ''
        """
    ).fetchall()

    exact: list[dict[str, object]] = []
    covering: list[dict[str, object]] = []
    ongoing: list[dict[str, object]] = []
    nearest_prev: dict[str, object] | None = None
    nearest_next: dict[str, object] | None = None

    for row in rows:
        year = _int_or_none(str(row["start_year"] or ""))
        if year is None:
            continue
        month = _int_or_none(str(row["start_month"] or ""))
        day = _int_or_none(str(row["start_day"] or ""))
        start = _mk_date(year, month, day)
        precision = str(row["start_date_precision"] or "").strip()
        if not precision:
            precision = "day" if day else ("month" if month else "year")
        approximate = str(row["start_date_approximate"] or "") == "1"
        payload: dict[str, object] = {
            "id": str(row["id"]),
            "headline": str(row["headline"] or ""),
            "date": {"year": year, "month": month, "day": day},
            "precision": precision,
            "approximate": approximate,
        }
        end_year = _int_or_none(str(row["end_year"] or ""))
        if end_year is not None:
            end = _mk_date(end_year, _int_or_none(str(row["end_month"] or "")), _int_or_none(str(row["end_day"] or "")), end_side=True)
            payload["end_date"] = {
                "year": end_year,
                "month": _int_or_none(str(row["end_month"] or "")),
                "day": _int_or_none(str(row["end_day"] or "")),
            }
            if start <= target <= end:
                ongoing.append(payload)
                continue
        if precision == "day" and not approximate and day is not None:
            if start == target:
                exact.append(payload)
        elif precision == "month" and month is not None:
            if year == target.year and month == target.month:
                covering.append(payload)
        else:
            if year == target.year:
                covering.append(payload)
        diff = (start - target).days
        if diff <= 0:
            if nearest_prev is None or diff > int(nearest_prev["diff_days"]):
                nearest_prev = dict(payload, diff_days=diff)
        else:
            if nearest_next is None or diff < int(nearest_next["diff_days"]):
                nearest_next = dict(payload, diff_days=diff)

    marker: dict[str, object] | None = None
    diff_days = 0
    if exact:
        marker = exact[0]
    else:
        candidates = [c for c in (nearest_prev, nearest_next) if c]
        if candidates:
            best = min(candidates, key=lambda c: abs(int(c["diff_days"])))
            marker = best
            diff_days = abs(int(best["diff_days"]))

    return {
        "date": date_str,
        "exact": bool(exact),
        "diff_days": diff_days,
        "marker": marker,
        "matches": exact,
        "covering": covering,
        "ongoing": ongoing,
        "nearest_prev": nearest_prev,
        "nearest_next": nearest_next,
    }


def coverage_report(conn: sqlite3.Connection) -> dict[str, object]:
    """Отчёт «пробелы покрытия» (open-spec-country-lanes.md, п. 13): страна x год x роль."""
    rows = conn.execute(
        """
        SELECT ec.country AS country, ec.role AS role,
               CAST(e.start_year AS INTEGER) AS year, COUNT(DISTINCT e.id) AS cnt
        FROM event_countries ec
        JOIN events e ON e.id = ec.event_id
        GROUP BY ec.country, ec.role, CAST(e.start_year AS INTEGER)
        ORDER BY ec.country, ec.role, year
        """
    ).fetchall()
    years = conn.execute(
        "SELECT MIN(CAST(start_year AS INTEGER)), MAX(CAST(start_year AS INTEGER)) FROM events"
    ).fetchone()
    return {
        "coverage": [
            {"country": r["country"], "role": r["role"], "year": r["year"], "count": r["cnt"]}
            for r in rows
        ],
        "min_year": years[0],
        "max_year": years[1],
    }


def parse_multipart_form(content_type: str, body: bytes) -> dict[str, object]:
    boundary_match = re.search(r'boundary=(?:"([^"]+)"|([^\s;]+))', content_type)
    if not boundary_match:
        raise ValueError("Не удалось определить boundary multipart-запроса.")
    boundary = (boundary_match.group(1) or boundary_match.group(2) or "").encode("utf-8")
    delimiter = b"--" + boundary
    parts = body.split(delimiter)
    result: dict[str, object] = {}
    for part in parts[1:]:
        chunk = part.strip(b"\r\n-")
        if not chunk:
            continue
        header_end = chunk.find(b"\r\n\r\n")
        if header_end == -1:
            continue
        headers = chunk[:header_end].decode("utf-8", errors="replace")
        content = chunk[header_end + 4 :]
        if content.endswith(b"\r\n"):
            content = content[:-2]
        name_match = re.search(r'name="([^"]+)"', headers)
        if not name_match:
            continue
        name = name_match.group(1)
        filename_match = re.search(r'filename="([^"]*)"', headers)
        if filename_match:
            result[name] = {
                "filename": filename_match.group(1),
                "data": content,
            }
        else:
            result[name] = content.decode("utf-8", errors="replace").strip()
    return result


def media_type_from_name(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}:
        return "image"
    if ext in {".mp4", ".webm"}:
        return "video"
    if ext in {".mp3", ".wav"}:
        return "audio"
    if ext in {".pdf", ".doc", ".docx"}:
        return "document"
    return "file"


def save_uploaded_media(file_info: dict[str, object]) -> dict[str, str]:
    filename = str(file_info.get("filename") or "").strip()
    data = file_info.get("data")
    if not filename or not isinstance(data, (bytes, bytearray)):
        raise ValueError("Файл не передан.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("Файл слишком большой (макс. 10 МБ).")
    ext = Path(filename).suffix.lower()
    if ext not in UPLOAD_EXTENSIONS:
        raise ValueError("Недопустимый тип файла.")
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(filename).stem)[:80] or "file"
    stored_name = f"{safe_name}_{secrets.token_hex(4)}{ext}"
    target = UPLOADS_DIR / stored_name
    target.write_bytes(data)
    url = f"data/uploads/{stored_name}"
    return {
        "url": url,
        "type": media_type_from_name(filename),
        "filename": stored_name,
    }


class ArchiveHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def session_token(self) -> str | None:
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            if "=" not in part:
                continue
            name, value = part.strip().split("=", 1)
            if name == SESSION_COOKIE:
                return value
        return None

    def current_user(self, conn: sqlite3.Connection) -> dict[str, object] | None:
        return user_by_session(conn, self.session_token())

    def require_user(self, conn: sqlite3.Connection, roles: set[str] | None = None) -> dict[str, object] | None:
        user = self.current_user(conn)
        if not user:
            self.send_json({"error": "Требуется вход в систему."}, status=401)
            return None
        if roles and user["role"] not in roles:
            self.send_json({"error": "Недостаточно прав."}, status=403)
            return None
        return user

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/auth/session":
            with get_db() as conn:
                self.send_json({"user": self.current_user(conn)})
            return
        if path == "/api/events":
            with get_db() as conn:
                if not self.require_user(conn):
                    return
                self.send_json({"events": list_events(conn)})
            return
        if path == "/api/users":
            with get_db() as conn:
                if not self.require_user(conn, {"admin"}):
                    return
                self.send_json({"users": list_users(conn)})
            return
        if path == "/api/audit":
            with get_db() as conn:
                if not self.require_user(conn, {"admin"}):
                    return
                self.send_json({"audit": list_audit_log(conn)})
            return
        for kind in REFERENCE_CONFIG:
            if path == f"/api/{kind}":
                with get_db() as conn:
                    if not self.require_user(conn, {"admin", "editor"}):
                        return
                    self.send_json({kind: list_reference_items(conn, kind)})
                return
        if path == "/api/timeline/nearest":
            query = parse_qs(urlparse(self.path).query)
            date_value = (query.get("date") or [""])[0].strip()
            try:
                with get_db() as conn:
                    self.send_json(timeline_nearest(conn, date_value))
            except ValueError:
                self.send_json({"error": "Ожидается параметр date в формате YYYY-MM-DD."}, status=400)
            return
        if path == "/api/reports/coverage":
            with get_db() as conn:
                if not self.require_user(conn, {"admin", "editor"}):
                    return
                self.send_json(coverage_report(conn))
            return
        if path in ("/api/timeline", "/api/timeline.json"):
            with get_db() as conn:
                self.send_json(events_to_timeline(list_events(conn)))
            return
        if path in ("/api/scale", "/api/scale.json"):
            with get_db() as conn:
                self.send_json(events_to_scale(list_events(conn)))
            return
        if path == "/api/db/schema":
            with get_db() as conn:
                if not self.require_user(conn, {"admin"}):
                    return
                self.send_json(database_schema(conn))
            return
        if path == "/api/drafts":
            with get_db() as conn:
                if not self.require_user(conn, {"admin", "editor"}):
                    return
                self.send_json(list_drafts(conn))
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/auth/login":
            try:
                data = self.read_json()
                email = str(data.get("email", "") or "").strip().lower()
                password = str(data.get("password", "") or "")
                with get_db() as conn:
                    row = conn.execute(
                        "SELECT id, name, email, role, active, password_hash FROM users WHERE email = ?",
                        (email,),
                    ).fetchone()
                    if not row or not row["active"] or not verify_password(password, row["password_hash"]):
                        self.send_json({"error": "Неверный email или пароль."}, status=401)
                        return
                    token = create_session(conn, row["id"])
                    self.send_json(
                        {"user": public_user(row)},
                        headers={"Set-Cookie": f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax"},
                    )
            except Exception as exc:
                self.send_json({"error": f"Ошибка входа: {exc}"}, status=500)
            return

        if path == "/api/auth/logout":
            with get_db() as conn:
                delete_session(conn, self.session_token() or "")
            self.send_json(
                {"ok": True},
                headers={"Set-Cookie": f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"},
            )
            return

        if path == "/api/media/upload":
            try:
                content_type = self.headers.get("Content-Type", "")
                if "multipart/form-data" not in content_type:
                    raise ValueError("Ожидался multipart/form-data.")
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length) if length else b""
                form = parse_multipart_form(content_type, body)
                file_info = form.get("file")
                if not isinstance(file_info, dict):
                    raise ValueError("Файл не передан.")
                with get_db() as conn:
                    actor = self.require_user(conn, {"admin", "editor"})
                    if not actor:
                        return
                    saved = save_uploaded_media(file_info)
                    record_audit(
                        conn,
                        actor,
                        "create",
                        "media",
                        saved["filename"],
                        saved["url"],
                    )
                    self.send_json({"item": saved})
            except ValueError as exc:
                self.send_json({"error": str(exc)}, status=400)
            except Exception as exc:
                self.send_json({"error": f"Ошибка загрузки: {exc}"}, status=500)
            return

        if path == "/api/users":
            try:
                data = self.read_json()
                with get_db() as conn:
                    actor = self.require_user(conn, {"admin"})
                    if not actor:
                        return
                    user_id = str(data.get("id", "") or "").strip()
                    user_exists = bool(conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone())
                    user = clean_user(data, require_password=not user_exists)
                    saved_user = upsert_user(conn, user)
                    record_audit(
                        conn,
                        actor,
                        "update" if user_exists else "create",
                        "user",
                        str(saved_user["id"]),
                        str(saved_user["email"]),
                    )
                    self.send_json({"user": saved_user})
            except sqlite3.IntegrityError:
                self.send_json({"error": "Email уже используется."}, status=400)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, status=400)
            except Exception as exc:
                self.send_json({"error": f"Ошибка сохранения пользователя: {exc}"}, status=500)
            return

        for kind in REFERENCE_CONFIG:
            if path == f"/api/{kind}":
                try:
                    item = clean_reference_item(kind, self.read_json())
                    with get_db() as conn:
                        actor = self.require_user(conn, {"admin", "editor"})
                        if not actor:
                            return
                        item_exists = bool(conn.execute(
                            f"SELECT 1 FROM {REFERENCE_CONFIG[kind]['table']} WHERE id = ?",
                            (item["id"],),
                        ).fetchone())
                        saved_item = upsert_reference_item(conn, kind, item)
                        record_audit(
                            conn,
                            actor,
                            "update" if item_exists else "create",
                            kind,
                            saved_item["id"],
                            saved_item.get("title") or saved_item.get("name") or saved_item.get("url") or "",
                        )
                        self.send_json({"item": saved_item})
                except sqlite3.IntegrityError:
                    self.send_json({"error": "Запись с такими уникальными полями уже существует."}, status=400)
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, status=400)
                except Exception as exc:
                    self.send_json({"error": f"Ошибка сохранения справочника: {exc}"}, status=500)
                return

        draft_import_prefix = "/api/drafts/events/"
        if path.startswith(draft_import_prefix) and path.endswith("/import"):
            draft_id = unquote(path[len(draft_import_prefix) : -len("/import")])
            try:
                with get_db() as conn:
                    actor = self.require_user(conn, {"admin", "editor"})
                    if not actor:
                        return
                    event = import_draft_event(conn, draft_id, actor)
                    self.send_json({"event": event})
            except ValueError as exc:
                self.send_json({"error": str(exc)}, status=400)
            except Exception as exc:
                self.send_json({"error": f"Ошибка импорта черновика: {exc}"}, status=500)
            return

        if path == "/api/drafts/batches":
            try:
                item = clean_draft_batch(self.read_json())
                with get_db() as conn:
                    if not self.require_user(conn, {"admin", "editor"}):
                        return
                    if not item["id"]:
                        item["id"] = allocate_id(conn, "draft_batches", "dft")
                    saved = upsert_draft_batch(conn, item)
                    self.send_json({"item": saved})
            except ValueError as exc:
                self.send_json({"error": str(exc)}, status=400)
            except Exception as exc:
                self.send_json({"error": f"Ошибка сохранения листа: {exc}"}, status=500)
            return

        if path == "/api/drafts/events":
            try:
                item = clean_draft_event(self.read_json())
                with get_db() as conn:
                    if not self.require_user(conn, {"admin", "editor"}):
                        return
                    if not item["id"]:
                        item["id"] = allocate_id(conn, "draft_events", "dfe")
                    saved = upsert_draft_event(conn, item)
                    self.send_json({"item": saved})
            except ValueError as exc:
                self.send_json({"error": str(exc)}, status=400)
            except Exception as exc:
                self.send_json({"error": f"Ошибка сохранения строки: {exc}"}, status=500)
            return

        if path == "/api/drafts/sources":
            try:
                item = clean_draft_source(self.read_json())
                with get_db() as conn:
                    if not self.require_user(conn, {"admin", "editor"}):
                        return
                    if not item["id"]:
                        item["id"] = allocate_id(conn, "draft_sources", "dfs")
                    saved = upsert_draft_source(conn, item)
                    self.send_json({"item": saved})
            except ValueError as exc:
                self.send_json({"error": str(exc)}, status=400)
            except Exception as exc:
                self.send_json({"error": f"Ошибка сохранения источника: {exc}"}, status=500)
            return

        if path in ("/api/events/bulk/attach", "/api/events/bulk/verify", "/api/events/bulk/publish", "/api/events/bulk/set_group"):
            try:
                data = self.read_json()
                ids = [str(item).strip() for item in (data.get("ids") or []) if str(item).strip()]
                attached_to = str(data.get("attached_to", "") or "").strip()
                group_id = str(data.get("group_id", "") or "").strip()
                group_name = ""
                if path.endswith("/attach") and not attached_to:
                    self.send_json({"error": "Не указано целевое событие для привязки."}, status=400)
                    return
                if path.endswith("/set_group"):
                    if not group_id:
                        self.send_json({"error": "Не указана группа."}, status=400)
                        return
                    with get_db() as conn:
                        group_row = conn.execute("SELECT name FROM groups WHERE id = ?", (group_id,)).fetchone()
                    if not group_row:
                        self.send_json({"error": "Группа не найдена."}, status=400)
                        return
                    group_name = str(group_row["name"])
                with get_db() as conn:
                    actor = self.require_user(conn, {"admin"})
                    if not actor:
                        return
                    results = []
                    for event_id in ids:
                        try:
                            event = get_event_for_update(conn, event_id)
                            if event is None:
                                raise ValueError("Событие не найдено.")
                            if path.endswith("/attach"):
                                event["attached_to"] = attached_to
                            elif path.endswith("/verify"):
                                event["verification_status"] = "verified"
                            elif path.endswith("/publish"):
                                event["status"] = "published"
                            elif path.endswith("/set_group"):
                                event["group_ids"] = [group_id]
                                event["group"] = group_name
                            event = clean_event(event)
                            if path.endswith("/attach"):
                                validate_event_attachment(conn, event)
                            upsert_event(conn, event)
                            record_audit(conn, actor, "update", "event", event_id, str(event.get("headline") or ""))
                            results.append({"id": event_id, "ok": True})
                        except ValueError as exc:
                            results.append({"id": event_id, "ok": False, "error": str(exc)})
                    write_timeline_files(conn)
                self.send_json({"results": results})
            except Exception as exc:
                self.send_json({"error": f"Ошибка массового изменения: {exc}"}, status=500)
            return

        if path != "/api/events":
            self.send_error(404)
            return
        try:
            event = clean_event(self.read_json())
            with get_db() as conn:
                actor = self.require_user(conn, {"admin", "editor"})
                if not actor:
                    return
                event_exists = bool(conn.execute("SELECT 1 FROM events WHERE id = ?", (event["id"],)).fetchone())
                validate_event_attachment(conn, event)
                upsert_event(conn, event)
                record_audit(
                    conn,
                    actor,
                    "update" if event_exists else "create",
                    "event",
                    str(event["id"]),
                    str(event.get("headline") or ""),
                )
                write_timeline_files(conn)
            self.send_json({"event": event})
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
        except Exception as exc:
            self.send_json({"error": f"Ошибка сохранения: {exc}"}, status=500)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        prefix = "/api/events/"
        user_prefix = "/api/users/"
        if path.startswith(prefix):
            event_id = unquote(path[len(prefix) :])
            with get_db() as conn:
                actor = self.require_user(conn, {"admin", "editor"})
                if not actor:
                    return
                row = conn.execute("SELECT headline FROM events WHERE id = ?", (event_id,)).fetchone()
                deleted = delete_event(conn, event_id)
                if deleted:
                    record_audit(conn, actor, "delete", "event", event_id, row["headline"] if row else "")
                    write_timeline_files(conn)
            self.send_json({"deleted": deleted}, status=200 if deleted else 404)
            return
        if path.startswith(user_prefix):
            user_id = unquote(path[len(user_prefix) :])
            with get_db() as conn:
                actor = self.require_user(conn, {"admin"})
                if not actor:
                    return
                if actor["id"] == user_id:
                    self.send_json({"error": "Нельзя удалить текущего пользователя."}, status=400)
                    return
                row = conn.execute("SELECT email FROM users WHERE id = ?", (user_id,)).fetchone()
                deleted = delete_user(conn, user_id)
                if deleted:
                    record_audit(conn, actor, "delete", "user", user_id, row["email"] if row else "")
            self.send_json({"deleted": deleted}, status=200 if deleted else 404)
            return
        for kind in REFERENCE_CONFIG:
            ref_prefix = f"/api/{kind}/"
            if path.startswith(ref_prefix):
                item_id = unquote(path[len(ref_prefix) :])
                with get_db() as conn:
                    actor = self.require_user(conn, {"admin", "editor"})
                    if not actor:
                        return
                    row = conn.execute(
                        f"SELECT * FROM {REFERENCE_CONFIG[kind]['table']} WHERE id = ?",
                        (item_id,),
                    ).fetchone()
                    deleted = delete_reference_item(conn, kind, item_id)
                    if deleted:
                        summary = ""
                        if row:
                            for key in ("title", "name", "url"):
                                if key in row.keys() and row[key]:
                                    summary = str(row[key])
                                    break
                        record_audit(conn, actor, "delete", kind, item_id, summary)
                self.send_json({"deleted": deleted}, status=200 if deleted else 404)
                return
        draft_batch_prefix = "/api/drafts/batches/"
        if path.startswith(draft_batch_prefix):
            batch_id = unquote(path[len(draft_batch_prefix) :])
            with get_db() as conn:
                if not self.require_user(conn, {"admin", "editor"}):
                    return
                deleted = delete_draft_batch(conn, batch_id)
            self.send_json({"deleted": deleted}, status=200 if deleted else 404)
            return
        draft_event_prefix = "/api/drafts/events/"
        if path.startswith(draft_event_prefix):
            draft_event_id = unquote(path[len(draft_event_prefix) :])
            with get_db() as conn:
                if not self.require_user(conn, {"admin", "editor"}):
                    return
                deleted = delete_draft_event(conn, draft_event_id)
            self.send_json({"deleted": deleted}, status=200 if deleted else 404)
            return
        draft_source_prefix = "/api/drafts/sources/"
        if path.startswith(draft_source_prefix):
            draft_source_id = unquote(path[len(draft_source_prefix) :])
            with get_db() as conn:
                if not self.require_user(conn, {"admin", "editor"}):
                    return
                deleted = delete_draft_source(conn, draft_source_id)
            self.send_json({"deleted": deleted}, status=200 if deleted else 404)
            return
        self.send_error(404)

    def read_json(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("Ожидался JSON-объект.")
        return data

    def send_json(self, data: object, status: int = 200, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    init_db()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), ArchiveHandler)
    print(f"Server: http://127.0.0.1:{port}")
    print("Database:", DB_PATH)
    server.serve_forever()


if __name__ == "__main__":
    main()
