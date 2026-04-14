#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CSV → TimelineJS JSON (+ JSON для вашей шапки-шкалы)

Запуск:
  python convert_csv_to_timelinejson.py events.csv --out-dir ./data

Результат:
  data/timeline_data.json  (для TimelineJS)
  data/scale_data.json     (для вашей шкалы)
"""
from __future__ import annotations

import argparse, csv, json, re, datetime
from pathlib import Path

def _int_or_none(s: str|None):
    s = (s or '').strip()
    return int(s) if s else None

def csv_to_json(csv_file: Path):
    events = []
    years = []
    with csv_file.open('r', encoding='utf-8', newline='') as f:
        r = csv.DictReader(f)
        for row in r:
            sy = _int_or_none(row.get('start_year'))
            if sy is None:
                continue
            sm = _int_or_none(row.get('start_month'))
            sd = _int_or_none(row.get('start_day'))
            ey = _int_or_none(row.get('end_year'))
            em = _int_or_none(row.get('end_month'))
            ed = _int_or_none(row.get('end_day'))

            years.append(sy)
            if ey is not None:
                years.append(ey)

            ev = {
                'unique_id': row.get('id') or None,
                'start_date': {'year': sy},
                'text': {
                    'headline': (row.get('headline') or '').strip(),
                    'text': (row.get('text') or '').strip()
                }
            }
            if sm is not None: ev['start_date']['month'] = sm
            if sd is not None: ev['start_date']['day'] = sd

            if ey is not None:
                ev['end_date'] = {'year': ey}
                if em is not None: ev['end_date']['month'] = em
                if ed is not None: ev['end_date']['day'] = ed

            media_url = (row.get('media_url') or '').strip()
            if media_url:
                ev['media'] = {'url': media_url}
                cap = (row.get('media_caption') or '').strip()
                cred = (row.get('media_credit') or '').strip()
                if cap: ev['media']['caption'] = cap
                if cred: ev['media']['credit'] = cred

            group = (row.get('group') or '').strip()
            if group:
                ev['group'] = group

            tags = (row.get('tags') or '').strip()
            if tags:
                ev['_tags'] = [t.strip() for t in re.split(r'[;,]', tags) if t.strip()]

            imp = _int_or_none(row.get('importance'))
            if imp is not None:
                ev['_importance'] = imp

            events.append(ev)

    min_year = min(years) if years else -2000
    max_year = max(years) if years else datetime.date.today().year

    timeline = {
        'title': {
            'text': {
                'headline': 'Мой таймлайн',
                'text': 'Данные загружаются из CSV → JSON и используются и TimelineJS, и вашей шкалой.'
            }
        },
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
