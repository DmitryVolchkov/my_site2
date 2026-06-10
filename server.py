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
import re
import secrets
import sqlite3
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

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
        "columns": ["id", "name", "slug", "description"],
        "required": ["id", "name"],
        "order": "name, id",
    },
}


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

    if start_year is not None and end_year is not None and end_year < start_year:
        raise ValueError("Год окончания не может быть раньше года начала.")


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
    validate_event_dates(event)
    int(event["start_year"])
    for column in ("start_month", "start_day", "end_year", "end_month", "end_day", "importance"):
        if event[column]:
            int(event[column])
    return event


def upsert_event(conn: sqlite3.Connection, event: dict[str, object]) -> None:
    if event.get("hashtag"):
        hashtag_row = conn.execute(
            "SELECT id FROM events WHERE hashtag = ? AND id != ?",
            (str(event["hashtag"]), str(event["id"])),
        ).fetchone()
        if hashtag_row:
            raise ValueError("Хештег уже используется другим событием.")
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


def events_to_timeline(events: list[dict[str, str]]) -> dict[str, object]:
    timeline_events = []
    for row in events:
        if not is_event_public_ready(row):
            continue
        start_year = _int_or_none(row.get("start_year"))
        if start_year is None:
            continue

        event: dict[str, object] = {
            "unique_id": row.get("id") or None,
            "start_date": {"year": start_year},
            "text": {
                "headline": row.get("headline", ""),
                "text": row.get("text", ""),
            },
        }

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
    years: list[int] = []
    scale_events = []
    for row in events:
        if not is_event_public_ready(row):
            continue
        start_year = _int_or_none(row.get("start_year"))
        if start_year is None:
            continue
        years.append(start_year)
        end_year = _int_or_none(row.get("end_year"))
        if end_year is not None:
            years.append(end_year)
        scale_events.append(
            {
                "id": row.get("id"),
                "year": start_year,
                "headline": row.get("headline", ""),
                "group": row.get("group") or None,
                "importance": _int_or_none(row.get("importance")) or 1,
            }
        )

    return {
        "minYear": min(years) if years else -2000,
        "maxYear": max(years) if years else datetime.date.today().year,
        "events": scale_events,
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
    server = ThreadingHTTPServer(("127.0.0.1", 8000), ArchiveHandler)
    print("Server: http://127.0.0.1:8000")
    print("Database:", DB_PATH)
    server.serve_forever()


if __name__ == "__main__":
    main()
