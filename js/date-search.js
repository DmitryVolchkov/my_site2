/**

 * Поиск по дате: прокрутка TimelineJS и обновление блока факта.

 */

(function () {

  var DEFAULT_STATUS = 'Статус поиска';



  function eventToDate(ev) {

    var d = ev.start_date || {};

    return new Date(

      Number(d.year),

      (Number(d.month) || 1) - 1,

      Number(d.day) || 1

    );

  }



  function dateToInputValue(date) {

    var y = date.getFullYear();

    var m = String(date.getMonth() + 1).padStart(2, '0');

    var d = String(date.getDate()).padStart(2, '0');

    return y + '-' + m + '-' + d;

  }



  function formatDateRu(ev) {
    if (window.ArchiveDateFormat && typeof window.ArchiveDateFormat.formatEventDate === 'function') {
      return window.ArchiveDateFormat.formatEventDate(ev);
    }

    var d = ev.start_date || {};
    var parts = [];
    if (d.day) parts.push(String(d.day).padStart(2, '0'));
    if (d.month) parts.push(String(d.month).padStart(2, '0'));
    if (d.year) parts.push(String(d.year));
    return parts.join('.');
  }



  function daysBetween(a, b) {

    return Math.round(Math.abs(a.getTime() - b.getTime()) / 86400000);

  }



  function eventsWord(count) {

    var n = Math.abs(count) % 100;

    var n1 = n % 10;

    if (n1 === 1 && n !== 11) return 'событие';

    if (n1 >= 2 && n1 <= 4 && (n < 12 || n > 14)) return 'события';

    return 'событий';

  }



  function exactMatchStatus(count) {

    return 'Найдено ' + count + ' ' + eventsWord(count) + ' на выбранную дату.';

  }



  function findBestEvent(events, target) {

    var exactMatches = [];

    var closest = null;

    var closestDiff = Infinity;

    var targetKey = dateToInputValue(target);



    for (var i = 0; i < events.length; i++) {

      var ev = events[i];

      var evDate = eventToDate(ev);

      if (dateToInputValue(evDate) === targetKey) {

        exactMatches.push(ev);

      }

      var diff = Math.abs(evDate.getTime() - target.getTime());

      if (diff < closestDiff) {

        closestDiff = diff;

        closest = ev;

      }

    }



    return {

      exactMatches: exactMatches,

      exact: exactMatches[0] || null,

      closest: closest

    };

  }



  function setStatus(text, type) {

    var el = document.getElementById('date-search-status');

    if (!el) return;

    el.textContent = text || DEFAULT_STATUS;

    el.classList.remove('is-error', 'is-success');

    if (type) el.classList.add(type);

  }



  function isImageMediaUrl(url) {

    if (!url) return false;

    if (url.indexOf('data:image/') === 0) return true;

    return /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(url);

  }



  function renderFactMedia(mediaEl, ev) {

    if (!mediaEl) return;

    mediaEl.innerHTML = '';

    if (!ev || !ev.media || !ev.media.url) return;

    var url = ev.media.url;

    if (isImageMediaUrl(url)) {

      var figure = document.createElement('figure');

      figure.className = 'fact-media';

      var img = document.createElement('img');

      img.src = url;

      img.alt = ev.media.caption || (ev.text && ev.text.headline) || '';

      figure.appendChild(img);

      if (ev.media.caption || ev.media.credit) {

        var caption = document.createElement('figcaption');

        caption.textContent = [ev.media.caption, ev.media.credit].filter(Boolean).join(' · ');

        figure.appendChild(caption);

      }

      mediaEl.appendChild(figure);

      return;

    }

    var linkWrap = document.createElement('p');

    linkWrap.className = 'fact-media fact-media-link';

    var a = document.createElement('a');

    a.href = url;

    a.target = '_blank';

    a.rel = 'noopener';

    a.textContent = ev.media.caption || url;

    linkWrap.appendChild(a);

    mediaEl.appendChild(linkWrap);

  }



  function isFactFullTextClamped(textEl) {

    if (!textEl || !textEl.textContent.trim()) return false;

    return textEl.scrollHeight > textEl.clientHeight + 1;

  }



  function setFactFullExpanded(fullEl, toggleEl, expanded) {

    if (!fullEl) return;

    fullEl.classList.toggle('is-collapsed', !expanded);

    fullEl.classList.toggle('is-expanded', expanded);

    if (toggleEl) {

      toggleEl.textContent = expanded ? 'Свернуть' : 'Читать полностью';

    }

  }



  function updateFactFullToggle(fullEl, fullTextEl, toggleEl, hasMedia) {

    if (!fullEl || !fullTextEl || !toggleEl) return;

    var needsToggle = hasMedia || isFactFullTextClamped(fullTextEl);

    toggleEl.hidden = !needsToggle;

    if (!needsToggle) {

      setFactFullExpanded(fullEl, toggleEl, true);

      return;

    }

    setFactFullExpanded(fullEl, toggleEl, false);

  }



  function bindFactFullToggleEl(fullEl, toggleEl) {

    if (!fullEl || !toggleEl || toggleEl.dataset.bound === '1') return;

    toggleEl.dataset.bound = '1';

    toggleEl.addEventListener('click', function () {

      var expanded = fullEl.classList.contains('is-expanded');

      setFactFullExpanded(fullEl, toggleEl, !expanded);

    });

  }



  function bindFactFullToggle() {

    bindFactFullToggleEl(document.getElementById('fact-full'), document.getElementById('fact-full-toggle'));

  }



  function gatherMainFactRefs() {

    var titleEl = document.querySelector('.fact-panel .fact-title');

    var hashtagEl = document.getElementById('fact-hashtag');

    var dateEl = document.querySelector('.fact-panel .fact-date');

    var summaryBlockEl = document.getElementById('fact-summary-block');

    var summaryEl = document.getElementById('fact-summary');

    var fullEl = document.getElementById('fact-full');

    var fullTextEl = document.getElementById('fact-full-text');

    var mediaEl = document.getElementById('fact-full-media');

    var toggleEl = document.getElementById('fact-full-toggle');

    var bodyEl = document.querySelector('.fact-panel .fact-body');

    if (!titleEl || !dateEl || !summaryBlockEl || !summaryEl || !fullEl || !fullTextEl || !mediaEl || !toggleEl || !bodyEl) {
      return null;
    }

    return {
      titleEl: titleEl,
      hashtagEl: hashtagEl,
      dateEl: dateEl,
      summaryBlockEl: summaryBlockEl,
      summaryEl: summaryEl,
      fullEl: fullEl,
      fullTextEl: fullTextEl,
      mediaEl: mediaEl,
      toggleEl: toggleEl,
      bodyEl: bodyEl
    };

  }



  function renderFactCard(refs, ev) {

    bindFactFullToggleEl(refs.fullEl, refs.toggleEl);

    var oldRelated = refs.bodyEl.querySelector('.fact-related:not(.fact-attached)');

    if (oldRelated) oldRelated.remove();

    renderAttachedMembers(refs, {});

    renderFactMedia(refs.mediaEl, null);



    if (!ev) {

      refs.titleEl.textContent = 'Событие не найдено';

      if (refs.hashtagEl) {
        refs.hashtagEl.textContent = '';
        refs.hashtagEl.hidden = true;
      }

      refs.dateEl.textContent = '—';

      refs.summaryBlockEl.hidden = true;
      refs.summaryEl.textContent = '';
      refs.fullEl.hidden = false;
      refs.fullTextEl.textContent = 'По выбранной дате записей в архиве нет.';
      refs.toggleEl.hidden = true;
      setFactFullExpanded(refs.fullEl, refs.toggleEl, true);

      return;

    }



    var headline = (ev.text && ev.text.headline) || 'Без названия';

    var summary = (ev._summary || '').trim();

    var body = (ev.text && ev.text.text) || '';

    var hasMedia = Boolean(ev.media && ev.media.url);

    var group = ev.group ? ' · ' + ev.group : '';

    var location = [ev._city, ev._region, ev._country_name].filter(Boolean).join(', ');

    var meta = [ev._scale, ev._event_type, ev._domain]
      .filter(Boolean)
      .join(' · ');



    refs.titleEl.textContent = headline;

    if (refs.hashtagEl) {
      var hashtag = ev._hashtag || '';
      if (hashtag && hashtag.charAt(0) !== '#') {
        hashtag = '#' + hashtag;
      }
      if (hashtag) {
        refs.hashtagEl.textContent = hashtag;
        refs.hashtagEl.hidden = false;
      } else {
        refs.hashtagEl.textContent = '';
        refs.hashtagEl.hidden = true;
      }
    }

    refs.dateEl.textContent = [formatDateRu(ev), location, group.replace(/^ · /, ''), meta].filter(Boolean).join(' · ');

    if (summary) {
      refs.summaryEl.textContent = summary;
      refs.summaryBlockEl.hidden = false;
    } else {
      refs.summaryEl.textContent = '';
      refs.summaryBlockEl.hidden = true;
    }

    renderAttachedMembers(refs, ev);

    var hasAttachedFull = Boolean(refs.fullEl.querySelector('.fact-attached-full'));

    if (body.trim() || hasMedia || hasAttachedFull) {
      refs.fullEl.hidden = false;
      refs.fullTextEl.textContent = body.trim() || '';
      renderFactMedia(refs.mediaEl, ev);
      setFactFullExpanded(refs.fullEl, refs.toggleEl, false);
      requestAnimationFrame(function () {
        updateFactFullToggle(refs.fullEl, refs.fullTextEl, refs.toggleEl, hasMedia || hasAttachedFull);
      });
    } else if (!summary) {
      refs.fullEl.hidden = false;
      refs.fullTextEl.textContent = 'Описание отсутствует.';
      refs.toggleEl.hidden = true;
      setFactFullExpanded(refs.fullEl, refs.toggleEl, true);
    } else {
      refs.fullEl.hidden = true;
      refs.fullTextEl.textContent = '';
      refs.toggleEl.hidden = true;
    }

    renderFactRelated(refs.bodyEl, ev);

  }



  function updateFactPanel(ev) {

    var refs = gatherMainFactRefs();

    if (!refs) return;

    renderFactCard(refs, ev);

  }



  function buildExtraFactCard() {

    var section = document.createElement('section');

    section.className = 'fact-panel fact-card';

    section.innerHTML =
      '<div class="fact-meta">' +
        '<div class="fact-title-row">' +
          '<div class="fact-title"></div>' +
          '<span class="fact-hashtag" hidden></span>' +
        '</div>' +
        '<div class="fact-date"></div>' +
      '</div>' +
      '<div class="fact-body">' +
        '<div class="fact-summary-block" hidden>' +
          '<h3 class="fact-block-label">Кратко</h3>' +
          '<p class="fact-summary"></p>' +
        '</div>' +
        '<div class="fact-full is-collapsed">' +
          '<h3 class="fact-block-label">Описание</h3>' +
          '<p class="fact-full-text"></p>' +
          '<div class="fact-full-media"></div>' +
          '<button type="button" class="fact-full-toggle" hidden>Читать полностью</button>' +
        '</div>' +
      '</div>';

    return {
      root: section,
      refs: {
        titleEl: section.querySelector('.fact-title'),
        hashtagEl: section.querySelector('.fact-hashtag'),
        dateEl: section.querySelector('.fact-date'),
        summaryBlockEl: section.querySelector('.fact-summary-block'),
        summaryEl: section.querySelector('.fact-summary'),
        fullEl: section.querySelector('.fact-full'),
        fullTextEl: section.querySelector('.fact-full-text'),
        mediaEl: section.querySelector('.fact-full-media'),
        toggleEl: section.querySelector('.fact-full-toggle'),
        bodyEl: section.querySelector('.fact-body')
      }
    };

  }



  function renderExtraMatches(events) {

    var container = document.getElementById('fact-extra-matches');

    if (!container) return;

    container.innerHTML = '';

    if (!events || !events.length) {
      container.hidden = true;
      return;
    }

    events.forEach(function (ev) {
      var card = buildExtraFactCard();
      renderFactCard(card.refs, ev);
      container.appendChild(card.root);
    });

    container.hidden = false;

  }



  function appendRelatedSection(container, title, items, renderItem) {

    if (!items || !items.length) return;

    var section = document.createElement('section');

    section.className = 'fact-related-section';

    var heading = document.createElement('h3');

    heading.textContent = title;

    section.appendChild(heading);

    var list = document.createElement('ul');

    items.forEach(function (item) {

      var li = document.createElement('li');

      renderItem(li, item);

      list.appendChild(li);

    });

    section.appendChild(list);

    container.appendChild(section);

  }



  function factRelatedMediaItems(ev) {

    return (ev._media_items || []).slice();

  }



  function appendRelatedItemsInto(wrap, sources, media, tags) {

    appendRelatedSection(wrap, 'Источники', sources, function (li, source) {

      if (source.url) {

        var a = document.createElement('a');

        a.href = source.url;

        a.target = '_blank';

        a.rel = 'noopener';

        a.textContent = source.title || source.url;

        li.appendChild(a);

      } else {

        li.textContent = source.title || source.id;

      }

      if (source.type) {

        li.appendChild(document.createTextNode(' · ' + source.type));

      }

      if (source.evidence_quote) {

        var quote = document.createElement('blockquote');

        quote.className = 'fact-evidence-quote';

        quote.textContent = source.evidence_quote;

        li.appendChild(quote);

      }

    });

    appendRelatedSection(wrap, 'Медиа', media, function (li, item) {

      var label = item.caption || item.url || item.id;

      if (item.url) {

        var a = document.createElement('a');

        a.href = item.url;

        a.target = '_blank';

        a.rel = 'noopener';

        a.textContent = label;

        li.appendChild(a);

      } else {

        li.textContent = label;

      }

      if (item.type) {

        li.appendChild(document.createTextNode(' · ' + item.type));

      }

    });

    appendRelatedSection(wrap, 'Теги', tags, function (li, tag) {

      var badge = document.createElement('span');

      badge.className = 'fact-tag';

      badge.textContent = tag.name || tag.slug || tag.id;

      li.appendChild(badge);

    });

  }



  function renderFactRelated(bodyEl, ev) {

    var sources = ev._sources || [];

    var media = factRelatedMediaItems(ev);

    var tags = ev._tag_items || [];

    if (!sources.length && !media.length && !tags.length) return;

    var wrap = document.createElement('div');

    wrap.className = 'fact-related';

    appendRelatedItemsInto(wrap, sources, media, tags);

    bodyEl.appendChild(wrap);

  }



  function renderAttachedMembers(refs, ev) {

    var oldAttached = refs.bodyEl.querySelectorAll('.fact-attached');

    for (var i = 0; i < oldAttached.length; i++) {

      oldAttached[i].remove();

    }

    var members = ev._attached_events || [];

    if (!members.length) return;

    members.forEach(function (member) {

      var headline = (member.headline || '').trim();

      var summary = (member.summary || '').trim();

      var text = (member.text || '').trim();

      var hasMemberMedia = Boolean(member.media && member.media.url);

      if (summary) {

        refs.summaryBlockEl.hidden = false;

        var summaryItem = document.createElement('div');

        summaryItem.className = 'fact-attached fact-attached-summary';

        var summaryHeading = document.createElement('h4');

        summaryHeading.className = 'fact-attached-heading';

        summaryHeading.textContent = headline;

        var summaryPara = document.createElement('p');

        summaryPara.textContent = summary;

        summaryItem.appendChild(summaryHeading);

        summaryItem.appendChild(summaryPara);

        refs.summaryBlockEl.appendChild(summaryItem);

      }

      if (text || hasMemberMedia) {

        refs.fullEl.hidden = false;

        var fullItem = document.createElement('div');

        fullItem.className = 'fact-attached fact-attached-full';

        var fullHeading = document.createElement('h4');

        fullHeading.className = 'fact-attached-heading';

        fullHeading.textContent = headline;

        fullItem.appendChild(fullHeading);

        if (text) {

          var fullPara = document.createElement('p');

          fullPara.textContent = text;

          fullItem.appendChild(fullPara);

        }

        if (hasMemberMedia) {

          var mediaWrap = document.createElement('div');

          mediaWrap.className = 'fact-full-media';

          renderFactMedia(mediaWrap, member);

          fullItem.appendChild(mediaWrap);

        }

        refs.fullEl.appendChild(fullItem);

      }

      var memberSources = member.source_items || [];

      var memberMedia = member.media_items || [];

      var memberTags = member.tag_items || [];

      if (memberSources.length || memberMedia.length || memberTags.length) {

        var relatedWrap = document.createElement('div');

        relatedWrap.className = 'fact-attached fact-related fact-attached-related';

        var relatedHeading = document.createElement('h4');

        relatedHeading.className = 'fact-attached-heading';

        relatedHeading.textContent = headline;

        relatedWrap.appendChild(relatedHeading);

        appendRelatedItemsInto(relatedWrap, memberSources, memberMedia, memberTags);

        refs.bodyEl.appendChild(relatedWrap);

      }

    });

  }



  function goToEvent(timeline, ev) {

    if (!timeline || !ev || !ev.unique_id) return false;

    if (typeof timeline.goToId === 'function') {

      timeline.goToId(ev.unique_id);

      return true;

    }

    return false;

  }



  function normalizeEvents(list) {

    return list.map(function (ev, index) {

      var copy = JSON.parse(JSON.stringify(ev));

      if (!copy.unique_id) {

        copy.unique_id = 'ev-' + String(index + 1).padStart(4, '0');

      }

      return copy;

    });

  }



  function buildById(events) {

    var byId = {};

    events.forEach(function (ev) {

      if (ev.unique_id) {

        byId[ev.unique_id] = ev;

      }

    });

    return byId;

  }



  async function loadTimelineEvents(url) {

    var r = await fetch(url, { cache: 'no-store' });

    if (!r.ok) throw new Error('Не удалось загрузить ' + url);

    var data = await r.json();

    return normalizeEvents(data.events || []).sort(function (a, b) {

      return eventToDate(a) - eventToDate(b);

    });

  }



  function applyBounds(input, events) {

    if (!events.length) return;

    var min = eventToDate(events[0]);

    var max = eventToDate(events[events.length - 1]);

    input.min = dateToInputValue(min);

    input.max = dateToInputValue(max);

  }



  function initDateSearch(timeline, timelineJsonUrl) {

    var form = document.getElementById('date-search-form');

    var input = document.getElementById('date-search-input');

    if (!form || !input) return;



    var events = [];

    var byId = {};

    var userHasSearched = false;

    var selectionBound = false;

    var domClickBound = false;



    input.value = '';

    setStatus(DEFAULT_STATUS, null);



    function eventIdFromData(data) {

      if (!data) return null;

      if (typeof data === 'string') return data;

      return data.unique_id || data.current_id || null;

    }



    function selectEvent(ev, options) {

      options = options || {};

      if (!ev) return;



      updateFactPanel(ev);

      renderExtraMatches([]);

      input.value = dateToInputValue(eventToDate(ev));



      if (options.fromMarkerClick) {

        setStatus('Выбрано: ' + ((ev.text && ev.text.headline) || ev.unique_id), 'is-success');

      } else if (!userHasSearched) {

        setStatus(DEFAULT_STATUS, null);

      }



      if (options.moveTimeline && timeline) {

        goToEvent(timeline, ev);

      }

    }



    function selectEventById(id, options) {

      if (!id) return;

      var ev = byId[id];

      if (ev) {

        selectEvent(ev, options);

      }

    }



    function onTimelineSelection(data) {

      var id = eventIdFromData(data);

      if (id) {

        selectEventById(id, { moveTimeline: false });

      }

    }



    function bindTimelineSelection() {

      if (!timeline || typeof timeline.on !== 'function') return;



      if (!selectionBound) {

        selectionBound = true;

        timeline.on('change', onTimelineSelection);

        timeline.on('markerclick', onTimelineSelection);

      }

    }



    function bindMarkerDomClicks() {

      var embed = document.getElementById('timelinejs-embed');

      if (!embed || domClickBound) return;

      domClickBound = true;



      embed.addEventListener('click', function (e) {

        var marker = e.target.closest('.tl-timemarker');

        if (!marker) return;



        var id = null;

        if (marker.id && marker.id.endsWith('-marker')) {

          id = marker.id.slice(0, -7);

        }



        if (id && byId[id]) {

          selectEventById(id, { moveTimeline: false, fromMarkerClick: true });

          if (timeline && typeof timeline.goToId === 'function') {

            timeline.goToId(id);

          }

          return;

        }



        var headlineEl = marker.querySelector('.tl-headline');

        var headline = headlineEl && headlineEl.textContent

          ? headlineEl.textContent.trim()

          : '';

        if (headline) {

          for (var i = 0; i < events.length; i++) {

            var h = events[i].text && events[i].text.headline;

            if (h && h.trim() === headline) {

              selectEvent(events[i], { moveTimeline: false, fromMarkerClick: true });

              if (timeline && events[i].unique_id) {

                timeline.goToId(events[i].unique_id);

              }

              break;

            }

          }

        }

      });

    }



    function rebuildIndex(list) {

      events = list;

      byId = buildById(events);

      window.__timelineEvents = events;

      applyBounds(input, events);

    }



    loadTimelineEvents(timelineJsonUrl)

      .then(function (list) {

        rebuildIndex(list);

        bindTimelineSelection();

        bindMarkerDomClicks();

      })

      .catch(function (err) {

        console.warn(err);

        setStatus('Не удалось загрузить события для поиска по дате.', 'is-error');

      });



    function searchByDate(targetDate) {

      if (!events.length) {

        setStatus('Список событий ещё не загружен.', 'is-error');

        return;

      }



      var result = findBestEvent(events, targetDate);

      var ev = result.exact || result.closest;

      var extraMatches = result.exactMatches.length > 1 ? result.exactMatches.slice(1) : [];



      if (!ev) {

        updateFactPanel(null);

        renderExtraMatches([]);

        setStatus('События не найдены.', 'is-error');

        return;

      }



      if (!timeline) {

        setStatus('Таймлайн не готов.', 'is-error');

        selectEvent(ev, { moveTimeline: false });

        renderExtraMatches(extraMatches);

        return;

      }



      goToEvent(timeline, ev);

      selectEvent(ev, { moveTimeline: false });

      renderExtraMatches(extraMatches);



      if (result.exactMatches.length) {

        setStatus(exactMatchStatus(result.exactMatches.length), 'is-success');

      } else {

        var days = daysBetween(eventToDate(ev), targetDate);

        setStatus(

          'Точного совпадения нет. Показано ближайшее событие (±' + days + ' дн.).',

          'is-success'

        );

      }

    }



    form.addEventListener('submit', function (e) {

      e.preventDefault();

      if (!input.value) {

        setStatus('Укажите дату.', 'is-error');

        return;

      }

      userHasSearched = true;

      var parts = input.value.split('-').map(Number);

      searchByDate(new Date(parts[0], parts[1] - 1, parts[2]));

    });



    bindTimelineSelection();

    bindMarkerDomClicks();



    if (timeline && typeof timeline.on === 'function') {

      timeline.on('loaded', function () {

        bindTimelineSelection();

        bindMarkerDomClicks();

      });

    }



    setTimeout(function () {

      bindTimelineSelection();

      bindMarkerDomClicks();

    }, 100);

    setTimeout(function () {

      bindTimelineSelection();

      bindMarkerDomClicks();

    }, 500);

  }



  window.initDateSearch = initDateSearch;

})();


