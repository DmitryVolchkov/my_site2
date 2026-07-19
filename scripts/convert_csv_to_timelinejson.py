#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DEPRECATED — не использовать для актуальной сборки JSON.

Публичные файлы `data/timeline_data.json` и `data/scale_data.json` пересобирает
`server.py` (`events_to_timeline`, `write_timeline_files`) из SQLite после
миграций и с учётом статусов публикации, справочников и атрибутов фазы 1.

Этот скрипт оставлен только как историческая заготовка CSV → JSON без сервера.

Запуск (не рекомендуется):
  python scripts/convert_csv_to_timelinejson.py data/events.csv --out-dir ./data
"""
import warnings

warnings.warn(
    "convert_csv_to_timelinejson.py устарел; используйте python server.py",
    DeprecationWarning,
    stacklevel=1,
)
from __future__ import annotations

import argparse, csv, json, re, datetime
from pathlib import Path

def _int_or_none(s: str|None):
    s = (s or '').strip()
    return int(s) if s else None

def _row_get(row: dict, key: str) -> str:
    """Чтение колонки CSV (учёт BOM в заголовке id)."""
    val = row.get(key)
    if val is not None and str(val).strip() != '':
        return str(val).strip()
    bom_key = '\ufeff' + key
    val = row.get(bom_key)
    return (str(val).strip() if val is not None else '')

def csv_to_json(csv_file: Path):
    events = []
    years = []
    with csv_file.open('r', encoding='utf-8-sig', newline='') as f:
        r = csv.DictReader(f)
        for row in r:
            sy = _int_or_none(_row_get(row, 'start_year') or None)
            if sy is None:
                continue
            sm = _int_or_none(_row_get(row, 'start_month') or None)
            sd = _int_or_none(_row_get(row, 'start_day') or None)
            ey = _int_or_none(_row_get(row, 'end_year') or None)
            em = _int_or_none(_row_get(row, 'end_month') or None)
            ed = _int_or_none(_row_get(row, 'end_day') or None)

            years.append(sy)
            if ey is not None:
                years.append(ey)

            ev = {
                'unique_id': _row_get(row, 'id') or None,
                'start_date': {'year': sy},
                'text': {
                    'headline': _row_get(row, 'headline'),
                    'text': _row_get(row, 'text')
                }
            }
            if sm is not None: ev['start_date']['month'] = sm
            if sd is not None: ev['start_date']['day'] = sd

            if ey is not None:
                ev['end_date'] = {'year': ey}
                if em is not None: ev['end_date']['month'] = em
                if ed is not None: ev['end_date']['day'] = ed

            media_url = _row_get(row, 'media_url')
            if media_url:
                ev['media'] = {'url': media_url}
                cap = _row_get(row, 'media_caption')
                cred = _row_get(row, 'media_credit')
                if cap: ev['media']['caption'] = cap
                if cred: ev['media']['credit'] = cred

            group = _row_get(row, 'group')
            if group:
                ev['group'] = group

            tags = _row_get(row, 'tags')
            if tags:
                ev['_tags'] = [t.strip() for t in re.split(r'[;,]', tags) if t.strip()]

            imp = _int_or_none(_row_get(row, 'importance') or None)
            if imp is not None:
                ev['_importance'] = imp

            events.append(ev)

    min_year = min(years) if years else -2000
    max_year = max(years) if years else datetime.date.today().year

    timeline = {
        'events': events
    }

    scale = {
        'minYear': min_year,
        'maxYear': max_year,
        'events': [
            {
                'id': ev.get('unique_id'),
                'year': ev['start_date']['year'],
                'headline': ev['text']['headline'],
                'group': ev.get('group'),
                'importance': ev.get('_importance', 1)
            } for ev in events
        ]
    }
    return timeline, scale

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv', type=Path)
    ap.add_argument('--out-dir', type=Path, default=Path('./data'))
    args = ap.parse_args()

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    timeline, scale = csv_to_json(args.csv)
    (out_dir / 'timeline_data.json').write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding='utf-8')
    (out_dir / 'scale_data.json').write_text(json.dumps(scale, ensure_ascii=False, indent=2), encoding='utf-8')
    print('OK:', out_dir / 'timeline_data.json')
    print('OK:', out_dir / 'scale_data.json')

if __name__ == '__main__':
    main()
