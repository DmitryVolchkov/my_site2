"""Проверка POST /api/media/upload."""

from __future__ import annotations

import json
import uuid
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST_IMAGE = ROOT / "data" / "СВО" / "1661394131_ot-slova_0.jpg"


def login() -> str:
    req = urllib.request.Request(
        "http://127.0.0.1:8000/api/auth/login",
        data=json.dumps({"email": "admin@archive.local", "password": "admin"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        cookie = resp.headers.get("Set-Cookie", "")
    return cookie.split(";")[0]


def upload(cookie: str, file_path: Path) -> None:
    boundary = f"----WebKitFormBoundary{uuid.uuid4().hex}"
    file_bytes = file_path.read_bytes()
    filename = file_path.name
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: image/jpeg\r\n\r\n"
    ).encode("utf-8") + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(
        "http://127.0.0.1:8000/api/media/upload",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Cookie": cookie,
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        print("status", resp.status)
        print(resp.read().decode())


def main() -> None:
    if not TEST_IMAGE.exists():
        raise SystemExit(f"Test image not found: {TEST_IMAGE}")
    cookie = login()
    upload(cookie, TEST_IMAGE)


if __name__ == "__main__":
    main()
