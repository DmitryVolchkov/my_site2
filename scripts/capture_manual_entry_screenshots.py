"""Снимки экрана для docs/manual-entry из запущенного сервера (не AI).

Требования:
  pip install playwright
  playwright install chromium
  python server.py   # в отдельном терминале

Запуск:
  python scripts/capture_manual_entry_screenshots.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs" / "manual-entry" / "images"
BASE_URL = "http://127.0.0.1:8000"


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Установите Playwright: pip install playwright && playwright install chromium")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        page.goto(f"{BASE_URL}/admin.html", wait_until="networkidle")
        page.wait_for_selector("#admin-login")
        page.locator("#admin-login").screenshot(path=str(OUT_DIR / "01-login.png"))

        page.fill("#login-email", "admin@archive.local")
        page.fill("#login-password", "admin")
        page.click("#login-form button[type='submit']")
        page.wait_for_function(
            "() => document.getElementById('admin-app') && !document.getElementById('admin-app').hidden"
        )
        page.wait_for_load_state("networkidle")

        page.locator(".admin-tabs").screenshot(path=str(OUT_DIR / "00-workflow.png"))

        page.click('.admin-tab[data-tab="sources"]')
        page.wait_for_timeout(400)
        page.locator("#panel-sources").screenshot(path=str(OUT_DIR / "03-references.png"))

        page.click('.admin-tab[data-tab="events"]')
        page.wait_for_selector("#event-form")
        page.click("#btn-event-new")
        page.wait_for_timeout(300)

        page.fill("#event-headline", "День Победы")
        page.fill("#event-summary", "Окончание Великой Отечественной войны в Европе.")
        page.fill("#event-text", "9 мая 1945 года — день окончания Великой Отечественной войны.")
        page.fill("#event-start-year", "1945")
        page.fill("#event-start-month", "5")
        page.fill("#event-start-day", "9")
        page.select_option("#event-status", "published")
        page.select_option("#event-verification-status", "verified")
        page.fill("#event-hashtag", "ДеньПобеды")
        page.fill("#event-domain", "политика")
        page.select_option("#event-scale", "international")

        form = page.locator("#event-form")
        form.scroll_into_view_if_needed()
        form.screenshot(path=str(OUT_DIR / "02-event-form.png"))

        page.click("#btn-event-preview")
        page.wait_for_selector("#event-preview-modal:not([hidden])")
        page.wait_for_timeout(400)
        page.locator("#event-preview-modal .admin-modal-dialog").screenshot(
            path=str(OUT_DIR / "04-preview-modal.png")
        )
        page.click("#btn-event-preview-close")
        page.wait_for_timeout(200)

        page.goto(f"{BASE_URL}/", wait_until="networkidle")
        page.wait_for_selector(".fact-panel")
        page.fill("#date-search-input", "1945-05-09")
        page.click("#date-search-form button[type='submit']")
        page.wait_for_timeout(1200)
        page.locator(".fact-panel").screenshot(path=str(OUT_DIR / "05-public-page.png"))

        browser.close()

    print("Скриншоты сохранены в", OUT_DIR)
    for name in [
        "00-workflow.png",
        "01-login.png",
        "02-event-form.png",
        "03-references.png",
        "04-preview-modal.png",
        "05-public-page.png",
    ]:
        path = OUT_DIR / name
        print(f"  {'OK' if path.exists() else 'MISSING'} {name}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
