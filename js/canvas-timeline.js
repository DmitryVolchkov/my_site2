/**
 * ArchiveCanvasTimeline — собственный Canvas-рендер шкалы времени (MVP этап 1 + этап 2 «Полосы»).
 * Спека: docs/open-spec-canvas-timeline.md, docs/open-spec-country-lanes.md.
 * Заменяет TimelineJS за флагом ?timeline=canvas.
 *
 * Ключевые решения из спеки:
 *  - первый draw() только после ненулевых размеров контейнера (ResizeObserver, без ретраев);
 *  - рендер по dirty-флагу, без постоянного rAF-цикла;
 *  - данные viewport через GET /api/timeline/markers (+ /range для границ), AbortController + дебаунс;
 *  - полоса «Все события» (default) — greedy-разводка перекрытий по рядам, флаг = заголовок;
 *  - пользовательские полосы (participant_country, setLanes) — флаг = только дата + бейдж «×N»
 *    при нескольких событиях на одну дату (open-spec-country-lanes.md, п. 1); заголовок — в hover;
 *  - параллельный sr-only список маркеров для клавиатуры и скринридера — не теряет детализацию
 *    даже там, где визуально события схлопнуты в один флаг-кластер;
 *  - touch-action: pan-y — вертикальный скролл страницы не перехватывается.
 */
(function () {
  'use strict';

  var DAY_MS = 86400000;

  function yearFloat(y, m, d) {
    return y + ((m || 1) - 1) / 12 + ((d || 1) - 1) / 365;
  }

  function markerYear(mk, endSide) {
    var dd = endSide ? mk.end_date : mk.date;
    if (!dd) return null;
    return yearFloat(dd.year, dd.month, dd.day);
  }

  function create(containerId, options) {
    options = options || {};
    var container = document.getElementById(containerId);
    if (!container) throw new Error('ArchiveCanvasTimeline: контейнер не найден: ' + containerId);

    var state = {
      t0: 1930, t1: 1950,
      markers: [],
      lanesInfo: [{ id: 'default', title: 'Все события', kind: 'default' }],
      lanesConfig: [], // пользовательские полосы, заданные через setLanes() — open-spec-canvas-timeline.md «Конфиг полосы»
      groupId: '',
      clusters: [], // кластеры дата+бейдж для непользовательских (не-default) полос — вычисляются в layoutMarkers()
      range: null,
      hoverId: null,     // hoverId — id маркера (default-лента) или "cluster:<lane>:<date>" (полосы стран)
      selectedId: null,
      dirty: false,
      rafScheduled: false,
      fetchTimer: null,
      abortCtrl: null,
      width: 0, height: 0,
      handlers: { select: [], hover: [], ready: [], error: [], change: [], markerclick: [] },
      destroyed: false,
      readyFired: false
    };

    container.classList.add('archive-canvas-timeline');
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    var tooltip = document.createElement('div');
    tooltip.className = 'act-tooltip';
    tooltip.hidden = true;
    var a11y = document.createElement('ul');
    a11y.className = 'act-sr-list';
    a11y.setAttribute('aria-label', 'События таймлайна в видимой области');
    container.appendChild(canvas);
    container.appendChild(tooltip);
    container.appendChild(a11y);
    var ctx = canvas.getContext('2d');

    function emit(name, payload) {
      (state.handlers[name] || []).forEach(function (h) {
        try { h(payload); } catch (e) { console.error(e); }
      });
    }

    function cssVar(name, fallback) {
      var v = getComputedStyle(container).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    }

    function xOf(year) {
      return ((year - state.t0) / (state.t1 - state.t0)) * state.width;
    }

    function yearAt(px) {
      return state.t0 + (px / state.width) * (state.t1 - state.t0);
    }

    function requestDraw() {
      state.dirty = true;
      if (state.rafScheduled || state.destroyed) return;
      state.rafScheduled = true;
      requestAnimationFrame(function () {
        state.rafScheduled = false;
        if (state.dirty) draw();
      });
    }

    /* ---------- данные ---------- */

    function scheduleFetch() {
      clearTimeout(state.fetchTimer);
      state.fetchTimer = setTimeout(fetchMarkers, 90);
    }

    function fetchMarkers() {
      if (state.abortCtrl) state.abortCtrl.abort();
      var ctrl = new AbortController();
      state.abortCtrl = ctrl;
      var from = Math.floor(state.t0), to = Math.ceil(state.t1);
      var url = '/api/timeline/markers?from=' + from + '&to=' + to + '&limit=500';
      if (state.lanesConfig.length) url += '&lanes=' + encodeURIComponent(JSON.stringify(state.lanesConfig));
      if (state.groupId) url += '&group_id=' + encodeURIComponent(state.groupId);
      fetch(url, { signal: ctrl.signal })
        .then(function (r) { if (!r.ok) throw new Error('markers HTTP ' + r.status); return r.json(); })
        .then(function (data) {
          if (ctrl !== state.abortCtrl) return;
          state.markers = data.markers || [];
          state.lanesInfo = data.lanes || state.lanesInfo;
          state.range = data.range || state.range;
          layoutMarkers();
          rebuildA11y();
          requestDraw();
          if (!state.readyFired) { state.readyFired = true; emit('ready', { count: state.markers.length }); }
        })
        .catch(function (err) {
          if (err.name === 'AbortError') return;
          emit('error', err);
        });
    }

    /* ---------- геометрия: полоса «Все события» сверху, полосы-участники компактными
       лентами над осью (open-spec-country-lanes.md, «Порядок работ», блок D) ---------- */

    function geometry() {
      var axisY = state.height - 24;
      var laneIds = state.lanesConfig.map(function (l) { return l.id; });
      var bandH = 16, gap = 3;
      var participantAreaHeight = laneIds.length ? laneIds.length * (bandH + gap) + 4 : 0;
      var defaultBottom = axisY - participantAreaHeight - (laneIds.length ? 6 : 0);
      var bands = {};
      laneIds.forEach(function (id, i) {
        bands[id] = { y: defaultBottom + 6 + i * (bandH + gap), h: bandH };
      });
      return { axisY: axisY, defaultTop: 4, defaultBottom: defaultBottom, bands: bands, bandH: bandH };
    }

    function laneTitle(laneId) {
      var info = state.lanesInfo.find(function (l) { return l.id === laneId; });
      return info ? info.title : laneId;
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    function formatShortDate(d) {
      if (d.day && d.month) return pad2(d.day) + '.' + pad2(d.month);
      if (d.month) return pad2(d.month) + '.' + d.year;
      return String(d.year);
    }

    /* ---------- раскладка (greedy-разводка перекрытий) ---------- */

    function markerWidth(mk) {
      var label = mk.headline || '';
      return Math.min(150, Math.max(46, 12 + label.length * 6.2));
    }

    function layoutMarkers() {
      var defaultMarkers = [];
      var byLane = {};
      state.markers.forEach(function (mk) {
        mk._x = xOf(markerYear(mk));
        mk._x2 = mk.end_date ? xOf(markerYear(mk, true)) : null;
        if (mk.lane_id === 'default') defaultMarkers.push(mk);
        else (byLane[mk.lane_id] = byLane[mk.lane_id] || []).push(mk);
      });

      var rows = [[], [], []];
      defaultMarkers
        .slice()
        .sort(function (a, b) { return markerYear(a) - markerYear(b); })
        .forEach(function (mk) {
          mk._w = markerWidth(mk);
          var placed = false;
          for (var r = 0; r < rows.length; r++) {
            var last = rows[r][rows[r].length - 1];
            if (!last || last._x + last._w + 6 <= mk._x) {
              rows[r].push(mk);
              mk._row = r;
              placed = true;
              break;
            }
          }
          if (!placed) {
            var best = 0;
            for (var i = 1; i < rows.length; i++) {
              if (rows[i][rows[i].length - 1]._x < rows[best][rows[best].length - 1]._x) best = i;
            }
            rows[best].push(mk);
            mk._row = best;
          }
        });

      // Полосы-участники: флаг = дата (не заголовок); несколько событий на одну дату
      // схлопываются в один кластер с бейджем «×N» — open-spec-country-lanes.md, п. 1.
      var clusters = [];
      Object.keys(byLane).forEach(function (laneId) {
        var byDate = {};
        byLane[laneId].forEach(function (mk) {
          var d = mk.date;
          var key = d.year + '-' + (d.month || 0) + '-' + (d.day || 0);
          (byDate[key] = byDate[key] || []).push(mk);
        });
        Object.keys(byDate).forEach(function (key) {
          var list = byDate[key];
          clusters.push({
            id: 'cluster:' + laneId + ':' + key,
            laneId: laneId,
            x: xOf(markerYear(list[0])),
            date: list[0].date,
            markers: list
          });
        });
      });
      state.clusters = clusters;
    }

    /* ---------- отрисовка ---------- */

    function draw() {
      state.dirty = false;
      if (!state.width || !state.height) return;
      var dpr = window.devicePixelRatio || 1;
      if (canvas.width !== state.width * dpr || canvas.height !== state.height * dpr) {
        canvas.width = state.width * dpr;
        canvas.height = state.height * dpr;
        canvas.style.width = state.width + 'px';
        canvas.style.height = state.height + 'px';
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, state.width, state.height);

      var geo = geometry();
      var axisY = geo.axisY;
      var colAxis = cssVar('--act-axis', '#8a8a86');
      var colText = cssVar('--act-text', '#333');
      var colFlag = cssVar('--act-flag', '#e8f0fb');
      var colFlagBorder = cssVar('--act-flag-border', '#3a7bd5');
      var colAccent = cssVar('--act-accent', '#1d5fbf');

      ctx.strokeStyle = colAxis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, axisY);
      ctx.lineTo(state.width, axisY);
      ctx.stroke();

      var pxPerYear = state.width / (state.t1 - state.t0);
      var steps = [1, 2, 5, 10, 20, 50, 100];
      var step = steps[steps.length - 1];
      for (var i = 0; i < steps.length; i++) {
        if (pxPerYear * steps[i] >= 56) { step = steps[i]; break; }
      }
      ctx.fillStyle = colText;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      var yStart = Math.ceil(state.t0 / step) * step;
      for (var y = yStart; y <= state.t1; y += step) {
        var x = xOf(y);
        ctx.strokeStyle = colAxis;
        ctx.beginPath();
        ctx.moveTo(x, axisY);
        ctx.lineTo(x, axisY + 5);
        ctx.stroke();
        ctx.fillText(String(y), x, axisY + 16);
      }

      state.markers.filter(function (mk) { return mk.lane_id === 'default'; }).forEach(function (mk) {
        mk._x = xOf(markerYear(mk));
        if (mk.end_date) mk._x2 = xOf(markerYear(mk, true));
        var rowY = geo.defaultTop + 10 + (mk._row || 0) * 26;
        var isHover = mk.id === state.hoverId;
        var isSel = mk.id === state.selectedId;
        var border = isSel ? colAccent : colFlagBorder;

        if (mk._x2 !== null && mk._x2 !== undefined && mk._x2 - mk._x > 8) {
          ctx.strokeStyle = border;
          ctx.lineWidth = isSel || isHover ? 2 : 1.2;
          var by = axisY - 8;
          ctx.beginPath();
          ctx.moveTo(mk._x, by);
          ctx.lineTo(mk._x, by - 6);
          ctx.lineTo(mk._x2, by - 6);
          ctx.lineTo(mk._x2, by);
          ctx.stroke();
        }

        ctx.strokeStyle = border;
        ctx.lineWidth = isSel || isHover ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(mk._x, rowY + 18);
        ctx.lineTo(mk._x, axisY);
        ctx.stroke();

        var w = mk._w;
        ctx.fillStyle = isSel ? colAccent : colFlag;
        ctx.strokeStyle = border;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(mk._x, rowY, w, 18, 4);
        else ctx.rect(mk._x, rowY, w, 18);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = isSel ? '#fff' : colText;
        ctx.textAlign = 'left';
        ctx.font = (isSel || isHover ? 'bold ' : '') + '11px sans-serif';
        var label = mk.headline || mk.id;
        var maxChars = Math.floor((w - 10) / 6.2);
        if (label.length > maxChars) label = label.slice(0, Math.max(1, maxChars - 1)) + '…';
        ctx.fillText(label, mk._x + 5, rowY + 13);
      });

      // Полосы-участники: подпись полосы слева + кластеры дата+бейдж (open-spec-country-lanes.md, п. 1)
      state.lanesConfig.forEach(function (lane) {
        var band = geo.bands[lane.id];
        if (!band) return;
        ctx.fillStyle = colText;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(laneTitle(lane.id), 2, band.y + band.h - 4);
      });
      state.clusters.forEach(function (cl) {
        var band = geo.bands[cl.laneId];
        if (!band) return;
        var isHover = state.hoverId === cl.id;
        var isSel = cl.markers.length === 1 && cl.markers[0].id === state.selectedId;
        var border = isSel ? colAccent : colFlagBorder;
        var label = formatShortDate(cl.date) + (cl.markers.length > 1 ? ' ×' + cl.markers.length : '');
        var w = Math.max(30, 8 + label.length * 6);
        cl._w = w;
        cl._y = band.y;
        ctx.strokeStyle = border;
        ctx.lineWidth = isSel || isHover ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(cl.x, band.y);
        ctx.lineTo(cl.x, band.y + band.h + 4);
        ctx.stroke();
        ctx.fillStyle = isSel ? colAccent : colFlag;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(cl.x, band.y, w, band.h, 3);
        else ctx.rect(cl.x, band.y, w, band.h);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = isSel ? '#fff' : colText;
        ctx.font = (isHover ? 'bold ' : '') + '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(label, cl.x + 3, band.y + band.h - 4);
      });
    }

    /* ---------- hit-test и взаимодействие ---------- */

    function hitTest(px, py) {
      var geo = geometry();
      for (var c = state.clusters.length - 1; c >= 0; c--) {
        var cl = state.clusters[c];
        var band = geo.bands[cl.laneId];
        if (!band || cl._w == null) continue;
        if (px >= cl.x - 3 && px <= cl.x + cl._w + 3 && py >= band.y - 3 && py <= band.y + band.h + 3) {
          return { cluster: cl };
        }
      }
      var defaultMarkers = state.markers.filter(function (mk) { return mk.lane_id === 'default'; });
      for (var i = defaultMarkers.length - 1; i >= 0; i--) {
        var mk = defaultMarkers[i];
        var rowY = geo.defaultTop + 10 + (mk._row || 0) * 26;
        if (px >= mk._x - 3 && px <= mk._x + mk._w + 3 && py >= rowY - 3 && py <= rowY + 21) return { marker: mk };
      }
      return null;
    }

    function selectMarker(mk, opts) {
      state.selectedId = mk ? mk.id : null;
      requestDraw();
      if (mk) {
        var payload = { unique_id: mk.id, marker: mk };
        emit('select', payload);
        emit('change', payload);
        emit('markerclick', payload);
      }
    }

    var drag = { active: false, moved: false, x0: 0, t0: 0, t1: 0, pointers: {}, pinch: null };

    canvas.addEventListener('pointerdown', function (e) {
      drag.pointers[e.pointerId] = { x: e.offsetX, y: e.offsetY };
      var ids = Object.keys(drag.pointers);
      if (ids.length === 2) {
        var a = drag.pointers[ids[0]], b = drag.pointers[ids[1]];
        drag.pinch = { dist: Math.abs(a.x - b.x) || 1, t0: state.t0, t1: state.t1, cx: (a.x + b.x) / 2 };
        drag.active = false;
      } else {
        drag.active = true;
        drag.moved = false;
        drag.x0 = e.offsetX;
        drag.t0 = state.t0;
        drag.t1 = state.t1;
      }
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', function (e) {
      if (drag.pointers[e.pointerId]) drag.pointers[e.pointerId] = { x: e.offsetX, y: e.offsetY };
      var ids = Object.keys(drag.pointers);
      if (drag.pinch && ids.length === 2) {
        var a = drag.pointers[ids[0]], b = drag.pointers[ids[1]];
        var scale = drag.pinch.dist / (Math.abs(a.x - b.x) || 1);
        var span0 = drag.pinch.t1 - drag.pinch.t0;
        var center = drag.pinch.t0 + (drag.pinch.cx / state.width) * span0;
        var span = Math.max(0.2, Math.min(3000, span0 * scale));
        state.t0 = center - (drag.pinch.cx / state.width) * span;
        state.t1 = state.t0 + span;
        layoutMarkers();
        requestDraw();
        scheduleFetch();
        return;
      }
      if (drag.active && ids.length === 1) {
        var dx = e.offsetX - drag.x0;
        if (Math.abs(dx) > 4) drag.moved = true;
        var span1 = drag.t1 - drag.t0;
        state.t0 = drag.t0 - (dx / state.width) * span1;
        state.t1 = state.t0 + span1;
        layoutMarkers();
        requestDraw();
        scheduleFetch();
        return;
      }
      var hit = hitTest(e.offsetX, e.offsetY);
      var newHover = hit ? (hit.marker ? hit.marker.id : hit.cluster.id) : null;
      if (newHover !== state.hoverId) {
        state.hoverId = newHover;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        if (hit && hit.marker) {
          var mk = hit.marker;
          tooltip.textContent = (mk.headline || '') + ' — ' + formatMarkerDate(mk);
          tooltip.hidden = false;
          var tx = Math.max(4, Math.min(e.offsetX + 10, state.width - tooltip.offsetWidth - 4));
          tooltip.style.left = tx + 'px';
          tooltip.style.top = Math.max(2, e.offsetY - 30) + 'px';
          emit('hover', { unique_id: mk.id, marker: mk });
        } else if (hit && hit.cluster) {
          var cl = hit.cluster;
          var titles = cl.markers.map(function (m) { return m.headline || m.id; }).join('; ');
          tooltip.textContent = formatMarkerDate(cl.markers[0]) + ' — ' + titles;
          tooltip.hidden = false;
          var tx2 = Math.max(4, Math.min(e.offsetX + 10, state.width - tooltip.offsetWidth - 4));
          tooltip.style.left = tx2 + 'px';
          tooltip.style.top = Math.max(2, e.offsetY - 30) + 'px';
          emit('hover', { unique_id: cl.markers[0].id, marker: cl.markers[0], cluster: cl });
        } else {
          tooltip.hidden = true;
        }
        requestDraw();
      }
    });

    function endPointer(e) {
      var wasDrag = drag.moved;
      delete drag.pointers[e.pointerId];
      if (Object.keys(drag.pointers).length < 2) drag.pinch = null;
      if (drag.active && Object.keys(drag.pointers).length === 0) {
        drag.active = false;
        if (!wasDrag) {
          var hit = hitTest(e.offsetX, e.offsetY);
          if (hit && hit.marker) selectMarker(hit.marker);
          // Кластер с несколькими событиями на одну дату: MVP выбирает первое (заголовки —
          // в hover-подсказке); полноценный разворот списка — лестница зума, п. 8 country-lanes.
          else if (hit && hit.cluster) selectMarker(hit.cluster.markers[0]);
        }
      }
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', function (e) { delete drag.pointers[e.pointerId]; drag.pinch = null; drag.active = false; });
    canvas.addEventListener('pointerleave', function () {
      if (state.hoverId) { state.hoverId = null; tooltip.hidden = true; requestDraw(); }
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var span = state.t1 - state.t0;
      if (e.shiftKey || e.ctrlKey) {
        var factor = Math.pow(1.0015, e.deltaY);
        var center = yearAt(e.offsetX);
        var newSpan = Math.max(0.2, Math.min(3000, span * factor));
        state.t0 = center - ((e.offsetX / state.width) * newSpan);
        state.t1 = state.t0 + newSpan;
      } else {
        var delta = (e.deltaX || e.deltaY) / state.width * span;
        state.t0 += delta;
        state.t1 += delta;
      }
      layoutMarkers();
      requestDraw();
      scheduleFetch();
    }, { passive: false });

    function formatMarkerDate(mk) {
      var d = mk.date;
      var s = (d.day ? String(d.day).padStart(2, '0') + '.' : '') + (d.month ? String(d.month).padStart(2, '0') + '.' : '') + d.year;
      if (mk.end_date) {
        var e2 = mk.end_date;
        s += ' — ' + (e2.day ? String(e2.day).padStart(2, '0') + '.' : '') + (e2.month ? String(e2.month).padStart(2, '0') + '.' : '') + e2.year;
      }
      return s;
    }

    /* ---------- доступность ---------- */

    function rebuildA11y() {
      // Полный список маркеров (без кластеризации) — доступность не теряет детализацию
      // даже там, где визуально события схлопнуты в один флаг-кластер полосы (см. draw()).
      a11y.innerHTML = '';
      state.markers.forEach(function (mk) {
        var li = document.createElement('li');
        var btn = document.createElement('button');
        btn.type = 'button';
        var prefix = mk.lane_id && mk.lane_id !== 'default' ? laneTitle(mk.lane_id) + ' — ' : '';
        btn.textContent = prefix + (mk.headline || mk.id) + ', ' + formatMarkerDate(mk);
        btn.addEventListener('click', function () { selectMarker(mk); });
        li.appendChild(btn);
        a11y.appendChild(li);
      });
    }

    /* ---------- инициализация без гонки ---------- */

    var ro = new ResizeObserver(function (entries) {
      var rect = entries[entries.length - 1].contentRect;
      if (!rect.width || !rect.height) return;
      var first = !state.width;
      state.width = Math.round(rect.width);
      state.height = Math.round(rect.height);
      layoutMarkers();
      requestDraw();
      if (first) {
        fetch('/api/timeline/range')
          .then(function (r) { return r.json(); })
          .then(function (rng) {
            state.range = rng;
            if (rng.min_year != null && rng.max_year != null) {
              var pad = Math.max(0.5, (rng.max_year - rng.min_year) * 0.08);
              state.t0 = rng.min_year - pad;
              state.t1 = rng.max_year + 1 + pad;
            }
            fetchMarkers();
          })
          .catch(function (err) { emit('error', err); fetchMarkers(); });
      }
    });
    ro.observe(container);

    /* ---------- публичный API (canvas-спека, «Структура модуля») ---------- */

    var api = {
      setViewport: function (fromYear, toYear) {
        state.t0 = Number(fromYear);
        state.t1 = Number(toYear);
        layoutMarkers();
        requestDraw();
        scheduleFetch();
      },
      refresh: fetchMarkers,
      on: function (name, handler) {
        (state.handlers[name] = state.handlers[name] || []).push(handler);
      },
      // Конфиг активных полос — open-spec-canvas-timeline.md, «Конфиг полосы (JSON)»:
      // [{ id, kind: 'participant_country', value, title }, ...]. Полоса «Все события»
      // не задаётся явно — она есть всегда и не участвует в дублировании маркеров.
      setLanes: function (laneConfig) {
        state.lanesConfig = (laneConfig || []).filter(function (l) { return l && l.kind && l.value; });
        if (state.width) fetchMarkers(); // явная смена конфигурации — без дебаунса drag/zoom
      },
      getLanes: function () {
        return state.lanesConfig.slice();
      },
      // MVP этапа 2: фильтр по группе (с иерархией на сервере — основная группа включает подгруппы)
      setFilters: function (filters) {
        state.groupId = (filters && filters.group_id) || '';
        if (state.width) fetchMarkers();
      },
      select: function (id) {
        var mk = state.markers.find(function (m) { return m.id === id; });
        if (mk) selectMarker(mk);
      },
      goToId: function (id) {
        var mk = state.markers.find(function (m) { return m.id === id; });
        if (mk) {
          var y = markerYear(mk);
          var span = state.t1 - state.t0;
          api.setViewport(y - span / 2, y + span / 2);
          state.selectedId = mk.id;
          requestDraw();
        }
      },
      goToDate: function (isoDate) {
        var parts = String(isoDate).split('-').map(Number);
        var y = yearFloat(parts[0], parts[1], parts[2]);
        var span = Math.min(state.t1 - state.t0, 4);
        api.setViewport(y - span / 2, y + span / 2);
      },
      destroy: function () {
        state.destroyed = true;
        ro.disconnect();
        clearTimeout(state.fetchTimer);
        if (state.abortCtrl) state.abortCtrl.abort();
        container.innerHTML = '';
      }
    };
    return api;
  }

  window.ArchiveCanvasTimeline = {
    init: function (containerId, options) {
      return create(containerId, options);
    }
  };
})();
