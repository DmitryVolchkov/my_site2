/**
 * Панель администрирования (SQLite API + серверная авторизация).
 */
(function () {
  var API_EVENTS_URL = '/api/events';
  var API_USERS_URL = '/api/users';
  var API_SOURCES_URL = '/api/sources';
  var API_MEDIA_URL = '/api/media';
  var API_MEDIA_UPLOAD_URL = '/api/media/upload';
  var API_TAGS_URL = '/api/tags';
  var API_GROUPS_URL = '/api/groups';
  var API_AUTH_SESSION_URL = '/api/auth/session';
  var API_AUTH_LOGIN_URL = '/api/auth/login';
  var API_AUTH_LOGOUT_URL = '/api/auth/logout';
  var API_DB_SCHEMA_URL = '/api/db/schema';
  var API_AUDIT_URL = '/api/audit';
  var MAX_IMAGE_BYTES = 800000;

  var CSV_HEADERS = [
    'id', 'hashtag', 'start_year', 'start_month', 'start_day',
    'end_year', 'end_month', 'end_day', 'start_date_precision', 'end_date_precision',
    'start_date_approximate', 'end_date_approximate',
    'headline', 'summary', 'text', 'media_url', 'media_caption', 'media_credit',
    'group', 'tags', 'importance', 'status', 'verification_status',
    'event_type', 'scale', 'domain', 'category', 'subcategory',
    'country_name', 'region', 'city', 'related_events'
  ];

  var state = {
    events: [],
    users: [],
    sources: [],
    media: [],
    tags: [],
    groups: [],
    audit: [],
    dbSchema: null,
    currentUser: null,
    editingEventId: null,
    editingUserId: null,
    editingSourceId: null,
    editingMediaId: null,
    editingTagId: null,
    editingGroupId: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(el, text, type) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'admin-status' + (type ? ' is-' + type : '');
  }

  function csvEscape(val) {
    var s = val == null ? '' : String(val);
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function eventsToCsv(events) {
    var lines = [CSV_HEADERS.join(',')];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      lines.push(CSV_HEADERS.map(function (h) {
        return csvEscape(e[h] != null ? e[h] : '');
      }).join(','));
    }
    return lines.join('\n');
  }

  function nextEventId() {
    var max = 0;
    state.events.forEach(function (e) {
      var m = (e.id || '').match(/ev-(\d+)/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'ev-' + String(max + 1).padStart(4, '0');
  }

  /** Уникальный id для нового события */
  function allocateEventId() {
    var id = nextEventId();
    var guard = 0;
    while (state.events.some(function (e) { return e.id === id; }) && guard < 10000) {
      var m = id.match(/ev-(\d+)/i);
      var n = m ? parseInt(m[1], 10) + 1 : 1;
      id = 'ev-' + String(n).padStart(4, '0');
      guard++;
    }
    return id;
  }

  function setEventIdField(value) {
    var el = $('event-id');
    if (!el) return;
    el.value = value;
    el.readOnly = true;
  }

  function nextUserId() {
    var max = 0;
    state.users.forEach(function (u) {
      var m = (u.id || '').match(/usr-(\d+)/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'usr-' + String(max + 1).padStart(3, '0');
  }

  function nextReferenceId(kind) {
    var prefixes = { sources: 'src', media: 'med', tags: 'tag', groups: 'grp' };
    var list = state[kind] || [];
    var prefix = prefixes[kind] || 'ref';
    var max = 0;
    list.forEach(function (item) {
      var m = (item.id || '').match(new RegExp('^' + prefix + '-(\\d+)$', 'i'));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return prefix + '-' + String(max + 1).padStart(4, '0');
  }

  function currentUser() {
    return state.currentUser;
  }

  function canEdit() {
    var u = currentUser();
    return u && u.active && (u.role === 'admin' || u.role === 'editor');
  }

  function canManageUsers() {
    var u = currentUser();
    return u && u.active && u.role === 'admin';
  }

  async function loadEventsFromServer() {
    var r = await fetch(API_EVENTS_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('Не удалось загрузить события из БД.');
    var data = await r.json();
    return data.events || [];
  }

  async function saveEventToServer(event) {
    var r = await fetch(API_EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || 'Не удалось сохранить событие.');
    return data.event || event;
  }

  async function deleteEventFromServer(id) {
    var r = await fetch(API_EVENTS_URL + '/' + encodeURIComponent(id), { method: 'DELETE' });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || 'Не удалось удалить событие.');
  }

  async function loadSessionFromServer() {
    var r = await fetch(API_AUTH_SESSION_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('Не удалось проверить сессию.');
    var data = await r.json();
    return data.user || null;
  }

  async function loginOnServer(email, password) {
    var r = await fetch(API_AUTH_LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: email, password: password })
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      throw new Error(data.error || ('Ошибка входа: HTTP ' + r.status + '. Проверьте, что страница открыта через http://127.0.0.1:8000/admin.html'));
    }
    return data.user || null;
  }

  async function logoutOnServer() {
    await fetch(API_AUTH_LOGOUT_URL, { method: 'POST' });
  }

  async function loadUsersFromServer() {
    var r = await fetch(API_USERS_URL, { cache: 'no-store' });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || 'Не удалось загрузить пользователей.');
    return data.users || [];
  }

  async function saveUserToServer(user) {
    var r = await fetch(API_USERS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user)
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || 'Не удалось сохранить пользователя.');
    return data.user || user;
  }

  async function deleteUserFromServer(id) {
    var r = await fetch(API_USERS_URL + '/' + encodeURIComponent(id), { method: 'DELETE' });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || 'Не удалось удалить пользователя.');
  }

  async function loadReferenceFromServer(kind) {
    var urls = { sources: API_SOURCES_URL, media: API_MEDIA_URL, tags: API_TAGS_URL, groups: API_GROUPS_URL };
    var labels = { sources: 'источники', media: 'медиа', tags: 'теги', groups: 'группы' };
    var r;
    try {
      r = await fetch(urls[kind], { cache: 'no-store', credentials: 'same-origin' });
    } catch (err) {
      throw new Error('Не удалось загрузить справочник «' + (labels[kind] || kind) + '». Перезапустите: python server.py');
    }
    var data = await r.json().catch(function () { return {}; });
    if (r.status === 404) {
      throw new Error('Справочник «' + (labels[kind] || kind) + '» недоступен (HTTP 404). Перезапустите server.py — работает старая версия сервера.');
    }
    if (!r.ok) throw new Error(data.error || ('Не удалось загрузить справочник «' + (labels[kind] || kind) + '».'));
    return data[kind] || [];
  }

  async function saveReferenceToServer(kind, item) {
    var urls = { sources: API_SOURCES_URL, media: API_MEDIA_URL, tags: API_TAGS_URL, groups: API_GROUPS_URL };
    var r = await fetch(urls[kind], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || 'Не удалось сохранить справочник.');
    return data.item || item;
  }

  async function deleteReferenceFromServer(kind, id) {
    var urls = { sources: API_SOURCES_URL, media: API_MEDIA_URL, tags: API_TAGS_URL, groups: API_GROUPS_URL };
    var r = await fetch(urls[kind] + '/' + encodeURIComponent(id), { method: 'DELETE' });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || 'Не удалось удалить запись.');
  }

  async function loadDbSchema() {
    var r = await fetch(API_DB_SCHEMA_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('Не удалось загрузить структуру БД.');
    return r.json();
  }

  async function loadAuditFromServer() {
    var r = await fetch(API_AUDIT_URL, { cache: 'no-store' });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      if (r.status === 404) {
        throw new Error('Аудит недоступен (HTTP 404). Перезапустите server.py — вероятно, работает старая версия сервера.');
      }
      throw new Error(data.error || ('Не удалось загрузить аудит: HTTP ' + r.status));
    }
    return data.audit || [];
  }

  async function initData() {
    state.events = await loadEventsFromServer();

    if (canManageUsers()) {
      state.users = await loadUsersFromServer();
      try {
        state.audit = await loadAuditFromServer();
      } catch (err) {
        state.audit = [];
        console.warn(err);
      }
    } else {
      state.users = state.currentUser ? [state.currentUser] : [];
      state.audit = [];
    }

    if (canEdit()) {
      state.sources = await loadReferenceFromServer('sources');
      state.media = await loadReferenceFromServer('media');
      state.tags = await loadReferenceFromServer('tags');
      state.groups = await loadReferenceFromServer('groups');
    }
  }

  function showApp(show) {
    $('admin-login').hidden = !!show;
    $('admin-app').hidden = !show;
    var logout = $('btn-logout');
    if (logout) logout.hidden = !show;
  }

  function switchTab(tabId) {
    document.querySelectorAll('.admin-tab').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.admin-panel').forEach(function (panel) {
      panel.classList.toggle('is-active', panel.id === 'panel-' + tabId);
    });
  }

  function formatEventDate(ev) {
    var p = [ev.start_day, ev.start_month, ev.start_year].filter(Boolean);
    if (ev.end_year) {
      p.push('—');
      if (ev.end_day) p.push(ev.end_day);
      if (ev.end_month) p.push(ev.end_month);
      p.push(ev.end_year);
    }
    return p.join('.').replace(/\.\—\./, ' — ');
  }

  function selectedValues(select) {
    if (!select) return [];
    return Array.prototype.slice.call(select.selectedOptions).map(function (option) {
      return option.value;
    });
  }

  function setSelectedValues(select, values) {
    if (!select) return;
    var selected = {};
    (values || []).forEach(function (value) {
      selected[value] = true;
    });
    Array.prototype.slice.call(select.options).forEach(function (option) {
      option.selected = !!selected[option.value];
    });
  }

  function renderOptions(selectId, list, labelFn) {
    var select = $(selectId);
    if (!select) return;
    var previous = selectedValues(select);
    select.innerHTML = '';
    list.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.id;
      option.textContent = labelFn(item);
      select.appendChild(option);
    });
    setSelectedValues(select, previous);
  }

  var EVENT_MODAL_IDS = [
    'event-media-folder-modal',
    'event-media-db-modal',
    'event-source-new-modal',
    'event-source-db-modal',
    'event-tag-new-modal',
    'event-tag-db-modal',
    'event-group-new-modal',
    'event-group-db-modal',
    'event-preview-modal'
  ];

  function syncEventModalBodyClass() {
    var open = EVENT_MODAL_IDS.some(function (id) {
      var el = $(id);
      return el && !el.hidden;
    });
    document.body.classList.toggle('admin-modal-open', open);
  }

  function toggleAddMenu(menuId, btnId, show) {
    var menu = $(menuId);
    var btn = $(btnId);
    if (!menu || !btn) return;
    var open = typeof show === 'boolean' ? show : menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeAllAddMenus() {
    toggleAddMenu('event-media-add-menu', 'btn-event-media-add', false);
    toggleAddMenu('event-source-add-menu', 'btn-event-source-add', false);
    toggleAddMenu('event-tag-add-menu', 'btn-event-tag-add', false);
    toggleAddMenu('event-group-add-menu', 'btn-event-group-add', false);
  }

  function defaultGroupIds() {
    var history = state.groups.find(function (g) {
      return g.id === 'grp-0001' || (g.name || '').trim() === 'История';
    });
    return history ? [history.id] : [];
  }

  function resolveEventGroupIds(ev) {
    if (ev.group_ids && ev.group_ids.length) return ev.group_ids.slice();
    var groupText = (ev.group || '').trim();
    if (!groupText) return defaultGroupIds();
    var match = state.groups.find(function (g) {
      return (g.name || '').trim() === groupText || (g.slug || '').trim() === groupText;
    });
    return match ? [match.id] : [];
  }

  function buildEventGroupString() {
    var ids = selectedValues($('event-group-ids'));
    if (!ids.length) return '';
    var item = state.groups.find(function (x) { return x.id === ids[0]; });
    return item ? (item.name || item.slug || item.id) : '';
  }

  function buildEventTagsString() {
    return selectedValues($('event-tag-ids')).map(function (id) {
      var tag = state.tags.find(function (x) { return x.id === id; });
      return tag ? (tag.name || tag.slug || tag.id) : '';
    }).filter(Boolean).join(';');
  }

  function isImageMediaUrl(url) {
    if (!url) return false;
    if (url.indexOf('data:image/') === 0) return true;
    return /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(url);
  }

  function clearPrimaryEventMedia() {
    $('event-media-url').value = '';
    $('event-media-caption').value = '';
    $('event-media-credit').value = '';
    renderEventMediaList();
  }

  function addEventMediaIds(ids) {
    var select = $('event-media-ids');
    if (!select) return;
    var current = selectedValues(select);
    var merged = {};
    current.concat(ids || []).forEach(function (id) {
      merged[id] = true;
    });
    setSelectedValues(select, Object.keys(merged));
    renderEventMediaList();
  }

  function removeEventMediaId(id) {
    var select = $('event-media-ids');
    if (!select) return;
    setSelectedValues(select, selectedValues(select).filter(function (value) {
      return value !== id;
    }));
    renderEventMediaList();
  }

  function createEventRefListItem(options) {
    var li = document.createElement('li');
    li.className = 'admin-media-item';

    var thumb;
    if (options.previewUrl && isImageMediaUrl(options.previewUrl)) {
      thumb = document.createElement('img');
      thumb.className = 'admin-media-item-thumb';
      thumb.src = options.previewUrl;
      thumb.alt = '';
    } else {
      thumb = document.createElement('div');
      thumb.className = 'admin-media-item-thumb is-file';
      thumb.textContent = options.thumbLabel || (options.kind === 'folder' ? 'Файл' : 'База');
    }

    var body = document.createElement('div');
    var title = document.createElement('div');
    title.className = 'admin-media-item-title';
    title.textContent = options.label || '—';
    var meta = document.createElement('div');
    meta.className = 'admin-media-item-meta';
    meta.textContent = options.meta || '';
    var badge = document.createElement('span');
    badge.className = 'admin-media-item-badge';
    badge.textContent = options.kind === 'folder' ? 'Папка' : 'База';
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(badge);

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'admin-btn admin-btn-danger';
    removeBtn.textContent = 'Убрать';
    removeBtn.addEventListener('click', options.onRemove);

    li.appendChild(thumb);
    li.appendChild(body);
    li.appendChild(removeBtn);
    return li;
  }

  function renderEventMediaList() {
    var list = $('event-media-list');
    if (!list) return;
    list.innerHTML = '';

    var url = ($('event-media-url').value || '').trim();
    if (url) {
      list.appendChild(createEventRefListItem({
        kind: 'folder',
        label: ($('event-media-caption').value || '').trim() || 'Файл из папки',
        meta: url,
        previewUrl: url,
        onRemove: clearPrimaryEventMedia
      }));
    }

    selectedValues($('event-media-ids')).forEach(function (id) {
      var item = state.media.find(function (x) { return x.id === id; });
      if (!item) return;
      list.appendChild(createEventRefListItem({
        kind: 'db',
        label: item.caption || item.url || item.id,
        meta: item.url || item.id,
        previewUrl: item.url || '',
        onRemove: function () {
          removeEventMediaId(id);
        }
      }));
    });
  }

  function addEventRefIds(selectId, renderList, ids) {
    var select = $(selectId);
    if (!select) return;
    var current = selectedValues(select);
    var merged = {};
    current.concat(ids || []).forEach(function (id) {
      merged[id] = true;
    });
    setSelectedValues(select, Object.keys(merged));
    renderList();
  }

  function removeEventRefId(selectId, renderList, id) {
    var select = $(selectId);
    if (!select) return;
    setSelectedValues(select, selectedValues(select).filter(function (value) {
      return value !== id;
    }));
    renderList();
  }

  function addEventSourceIds(ids) {
    addEventRefIds('event-source-ids', renderEventSourceList, ids);
  }

  function removeEventSourceId(id) {
    removeEventRefId('event-source-ids', renderEventSourceList, id);
  }

  function renderEventSourceList() {
    var list = $('event-source-list');
    if (!list) return;
    list.innerHTML = '';
    selectedValues($('event-source-ids')).forEach(function (id) {
      var item = state.sources.find(function (x) { return x.id === id; });
      if (!item) return;
      var meta = [item.url, item.type].filter(Boolean).join(' · ') || item.id;
      list.appendChild(createEventRefListItem({
        kind: 'db',
        thumbLabel: 'ИС',
        label: item.title || item.id,
        meta: meta,
        onRemove: function () {
          removeEventSourceId(id);
        }
      }));
    });
  }

  function addEventTagIds(ids) {
    addEventRefIds('event-tag-ids', renderEventTagList, ids);
  }

  function removeEventTagId(id) {
    removeEventRefId('event-tag-ids', renderEventTagList, id);
  }

  function renderEventTagList() {
    var list = $('event-tag-list');
    if (!list) return;
    list.innerHTML = '';
    selectedValues($('event-tag-ids')).forEach(function (id) {
      var item = state.tags.find(function (x) { return x.id === id; });
      if (!item) return;
      list.appendChild(createEventRefListItem({
        kind: 'db',
        thumbLabel: '#',
        label: item.name || item.id,
        meta: item.slug || item.id,
        onRemove: function () {
          removeEventTagId(id);
        }
      }));
    });
  }

  function addEventGroupIds(ids) {
    addEventRefIds('event-group-ids', renderEventGroupList, ids);
  }

  function removeEventGroupId(id) {
    removeEventRefId('event-group-ids', renderEventGroupList, id);
  }

  function renderEventGroupList() {
    var list = $('event-group-list');
    if (!list) return;
    list.innerHTML = '';
    selectedValues($('event-group-ids')).forEach(function (id) {
      var item = state.groups.find(function (x) { return x.id === id; });
      if (!item) return;
      list.appendChild(createEventRefListItem({
        kind: 'db',
        thumbLabel: 'ГР',
        label: item.name || item.id,
        meta: item.slug || item.id,
        onRemove: function () {
          removeEventGroupId(id);
        }
      }));
    });
  }

  function openMediaFolderModal() {
    var modal = $('event-media-folder-modal');
    if (!modal) return;
    $('event-media-folder-file').value = '';
    $('event-media-folder-caption').value = '';
    $('event-media-folder-credit').value = '';
    $('event-media-folder-to-catalog').checked = true;
    setStatus($('event-media-folder-status'), '', '');
    updateFolderMediaPreview('');
    modal.hidden = false;
    syncEventModalBodyClass();
  }

  function closeMediaFolderModal() {
    var modal = $('event-media-folder-modal');
    if (!modal) return;
    modal.hidden = true;
    syncEventModalBodyClass();
  }

  function openMediaDbModal() {
    var modal = $('event-media-db-modal');
    if (!modal) return;
    $('event-media-db-search').value = '';
    setStatus($('event-media-db-status'), '', '');
    renderMediaDbPicker('');
    modal.hidden = false;
    syncEventModalBodyClass();
  }

  function closeMediaDbModal() {
    var modal = $('event-media-db-modal');
    if (!modal) return;
    modal.hidden = true;
    syncEventModalBodyClass();
  }

  function openSourceNewModal() {
    var modal = $('event-source-new-modal');
    if (!modal) return;
    $('event-source-new-title').value = '';
    $('event-source-new-url').value = '';
    $('event-source-new-type').value = '';
    $('event-source-new-evidence').value = '';
    setStatus($('event-source-new-status'), '', '');
    modal.hidden = false;
    syncEventModalBodyClass();
  }

  function closeSourceNewModal() {
    var modal = $('event-source-new-modal');
    if (!modal) return;
    modal.hidden = true;
    syncEventModalBodyClass();
  }

  function openSourceDbModal() {
    var modal = $('event-source-db-modal');
    if (!modal) return;
    $('event-source-db-search').value = '';
    setStatus($('event-source-db-status'), '', '');
    renderSourceDbPicker('');
    modal.hidden = false;
    syncEventModalBodyClass();
  }

  function closeSourceDbModal() {
    var modal = $('event-source-db-modal');
    if (!modal) return;
    modal.hidden = true;
    syncEventModalBodyClass();
  }

  function openTagNewModal() {
    var modal = $('event-tag-new-modal');
    if (!modal) return;
    $('event-tag-new-name').value = '';
    $('event-tag-new-slug').value = '';
    setStatus($('event-tag-new-status'), '', '');
    modal.hidden = false;
    syncEventModalBodyClass();
  }

  function closeTagNewModal() {
    var modal = $('event-tag-new-modal');
    if (!modal) return;
    modal.hidden = true;
    syncEventModalBodyClass();
  }

  function openTagDbModal() {
    var modal = $('event-tag-db-modal');
    if (!modal) return;
    $('event-tag-db-search').value = '';
    setStatus($('event-tag-db-status'), '', '');
    renderTagDbPicker('');
    modal.hidden = false;
    syncEventModalBodyClass();
  }

  function closeTagDbModal() {
    var modal = $('event-tag-db-modal');
    if (!modal) return;
    modal.hidden = true;
    syncEventModalBodyClass();
  }

  function openGroupNewModal() {
    var modal = $('event-group-new-modal');
    if (!modal) return;
    $('event-group-new-name').value = '';
    $('event-group-new-slug').value = '';
    setStatus($('event-group-new-status'), '', '');
    modal.hidden = false;
    syncEventModalBodyClass();
  }

  function closeGroupNewModal() {
    var modal = $('event-group-new-modal');
    if (!modal) return;
    modal.hidden = true;
    syncEventModalBodyClass();
  }

  function openGroupDbModal() {
    var modal = $('event-group-db-modal');
    if (!modal) return;
    $('event-group-db-search').value = '';
    setStatus($('event-group-db-status'), '', '');
    renderGroupDbPicker('');
    modal.hidden = false;
    syncEventModalBodyClass();
  }

  function closeGroupDbModal() {
    var modal = $('event-group-db-modal');
    if (!modal) return;
    modal.hidden = true;
    syncEventModalBodyClass();
  }

  function updateFolderMediaPreview(url) {
    var wrap = $('event-media-folder-preview');
    var img = $('event-media-folder-preview-img');
    if (!wrap || !img) return;
    if (url && isImageMediaUrl(url)) {
      img.src = url;
      wrap.classList.remove('empty');
      wrap.hidden = false;
    } else {
      img.removeAttribute('src');
      wrap.classList.add('empty');
      wrap.hidden = true;
    }
  }

  function renderMediaDbPicker(query) {
    var container = $('event-media-db-list');
    if (!container) return;
    var selected = {};
    selectedValues($('event-media-ids')).forEach(function (id) {
      selected[id] = true;
    });
    var q = (query || '').trim().toLowerCase();
    container.innerHTML = '';
    var items = state.media.filter(function (item) {
      if (selected[item.id]) return false;
      var haystack = ((item.caption || '') + ' ' + (item.url || '') + ' ' + (item.type || '') + ' ' + item.id).toLowerCase();
      return !q || haystack.indexOf(q) !== -1;
    });
    if (!items.length) {
      container.innerHTML = '<p class="admin-hint" style="padding:12px;">Нет доступных записей.</p>';
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'admin-media-db-option';
      var id = 'event-media-db-' + item.id;
      row.innerHTML =
        '<input type="checkbox" id="' + escapeAttr(id) + '" value="' + escapeAttr(item.id) + '">' +
        '<label for="' + escapeAttr(id) + '">' +
        '<strong>' + escapeHtml(item.caption || item.url || item.id) + '</strong>' +
        '<span>' + escapeHtml(item.url || '') + '</span>' +
        '</label>';
      container.appendChild(row);
    });
  }

  function renderSourceDbPicker(query) {
    var container = $('event-source-db-list');
    if (!container) return;
    var selected = {};
    selectedValues($('event-source-ids')).forEach(function (id) {
      selected[id] = true;
    });
    var q = (query || '').trim().toLowerCase();
    container.innerHTML = '';
    var items = state.sources.filter(function (item) {
      if (selected[item.id]) return false;
      var haystack = ((item.title || '') + ' ' + (item.url || '') + ' ' + (item.type || '') + ' ' + item.id).toLowerCase();
      return !q || haystack.indexOf(q) !== -1;
    });
    if (!items.length) {
      container.innerHTML = '<p class="admin-hint" style="padding:12px;">Нет доступных записей.</p>';
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'admin-media-db-option';
      var id = 'event-source-db-' + item.id;
      row.innerHTML =
        '<input type="checkbox" id="' + escapeAttr(id) + '" value="' + escapeAttr(item.id) + '">' +
        '<label for="' + escapeAttr(id) + '">' +
        '<strong>' + escapeHtml(item.title || item.id) + '</strong>' +
        '<span>' + escapeHtml(item.url || item.type || '') + '</span>' +
        '</label>';
      container.appendChild(row);
    });
  }

  function renderTagDbPicker(query) {
    var container = $('event-tag-db-list');
    if (!container) return;
    var selected = {};
    selectedValues($('event-tag-ids')).forEach(function (id) {
      selected[id] = true;
    });
    var q = (query || '').trim().toLowerCase();
    container.innerHTML = '';
    var items = state.tags.filter(function (item) {
      if (selected[item.id]) return false;
      var haystack = ((item.name || '') + ' ' + (item.slug || '') + ' ' + item.id).toLowerCase();
      return !q || haystack.indexOf(q) !== -1;
    });
    if (!items.length) {
      container.innerHTML = '<p class="admin-hint" style="padding:12px;">Нет доступных записей.</p>';
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'admin-media-db-option';
      var id = 'event-tag-db-' + item.id;
      row.innerHTML =
        '<input type="checkbox" id="' + escapeAttr(id) + '" value="' + escapeAttr(item.id) + '">' +
        '<label for="' + escapeAttr(id) + '">' +
        '<strong>' + escapeHtml(item.name || item.id) + '</strong>' +
        '<span>' + escapeHtml(item.slug || '') + '</span>' +
        '</label>';
      container.appendChild(row);
    });
  }

  function renderGroupDbPicker(query) {
    var container = $('event-group-db-list');
    if (!container) return;
    var selected = {};
    selectedValues($('event-group-ids')).forEach(function (id) {
      selected[id] = true;
    });
    var q = (query || '').trim().toLowerCase();
    container.innerHTML = '';
    var items = state.groups.filter(function (item) {
      if (selected[item.id]) return false;
      var haystack = ((item.name || '') + ' ' + (item.slug || '') + ' ' + item.id).toLowerCase();
      return !q || haystack.indexOf(q) !== -1;
    });
    if (!items.length) {
      container.innerHTML = '<p class="admin-hint" style="padding:12px;">Нет доступных записей.</p>';
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'admin-media-db-option';
      var id = 'event-group-db-' + item.id;
      row.innerHTML =
        '<input type="checkbox" id="' + escapeAttr(id) + '" value="' + escapeAttr(item.id) + '">' +
        '<label for="' + escapeAttr(id) + '">' +
        '<strong>' + escapeHtml(item.name || item.id) + '</strong>' +
        '<span>' + escapeHtml(item.slug || '') + '</span>' +
        '</label>';
      container.appendChild(row);
    });
  }

  async function uploadMediaFile(file) {
    if (window.location.protocol === 'file:') {
      throw new Error('Откройте админку через http://127.0.0.1:8000/admin.html — при открытии файла с диска загрузка не работает.');
    }
    var formData = new FormData();
    formData.append('file', file);
    var r;
    try {
      r = await fetch(API_MEDIA_UPLOAD_URL, {
        method: 'POST',
        credentials: 'same-origin',
        body: formData
      });
    } catch (err) {
      throw new Error('Не удалось связаться с сервером (Failed to fetch). Перезапустите: python server.py');
    }
    var data = await r.json().catch(function () { return {}; });
    if (r.status === 404) {
      throw new Error('Загрузка недоступна (HTTP 404). Перезапустите server.py — работает старая версия сервера.');
    }
    if (r.status === 401) {
      throw new Error('Сессия истекла. Выйдите и войдите в админку снова.');
    }
    if (!r.ok) throw new Error(data.error || ('Не удалось загрузить файл: HTTP ' + r.status));
    return data.item || {};
  }

  function renderEventReferenceOptions() {
    renderOptions('event-source-ids', state.sources, function (item) {
      return item.title || item.id;
    });
    renderOptions('event-media-ids', state.media, function (item) {
      return (item.caption || item.url || item.id);
    });
    renderOptions('event-tag-ids', state.tags, function (item) {
      return item.name || item.id;
    });
    renderOptions('event-group-ids', state.groups, function (item) {
      return item.name || item.id;
    });
    renderEventGroupList();
    renderEventSourceList();
    renderEventMediaList();
    renderEventTagList();
  }

  function bindEventMedia() {
    var addBtn = $('btn-event-media-add');
    var folderBtn = $('btn-event-media-folder');
    var dbBtn = $('btn-event-media-db');
    var folderFile = $('event-media-folder-file');

    addBtn && addBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleAddMenu('event-media-add-menu', 'btn-event-media-add', $('event-media-add-menu').hidden);
    });

    document.addEventListener('click', closeAllAddMenus);

    $('event-media-add-menu') && $('event-media-add-menu').addEventListener('click', function (e) {
      e.stopPropagation();
    });

    folderBtn && folderBtn.addEventListener('click', function () {
      closeAllAddMenus();
      openMediaFolderModal();
    });

    dbBtn && dbBtn.addEventListener('click', function () {
      closeAllAddMenus();
      openMediaDbModal();
    });

    $('btn-event-media-folder-close') && $('btn-event-media-folder-close').addEventListener('click', closeMediaFolderModal);
    $('event-media-folder-backdrop') && $('event-media-folder-backdrop').addEventListener('click', closeMediaFolderModal);
    $('btn-event-media-db-close') && $('btn-event-media-db-close').addEventListener('click', closeMediaDbModal);
    $('event-media-db-backdrop') && $('event-media-db-backdrop').addEventListener('click', closeMediaDbModal);

    folderFile && folderFile.addEventListener('change', function () {
      var file = folderFile.files && folderFile.files[0];
      if (!file) {
        updateFolderMediaPreview('');
        return;
      }
      if (file.type.match(/^image\//)) {
        var reader = new FileReader();
        reader.onload = function () {
          updateFolderMediaPreview(reader.result);
        };
        reader.readAsDataURL(file);
      } else {
        updateFolderMediaPreview('');
      }
      if (!$('event-media-folder-caption').value) {
        $('event-media-folder-caption').value = file.name;
      }
    });

    $('btn-event-media-folder-apply') && $('btn-event-media-folder-apply').addEventListener('click', async function () {
      var status = $('event-media-folder-status');
      var file = folderFile && folderFile.files && folderFile.files[0];
      if (!file) {
        setStatus(status, 'Выберите файл.', 'error');
        return;
      }
      if (!canEdit()) {
        setStatus(status, 'Недостаточно прав.', 'error');
        return;
      }
      try {
        setStatus(status, 'Загрузка файла...', '');
        var uploaded = await uploadMediaFile(file);
        var caption = ($('event-media-folder-caption').value || '').trim();
        var credit = ($('event-media-folder-credit').value || '').trim();
        $('event-media-url').value = uploaded.url || '';
        $('event-media-caption').value = caption;
        $('event-media-credit').value = credit;

        if ($('event-media-folder-to-catalog').checked) {
          var item = {
            id: nextReferenceId('media'),
            url: uploaded.url || '',
            type: uploaded.type || '',
            caption: caption,
            credit: credit,
            license: '',
            alt_text: ''
          };
          item = await saveReferenceToServer('media', item);
          replaceOrAppend(state.media, item.id, item);
          addEventMediaIds([item.id]);
          renderMediaTable();
        } else {
          renderEventMediaList();
        }

        closeMediaFolderModal();
        setStatus($('events-status'), 'Медиа из папки добавлено.', 'ok');
      } catch (err) {
        setStatus(status, err.message || 'Не удалось добавить медиа.', 'error');
      }
    });

    $('event-media-db-search') && $('event-media-db-search').addEventListener('input', function () {
      renderMediaDbPicker($('event-media-db-search').value);
    });

    $('btn-event-media-db-apply') && $('btn-event-media-db-apply').addEventListener('click', function () {
      var status = $('event-media-db-status');
      var checks = $('event-media-db-list').querySelectorAll('input[type="checkbox"]:checked');
      if (!checks.length) {
        setStatus(status, 'Выберите хотя бы одну запись.', 'error');
        return;
      }
      var ids = Array.prototype.map.call(checks, function (el) { return el.value; });
      addEventMediaIds(ids);
      closeMediaDbModal();
      setStatus($('events-status'), 'Медиа из базы добавлены.', 'ok');
    });
  }

  function bindEventSources() {
    $('btn-event-source-add') && $('btn-event-source-add').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleAddMenu('event-source-add-menu', 'btn-event-source-add', $('event-source-add-menu').hidden);
    });

    $('event-source-add-menu') && $('event-source-add-menu').addEventListener('click', function (e) {
      e.stopPropagation();
    });

    $('btn-event-source-new') && $('btn-event-source-new').addEventListener('click', function () {
      closeAllAddMenus();
      openSourceNewModal();
    });

    $('btn-event-source-db') && $('btn-event-source-db').addEventListener('click', function () {
      closeAllAddMenus();
      openSourceDbModal();
    });

    $('btn-event-source-new-close') && $('btn-event-source-new-close').addEventListener('click', closeSourceNewModal);
    $('event-source-new-backdrop') && $('event-source-new-backdrop').addEventListener('click', closeSourceNewModal);
    $('btn-event-source-db-close') && $('btn-event-source-db-close').addEventListener('click', closeSourceDbModal);
    $('event-source-db-backdrop') && $('event-source-db-backdrop').addEventListener('click', closeSourceDbModal);

    $('event-source-db-search') && $('event-source-db-search').addEventListener('input', function () {
      renderSourceDbPicker($('event-source-db-search').value);
    });

    $('btn-event-source-db-apply') && $('btn-event-source-db-apply').addEventListener('click', function () {
      var status = $('event-source-db-status');
      var checks = $('event-source-db-list').querySelectorAll('input[type="checkbox"]:checked');
      if (!checks.length) {
        setStatus(status, 'Выберите хотя бы одну запись.', 'error');
        return;
      }
      var ids = Array.prototype.map.call(checks, function (el) { return el.value; });
      addEventSourceIds(ids);
      closeSourceDbModal();
      setStatus($('events-status'), 'Источники из базы добавлены.', 'ok');
    });

    $('btn-event-source-new-apply') && $('btn-event-source-new-apply').addEventListener('click', async function () {
      var status = $('event-source-new-status');
      var title = ($('event-source-new-title').value || '').trim();
      if (!title) {
        setStatus(status, 'Укажите название источника.', 'error');
        return;
      }
      if (!canEdit()) {
        setStatus(status, 'Недостаточно прав.', 'error');
        return;
      }
      try {
        var item = {
          id: nextReferenceId('sources'),
          title: title,
          url: ($('event-source-new-url').value || '').trim(),
          type: ($('event-source-new-type').value || '').trim(),
          author: '',
          source_date: '',
          citation: '',
          reliability_score: '',
          evidence_quote: ($('event-source-new-evidence').value || '').trim()
        };
        item = await saveReferenceToServer('sources', item);
        replaceOrAppend(state.sources, item.id, item);
        renderOptions('event-source-ids', state.sources, function (x) { return x.title || x.id; });
        renderSourcesTable();
        addEventSourceIds([item.id]);
        closeSourceNewModal();
        setStatus($('events-status'), 'Источник создан и добавлен к событию.', 'ok');
      } catch (err) {
        setStatus(status, err.message || 'Не удалось создать источник.', 'error');
      }
    });
  }

  function bindEventTags() {
    $('btn-event-tag-add') && $('btn-event-tag-add').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleAddMenu('event-tag-add-menu', 'btn-event-tag-add', $('event-tag-add-menu').hidden);
    });

    $('event-tag-add-menu') && $('event-tag-add-menu').addEventListener('click', function (e) {
      e.stopPropagation();
    });

    $('btn-event-tag-new') && $('btn-event-tag-new').addEventListener('click', function () {
      closeAllAddMenus();
      openTagNewModal();
    });

    $('btn-event-tag-db') && $('btn-event-tag-db').addEventListener('click', function () {
      closeAllAddMenus();
      openTagDbModal();
    });

    $('btn-event-tag-new-close') && $('btn-event-tag-new-close').addEventListener('click', closeTagNewModal);
    $('event-tag-new-backdrop') && $('event-tag-new-backdrop').addEventListener('click', closeTagNewModal);
    $('btn-event-tag-db-close') && $('btn-event-tag-db-close').addEventListener('click', closeTagDbModal);
    $('event-tag-db-backdrop') && $('event-tag-db-backdrop').addEventListener('click', closeTagDbModal);

    $('event-tag-db-search') && $('event-tag-db-search').addEventListener('input', function () {
      renderTagDbPicker($('event-tag-db-search').value);
    });

    $('btn-event-tag-db-apply') && $('btn-event-tag-db-apply').addEventListener('click', function () {
      var status = $('event-tag-db-status');
      var checks = $('event-tag-db-list').querySelectorAll('input[type="checkbox"]:checked');
      if (!checks.length) {
        setStatus(status, 'Выберите хотя бы одну запись.', 'error');
        return;
      }
      var ids = Array.prototype.map.call(checks, function (el) { return el.value; });
      addEventTagIds(ids);
      closeTagDbModal();
      setStatus($('events-status'), 'Теги из базы добавлены.', 'ok');
    });

    $('btn-event-tag-new-apply') && $('btn-event-tag-new-apply').addEventListener('click', async function () {
      var status = $('event-tag-new-status');
      var name = ($('event-tag-new-name').value || '').trim();
      if (!name) {
        setStatus(status, 'Укажите название тега.', 'error');
        return;
      }
      if (!canEdit()) {
        setStatus(status, 'Недостаточно прав.', 'error');
        return;
      }
      try {
        var item = {
          id: nextReferenceId('tags'),
          name: name,
          slug: ($('event-tag-new-slug').value || '').trim(),
          description: ''
        };
        item = await saveReferenceToServer('tags', item);
        replaceOrAppend(state.tags, item.id, item);
        renderOptions('event-tag-ids', state.tags, function (x) { return x.name || x.id; });
        renderTagsTable();
        addEventTagIds([item.id]);
        closeTagNewModal();
        setStatus($('events-status'), 'Тег создан и добавлен к событию.', 'ok');
      } catch (err) {
        setStatus(status, err.message || 'Не удалось создать тег.', 'error');
      }
    });
  }

  function bindEventGroups() {
    $('btn-event-group-add') && $('btn-event-group-add').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleAddMenu('event-group-add-menu', 'btn-event-group-add', $('event-group-add-menu').hidden);
    });

    $('event-group-add-menu') && $('event-group-add-menu').addEventListener('click', function (e) {
      e.stopPropagation();
    });

    $('btn-event-group-new') && $('btn-event-group-new').addEventListener('click', function () {
      closeAllAddMenus();
      openGroupNewModal();
    });

    $('btn-event-group-db') && $('btn-event-group-db').addEventListener('click', function () {
      closeAllAddMenus();
      openGroupDbModal();
    });

    $('btn-event-group-new-close') && $('btn-event-group-new-close').addEventListener('click', closeGroupNewModal);
    $('event-group-new-backdrop') && $('event-group-new-backdrop').addEventListener('click', closeGroupNewModal);
    $('btn-event-group-db-close') && $('btn-event-group-db-close').addEventListener('click', closeGroupDbModal);
    $('event-group-db-backdrop') && $('event-group-db-backdrop').addEventListener('click', closeGroupDbModal);

    $('event-group-db-search') && $('event-group-db-search').addEventListener('input', function () {
      renderGroupDbPicker($('event-group-db-search').value);
    });

    $('btn-event-group-db-apply') && $('btn-event-group-db-apply').addEventListener('click', function () {
      var status = $('event-group-db-status');
      var checks = $('event-group-db-list').querySelectorAll('input[type="checkbox"]:checked');
      if (!checks.length) {
        setStatus(status, 'Выберите хотя бы одну запись.', 'error');
        return;
      }
      var ids = Array.prototype.map.call(checks, function (el) { return el.value; });
      addEventGroupIds(ids);
      closeGroupDbModal();
      setStatus($('events-status'), 'Группы из базы добавлены.', 'ok');
    });

    $('btn-event-group-new-apply') && $('btn-event-group-new-apply').addEventListener('click', async function () {
      var status = $('event-group-new-status');
      var name = ($('event-group-new-name').value || '').trim();
      if (!name) {
        setStatus(status, 'Укажите название группы.', 'error');
        return;
      }
      if (!canEdit()) {
        setStatus(status, 'Недостаточно прав.', 'error');
        return;
      }
      try {
        var item = {
          id: nextReferenceId('groups'),
          name: name,
          slug: ($('event-group-new-slug').value || '').trim(),
          description: ''
        };
        item = await saveReferenceToServer('groups', item);
        replaceOrAppend(state.groups, item.id, item);
        renderOptions('event-group-ids', state.groups, function (x) { return x.name || x.id; });
        renderGroupsTable();
        addEventGroupIds([item.id]);
        closeGroupNewModal();
        setStatus($('events-status'), 'Группа создана и добавлена к событию.', 'ok');
      } catch (err) {
        setStatus(status, err.message || 'Не удалось создать группу.', 'error');
      }
    });
  }

  function renderEventsTable() {
    var tbody = $('events-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.events.forEach(function (ev) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(ev.id) + '</td>' +
        '<td>' + escapeHtml(formatEventDate(ev)) + '</td>' +
        '<td>' + escapeHtml(ev.headline || '') + '</td>' +
        '<td>' + escapeHtml(ev.group || '') + '</td>' +
        '<td>' +
        '<span class="admin-status-badge status-' + escapeAttr(ev.status || 'draft') + '">' + statusLabel(ev.status) + '</span> ' +
        '<span class="admin-status-badge verification-' + escapeAttr(ev.verification_status || 'unconfirmed') + '">' + verificationLabel(ev.verification_status) + '</span>' +
        '</td>' +
        '<td>' + (ev.media_url ? 'да' : '—') + '</td>' +
        '<td class="actions">' +
        '<button type="button" class="admin-btn" data-action="edit-event" data-id="' + escapeAttr(ev.id) + '">Изменить</button>' +
        '<button type="button" class="admin-btn admin-btn-danger" data-action="del-event" data-id="' + escapeAttr(ev.id) + '">Удалить</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderUsersTable() {
    var tbody = $('users-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.users.forEach(function (u) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(u.name) + '</td>' +
        '<td>' + escapeHtml(u.email) + '</td>' +
        '<td><span class="admin-role-badge role-' + escapeAttr(u.role) + '">' + roleLabel(u.role) + '</span></td>' +
        '<td>' + (u.active ? 'активен' : 'отключён') + '</td>' +
        '<td class="actions">' +
        '<button type="button" class="admin-btn" data-action="edit-user" data-id="' + escapeAttr(u.id) + '">Изменить</button>' +
        (u.id !== (currentUser() && currentUser().id)
          ? '<button type="button" class="admin-btn admin-btn-danger" data-action="del-user" data-id="' + escapeAttr(u.id) + '">Удалить</button>'
          : '') +
        '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderSourcesTable() {
    var tbody = $('sources-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.sources.forEach(function (item) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(item.title || '') + '</td>' +
        '<td>' + escapeHtml(item.type || '') + '</td>' +
        '<td>' + (item.url ? '<a href="' + escapeAttr(item.url) + '" target="_blank" rel="noopener">ссылка</a>' : '—') + '</td>' +
        '<td class="actions">' +
        '<button type="button" class="admin-btn" data-action="edit-source" data-id="' + escapeAttr(item.id) + '">Изменить</button>' +
        '<button type="button" class="admin-btn admin-btn-danger" data-action="del-source" data-id="' + escapeAttr(item.id) + '">Удалить</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderMediaTable() {
    var tbody = $('media-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.media.forEach(function (item) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + (item.url ? '<a href="' + escapeAttr(item.url) + '" target="_blank" rel="noopener">' + escapeHtml(item.url) + '</a>' : '') + '</td>' +
        '<td>' + escapeHtml(item.type || '') + '</td>' +
        '<td>' + escapeHtml(item.caption || '') + '</td>' +
        '<td class="actions">' +
        '<button type="button" class="admin-btn" data-action="edit-media" data-id="' + escapeAttr(item.id) + '">Изменить</button>' +
        '<button type="button" class="admin-btn admin-btn-danger" data-action="del-media" data-id="' + escapeAttr(item.id) + '">Удалить</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderTagsTable() {
    var tbody = $('tags-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.tags.forEach(function (item) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(item.name || '') + '</td>' +
        '<td><code>' + escapeHtml(item.slug || '') + '</code></td>' +
        '<td>' + escapeHtml(item.description || '') + '</td>' +
        '<td class="actions">' +
        '<button type="button" class="admin-btn" data-action="edit-tag" data-id="' + escapeAttr(item.id) + '">Изменить</button>' +
        '<button type="button" class="admin-btn admin-btn-danger" data-action="del-tag" data-id="' + escapeAttr(item.id) + '">Удалить</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderGroupsTable() {
    var tbody = $('groups-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.groups.forEach(function (item) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(item.name || '') + '</td>' +
        '<td><code>' + escapeHtml(item.slug || '') + '</code></td>' +
        '<td>' + escapeHtml(item.description || '') + '</td>' +
        '<td class="actions">' +
        '<button type="button" class="admin-btn" data-action="edit-group" data-id="' + escapeAttr(item.id) + '">Изменить</button>' +
        '<button type="button" class="admin-btn admin-btn-danger" data-action="del-group" data-id="' + escapeAttr(item.id) + '">Удалить</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
  }

  function auditActionLabel(action) {
    if (action === 'create') return 'Создание';
    if (action === 'update') return 'Изменение';
    if (action === 'delete') return 'Удаление';
    return action || '';
  }

  function entityLabel(entityType) {
    if (entityType === 'event') return 'Событие';
    if (entityType === 'user') return 'Пользователь';
    if (entityType === 'sources') return 'Источник';
    if (entityType === 'media') return 'Медиа';
    if (entityType === 'tags') return 'Тег';
    if (entityType === 'groups') return 'Группа';
    return entityType || '';
  }

  function renderAuditTable() {
    var tbody = $('audit-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.audit.forEach(function (item) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(item.created_at || '') + '</td>' +
        '<td>' + escapeHtml(item.actor_email || 'система') + '</td>' +
        '<td>' + escapeHtml(auditActionLabel(item.action)) + '</td>' +
        '<td>' + escapeHtml(entityLabel(item.entity_type)) + '</td>' +
        '<td><code>' + escapeHtml(item.entity_id || '') + '</code></td>' +
        '<td>' + escapeHtml(item.summary || '') + '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderDbSchema(schema) {
    var summary = $('db-summary');
    var wrap = $('db-schema');
    if (!summary || !wrap) return;

    var tables = schema && schema.tables ? schema.tables : [];
    summary.innerHTML =
      '<div class="admin-db-stat"><strong>Файл БД</strong><span>' + escapeHtml(schema.database || 'archive.sqlite3') + '</span></div>' +
      '<div class="admin-db-stat"><strong>Таблиц</strong><span>' + tables.length + '</span></div>';

    wrap.innerHTML = '';
    tables.forEach(function (table) {
      var card = document.createElement('article');
      card.className = 'admin-db-card';

      var indexes = table.indexes || [];
      var indexText = indexes.length
        ? indexes.map(function (idx) {
          return escapeHtml(idx.name) + (idx.unique ? ' (unique)' : '');
        }).join(', ')
        : 'нет';

      card.innerHTML =
        '<div class="admin-db-card-head">' +
          '<h3>' + escapeHtml(table.name) + '</h3>' +
          '<span>' + escapeHtml(table.type || 'table') + ' · ' + (table.row_count == null ? '—' : table.row_count) + ' записей</span>' +
        '</div>' +
        '<div class="admin-table-wrap">' +
          '<table class="admin-table admin-db-table">' +
            '<thead>' +
              '<tr>' +
                '<th>Поле</th>' +
                '<th>Тип</th>' +
                '<th>Обязательное</th>' +
                '<th>PK</th>' +
                '<th>По умолчанию</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' +
              (table.columns || []).map(function (column) {
                return '<tr>' +
                  '<td><code>' + escapeHtml(column.name) + '</code></td>' +
                  '<td>' + escapeHtml(column.type || '') + '</td>' +
                  '<td>' + (column.notnull ? 'да' : 'нет') + '</td>' +
                  '<td>' + (column.pk ? 'да' : 'нет') + '</td>' +
                  '<td>' + escapeHtml(column.default == null ? '' : column.default) + '</td>' +
                '</tr>';
              }).join('') +
            '</tbody>' +
          '</table>' +
        '</div>' +
        '<p class="admin-db-indexes"><strong>Индексы:</strong> ' + indexText + '</p>';

      wrap.appendChild(card);
    });
  }

  function roleLabel(role) {
    if (role === 'admin') return 'Администратор';
    if (role === 'editor') return 'Редактор';
    return 'Просмотр';
  }

  var PUBLISH_BLOCKED_VERIFICATION = ['needs_review', 'disputed', 'unconfirmed'];

  function statusLabel(status) {
    if (status === 'draft') return 'Черновик';
    if (status === 'review') return 'На проверке';
    return 'Опубликовано';
  }

  function verificationLabel(status) {
    if (status === 'verified') return 'Проверено';
    if (status === 'needs_review') return 'Требует проверки';
    if (status === 'disputed') return 'Спорно';
    if (status === 'unconfirmed') return 'Не подтверждено';
    return '—';
  }

  function isEventPublicReady(status, verification) {
    return status === 'published' && verification === 'verified';
  }

  function updateEventStatusHint() {
    var hint = $('event-status-hint');
    var statusEl = $('event-status');
    var verificationEl = $('event-verification-status');
    if (!hint || !statusEl || !verificationEl) return;

    var status = statusEl.value || 'draft';
    var verification = verificationEl.value || 'unconfirmed';

    if (isEventPublicReady(status, verification)) {
      hint.textContent = 'Событие будет видно на главной странице.';
      hint.className = 'admin-hint is-success';
      return;
    }

    var parts = [];
    if (status !== 'published') {
      parts.push('публикация «' + statusLabel(status) + '»');
    }
    if (verification !== 'verified') {
      parts.push('проверка «' + verificationLabel(verification) + '»');
    }
    hint.textContent = 'На главной не отображается: ' + parts.join(', ') + '.';
    hint.className = 'admin-hint admin-event-preview-notice is-draft';
  }

  function updateEventVerificationSelectStyle() {
    var select = $('event-verification-status');
    if (!select) return;
    select.classList.remove(
      'verification-verified',
      'verification-needs_review',
      'verification-disputed',
      'verification-unconfirmed'
    );
    var value = select.value || 'unconfirmed';
    select.classList.add('verification-' + value);
  }

  function syncEventStatuses(changed) {
    var statusEl = $('event-status');
    var verificationEl = $('event-verification-status');
    if (!statusEl || !verificationEl) return;

    var status = statusEl.value || 'draft';
    var verification = verificationEl.value || 'unconfirmed';

    if (changed === 'verification') {
      if (verification === 'needs_review' && status === 'published') {
        statusEl.value = 'review';
        status = 'review';
      }
      if (PUBLISH_BLOCKED_VERIFICATION.indexOf(verification) >= 0 && status === 'published') {
        statusEl.value = 'review';
        status = 'review';
      }
    }

    if (changed === 'status') {
      if (status === 'published') {
        if (PUBLISH_BLOCKED_VERIFICATION.indexOf(verification) >= 0) {
          statusEl.value = 'review';
          verificationEl.value = verification === 'unconfirmed' ? 'needs_review' : verification;
        } else if (!verification || verification === 'unconfirmed') {
          verificationEl.value = 'verified';
        }
      } else if (status === 'review') {
        if (!verification || verification === 'unconfirmed' || verification === 'verified') {
          verificationEl.value = 'needs_review';
        }
      } else if (status === 'draft') {
        if (!verification || verification === 'verified' || verification === 'needs_review') {
          verificationEl.value = 'unconfirmed';
        }
      }
    }

    updateEventStatusSelectStyle();
    updateEventVerificationSelectStyle();
    updateEventStatusHint();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function normalizeHashtag(value) {
    var text = (value || '').trim();
    if (text.charAt(0) === '#') {
      text = text.slice(1).trim();
    }
    return text;
  }

  function formatHashtag(value) {
    var text = normalizeHashtag(value);
    return text ? '#' + text : '';
  }

  function updateEventTextCounter() {
    var text = $('event-text');
    var counter = $('event-text-counter');
    if (!text || !counter) return;

    var max = Number(text.getAttribute('maxlength')) || 5000;
    var length = text.value.length;
    counter.textContent = length + ' / ' + max + ' символов';
    counter.classList.toggle('is-limit', length >= max);
  }

  function updateEventStatusSelectStyle() {
    var select = $('event-status');
    if (!select) return;
    select.classList.remove('status-published', 'status-review', 'status-draft');
    var value = select.value || 'published';
    select.classList.add('status-' + value);
  }

  function clearEventForm() {
    state.editingEventId = null;
    var form = $('event-form');
    if (form) form.reset();
    setEventIdField(allocateEventId());
    $('event-importance').value = '3';
    $('event-status').value = 'draft';
    $('event-hashtag').value = '';
    $('event-verification-status').value = 'unconfirmed';
    $('event-start-date-precision').value = '';
    $('event-end-date-precision').value = '';
    $('event-start-date-approximate').checked = false;
    $('event-end-date-approximate').checked = false;
    $('event-domain').value = '';
    $('event-category').value = '';
    $('event-subcategory').value = '';
    $('event-type').value = '';
    $('event-scale').value = '';
    $('event-country').value = '';
    $('event-region').value = '';
    $('event-city').value = '';
    $('event-summary').value = '';
    $('event-related').value = '';
    updateEventStatusSelectStyle();
    updateEventVerificationSelectStyle();
    updateEventStatusHint();
    setSelectedValues($('event-source-ids'), []);
    setSelectedValues($('event-media-ids'), []);
    setSelectedValues($('event-tag-ids'), []);
    setSelectedValues($('event-group-ids'), defaultGroupIds());
    clearPrimaryEventMedia();
    renderEventGroupList();
    renderEventSourceList();
    renderEventTagList();
    updateEventTextCounter();
    updateEventDateHint();
    $('event-form-title').textContent = 'Новое событие';
    closeEventPreviewModal();
  }

  function fillEventForm(ev) {
    state.editingEventId = ev.id;
    $('event-form-title').textContent = 'Редактирование: ' + ev.id;
    setEventIdField(ev.id || '');
    $('event-start-year').value = ev.start_year || '';
    $('event-start-month').value = ev.start_month || '';
    $('event-start-day').value = ev.start_day || '';
    $('event-end-year').value = ev.end_year || '';
    $('event-end-month').value = ev.end_month || '';
    $('event-end-day').value = ev.end_day || '';
    $('event-hashtag').value = formatHashtag(ev.hashtag || ev.slug || '');
    $('event-verification-status').value = ev.verification_status || '';
    $('event-start-date-precision').value = ev.start_date_precision || ev.date_precision || '';
    $('event-end-date-precision').value = ev.end_date_precision || '';
    $('event-start-date-approximate').checked = ev.start_date_approximate === '1' || ev.is_date_approximate === '1';
    $('event-end-date-approximate').checked = ev.end_date_approximate === '1';
    $('event-domain').value = ev.domain || '';
    $('event-category').value = ev.category || '';
    $('event-subcategory').value = ev.subcategory || '';
    $('event-type').value = ev.event_type || '';
    $('event-scale').value = ev.scale || '';
    $('event-country').value = ev.country_name || '';
    $('event-region').value = ev.region || '';
    $('event-city').value = ev.city || '';
    $('event-headline').value = ev.headline || '';
    $('event-summary').value = ev.summary || '';
    $('event-text').value = ev.text || '';
    $('event-related').value = ev.related_events || '';
    $('event-media-url').value = ev.media_url || '';
    $('event-media-caption').value = ev.media_caption || '';
    $('event-media-credit').value = ev.media_credit || '';
    $('event-importance').value = ev.importance || '3';
    $('event-status').value = ev.status || 'draft';
    if (!ev.verification_status) {
      $('event-verification-status').value = ev.status === 'published' ? 'verified' : ev.status === 'review' ? 'needs_review' : 'unconfirmed';
    }
    updateEventStatusSelectStyle();
    updateEventVerificationSelectStyle();
    updateEventStatusHint();
    setSelectedValues($('event-source-ids'), ev.source_ids || []);
    setSelectedValues($('event-media-ids'), ev.media_ids || []);
    setSelectedValues($('event-tag-ids'), ev.tag_ids || []);
    setSelectedValues($('event-group-ids'), resolveEventGroupIds(ev));
    renderEventGroupList();
    renderEventSourceList();
    renderEventMediaList();
    renderEventTagList();
    updateEventTextCounter();
    updateEventDateHint();
    if (isEventPreviewOpen()) {
      renderEventPreview();
    }
  }

  function isEventPreviewOpen() {
    var modal = $('event-preview-modal');
    return modal && !modal.hidden;
  }

  function openEventPreviewModal() {
    var modal = $('event-preview-modal');
    if (!modal) return;
    modal.hidden = false;
    syncEventModalBodyClass();
  }

  function closeEventPreviewModal() {
    var modal = $('event-preview-modal');
    if (!modal) return;
    modal.hidden = true;
    syncEventModalBodyClass();
  }

  function resolveReferenceItems(ids, list) {
    if (!ids || !ids.length) return [];
    var map = {};
    (list || []).forEach(function (item) {
      map[item.id] = item;
    });
    return ids.map(function (id) { return map[id]; }).filter(Boolean);
  }

  function formatPreviewDate(ev) {
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

  function readEventDateSource() {
    return readEventForm();
  }

  function updateEventDateHint() {
    var hint = $('event-date-hint');
    if (!hint || !window.ArchiveDateFormat) return;

    var source = readEventDateSource();
    var issues = window.ArchiveDateFormat.validateDateInput(source);
    if (issues.length) {
      hint.textContent = issues.join(' ');
      hint.className = 'admin-hint admin-date-logic-hint is-warning';
      return;
    }

    hint.textContent = window.ArchiveDateFormat.describeDateLogic(source);
    hint.className = 'admin-hint admin-date-logic-hint';
  }

  function syncDatePrecisionSideEffects(changedId) {
    var startPrecisionEl = $('event-start-date-precision');
    var endPrecisionEl = $('event-end-date-precision');
    var startApproxEl = $('event-start-date-approximate');
    var endApproxEl = $('event-end-date-approximate');

    if (startPrecisionEl && startPrecisionEl.value === 'approximate' && startApproxEl) {
      startApproxEl.checked = true;
    }
    if (endPrecisionEl && endPrecisionEl.value === 'approximate' && endApproxEl) {
      endApproxEl.checked = true;
    }

    updateEventDateHint();
  }

  function bindDateLogicEvents() {
    var ids = [
      'event-start-day', 'event-start-month', 'event-start-year',
      'event-end-day', 'event-end-month', 'event-end-year',
      'event-start-date-precision', 'event-end-date-precision',
      'event-start-date-approximate', 'event-end-date-approximate'
    ];

    ids.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        syncDatePrecisionSideEffects(id);
        if (isEventPreviewOpen()) renderEventPreview();
      });
      el.addEventListener('input', function () {
        syncDatePrecisionSideEffects(id);
        if (isEventPreviewOpen()) renderEventPreview();
      });
    });
  }

  function appendPreviewRelatedSection(container, title, items, renderItem) {
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

  function isPreviewImageMediaUrl(url) {
    if (!url) return false;
    if (url.indexOf('data:image/') === 0) return true;
    return /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(url);
  }

  function renderPreviewMedia(bodyEl, ev) {
    var old = bodyEl.querySelector('.fact-media');
    if (old) old.remove();
    if (!ev || !ev.media || !ev.media.url) return;

    var url = ev.media.url;
    var textEl = bodyEl.querySelector('.fact-text');
    if (!textEl) return;

    if (isPreviewImageMediaUrl(url)) {
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
      textEl.insertAdjacentElement('afterend', figure);
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
    textEl.insertAdjacentElement('afterend', linkWrap);
  }

  function renderPreviewRelated(bodyEl, ev) {
    var sources = ev._sources || [];
    var media = ev._media_items || [];
    var tags = ev._tag_items || [];
    if (!sources.length && !media.length && !tags.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'fact-related';
    appendPreviewRelatedSection(wrap, 'Источники', sources, function (li, source) {
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
    appendPreviewRelatedSection(wrap, 'Медиа', media, function (li, item) {
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
    appendPreviewRelatedSection(wrap, 'Теги', tags, function (li, tag) {
      var badge = document.createElement('span');
      badge.className = 'fact-tag';
      badge.textContent = tag.name || tag.slug || tag.id;
      li.appendChild(badge);
    });
    bodyEl.appendChild(wrap);
  }

  function buildPreviewMediaItems(ev) {
    return resolveReferenceItems(ev.media_ids, state.media).slice();
  }

  function buildPreviewEvent() {
    var ev = readEventForm();
    return {
      text: { headline: ev.headline || 'Без названия', text: ev.text || '' },
      _hashtag: formatHashtag(ev.hashtag || ''),
      _summary: ev.summary || '',
      group: ev.group || '',
      start_date: {
        year: ev.start_year,
        month: ev.start_month,
        day: ev.start_day
      },
      end_date: {
        year: ev.end_year,
        month: ev.end_month,
        day: ev.end_day
      },
      _start_date_precision: ev.start_date_precision || ev.date_precision || '',
      _end_date_precision: ev.end_date_precision || '',
      status: ev.status,
      _scale: ev.scale || '',
      _event_type: ev.event_type || '',
      _domain: ev.domain || '',
      _country_name: ev.country_name || '',
      _region: ev.region || '',
      _city: ev.city || '',
      _start_date_approximate: ev.start_date_approximate === '1' || ev.is_date_approximate === '1',
      _end_date_approximate: ev.end_date_approximate === '1',
      media: ev.media_url
        ? { url: ev.media_url, caption: ev.media_caption || '', credit: ev.media_credit || '' }
        : null,
      _sources: resolveReferenceItems(ev.source_ids, state.sources),
      _media_items: buildPreviewMediaItems(ev),
      _tag_items: resolveReferenceItems(ev.tag_ids, state.tags)
    };
  }

  function renderEventPreview() {
    var notice = $('event-preview-notice');
    var titleEl = $('event-preview-title');
    var dateEl = $('event-preview-date');
    var textEl = $('event-preview-text');
    var bodyEl = $('event-preview-body');
    if (!titleEl || !dateEl || !textEl || !bodyEl) return;

    var ev = buildPreviewEvent();
    var group = ev.group ? ' · ' + ev.group : '';
    var location = formatPreviewLocation(ev);
    var meta = formatPreviewMeta(ev);
    titleEl.textContent = (ev.text && ev.text.headline) || 'Без названия';
    var hashtagEl = $('event-preview-hashtag');
    if (hashtagEl) {
      if (ev._hashtag) {
        hashtagEl.textContent = ev._hashtag;
        hashtagEl.hidden = false;
      } else {
        hashtagEl.textContent = '';
        hashtagEl.hidden = true;
      }
    }
    dateEl.textContent = [formatPreviewDate(ev) || '—', location, group.replace(/^ · /, '')].filter(Boolean).join(' · ');
    if (meta) {
      dateEl.textContent += ' · ' + meta;
    }
    var bodyParts = [];
    if (ev._summary) bodyParts.push(ev._summary);
    if (ev.text && ev.text.text) bodyParts.push(ev.text.text);
    textEl.textContent = bodyParts.join('\n\n') || 'Описание отсутствует.';

    var oldRelated = bodyEl.querySelector('.fact-related');
    if (oldRelated) oldRelated.remove();
    renderPreviewMedia(bodyEl, ev);
    renderPreviewRelated(bodyEl, ev);

    if (notice) {
      var form = readEventForm();
      if (isEventPublicReady(form.status, form.verification_status || 'unconfirmed')) {
        notice.textContent = 'Событие будет видно на главной странице.';
        notice.className = 'admin-hint is-success';
      } else {
        var parts = [];
        if (form.status !== 'published') parts.push('публикация «' + statusLabel(form.status) + '»');
        if (form.verification_status !== 'verified') {
          parts.push('проверка «' + verificationLabel(form.verification_status || 'unconfirmed') + '»');
        }
        notice.textContent = 'На главной не отображается: ' + parts.join(', ') + '.';
        notice.className = 'admin-hint admin-event-preview-notice is-draft';
      }
    }

    openEventPreviewModal();
  }

  function formatPreviewLocation(ev) {
    return [ev._city, ev._region, ev._country_name].filter(Boolean).join(', ');
  }

  function formatPreviewMeta(ev) {
    var parts = [];
    if (ev._scale) parts.push(ev._scale);
    if (ev._event_type) parts.push(ev._event_type);
    if (ev._domain) parts.push(ev._domain);
    return parts.join(' · ');
  }

  function readEventForm() {
    return {
      id: ($('event-id').value || '').trim(),
      hashtag: normalizeHashtag($('event-hashtag').value || ''),
      start_year: ($('event-start-year').value || '').trim(),
      start_month: ($('event-start-month').value || '').trim(),
      start_day: ($('event-start-day').value || '').trim(),
      end_year: ($('event-end-year').value || '').trim(),
      end_month: ($('event-end-month').value || '').trim(),
      end_day: ($('event-end-day').value || '').trim(),
      start_date_precision: ($('event-start-date-precision').value || '').trim(),
      end_date_precision: ($('event-end-date-precision').value || '').trim(),
      start_date_approximate: $('event-start-date-approximate').checked ? '1' : '0',
      end_date_approximate: $('event-end-date-approximate').checked ? '1' : '0',
      headline: ($('event-headline').value || '').trim(),
      summary: ($('event-summary').value || '').trim(),
      text: ($('event-text').value || '').trim(),
      verification_status: ($('event-verification-status').value || '').trim(),
      event_type: ($('event-type').value || '').trim(),
      scale: ($('event-scale').value || '').trim(),
      domain: ($('event-domain').value || '').trim(),
      category: ($('event-category').value || '').trim(),
      subcategory: ($('event-subcategory').value || '').trim(),
      country_name: ($('event-country').value || '').trim(),
      region: ($('event-region').value || '').trim(),
      city: ($('event-city').value || '').trim(),
      related_events: ($('event-related').value || '').trim(),
      media_url: ($('event-media-url').value || '').trim(),
      media_caption: ($('event-media-caption').value || '').trim(),
      media_credit: ($('event-media-credit').value || '').trim(),
      group: buildEventGroupString(),
      tags: buildEventTagsString(),
      importance: ($('event-importance').value || '').trim(),
      status: ($('event-status').value || 'published').trim(),
      source_ids: selectedValues($('event-source-ids')),
      media_ids: selectedValues($('event-media-ids')),
      tag_ids: selectedValues($('event-tag-ids')),
      group_ids: selectedValues($('event-group-ids'))
    };
  }

  function clearUserForm() {
    state.editingUserId = null;
    var form = $('user-form');
    if (!form) return;
    form.reset();
    $('user-id').value = nextUserId();
    $('user-active').checked = true;
    $('user-role').value = 'editor';
    $('user-password').placeholder = 'Пароль';
    $('user-form-title').textContent = 'Новый пользователь';
  }

  function fillUserForm(u) {
    state.editingUserId = u.id;
    $('user-form-title').textContent = 'Редактирование: ' + u.name;
    $('user-id').value = u.id;
    $('user-name').value = u.name || '';
    $('user-email').value = u.email || '';
    $('user-role').value = u.role || 'editor';
    $('user-active').checked = !!u.active;
    $('user-password').value = '';
    $('user-password').placeholder = 'Оставьте пустым, чтобы не менять';
  }

  function readUserForm() {
    return {
      id: ($('user-id').value || '').trim(),
      name: ($('user-name').value || '').trim(),
      email: ($('user-email').value || '').trim(),
      role: $('user-role').value,
      active: $('user-active').checked,
      password: ($('user-password').value || '').trim()
    };
  }

  function clearSourceForm() {
    state.editingSourceId = null;
    $('source-form') && $('source-form').reset();
    $('source-id').value = nextReferenceId('sources');
    $('source-form-title').textContent = 'Новый источник';
  }

  function fillSourceForm(item) {
    state.editingSourceId = item.id;
    $('source-form-title').textContent = 'Редактирование: ' + item.id;
    ['id', 'title', 'url', 'type', 'author', 'source_date', 'citation', 'reliability_score', 'evidence_quote'].forEach(function (key) {
      var el = $('source-' + (key === 'source_date' ? 'date' : key === 'reliability_score' ? 'reliability' : key === 'evidence_quote' ? 'evidence-quote' : key));
      if (el) el.value = item[key] || '';
    });
  }

  function readSourceForm() {
    return {
      id: ($('source-id').value || '').trim(),
      title: ($('source-title').value || '').trim(),
      url: ($('source-url').value || '').trim(),
      type: ($('source-type').value || '').trim(),
      author: ($('source-author').value || '').trim(),
      source_date: ($('source-date').value || '').trim(),
      citation: ($('source-citation').value || '').trim(),
      reliability_score: ($('source-reliability').value || '').trim(),
      evidence_quote: ($('source-evidence-quote').value || '').trim()
    };
  }

  function clearMediaForm() {
    state.editingMediaId = null;
    $('media-form') && $('media-form').reset();
    $('media-id').value = nextReferenceId('media');
    $('media-form-title').textContent = 'Новое медиа';
  }

  function fillMediaForm(item) {
    state.editingMediaId = item.id;
    $('media-form-title').textContent = 'Редактирование: ' + item.id;
    $('media-id').value = item.id || '';
    $('media-url').value = item.url || '';
    $('media-type').value = item.type || '';
    $('media-caption').value = item.caption || '';
    $('media-credit').value = item.credit || '';
    $('media-license').value = item.license || '';
    $('media-alt-text').value = item.alt_text || '';
  }

  function readMediaForm() {
    return {
      id: ($('media-id').value || '').trim(),
      url: ($('media-url').value || '').trim(),
      type: ($('media-type').value || '').trim(),
      caption: ($('media-caption').value || '').trim(),
      credit: ($('media-credit').value || '').trim(),
      license: ($('media-license').value || '').trim(),
      alt_text: ($('media-alt-text').value || '').trim()
    };
  }

  function clearTagForm() {
    state.editingTagId = null;
    $('tag-form') && $('tag-form').reset();
    $('tag-id').value = nextReferenceId('tags');
    $('tag-form-title').textContent = 'Новый тег';
  }

  function fillTagForm(item) {
    state.editingTagId = item.id;
    $('tag-form-title').textContent = 'Редактирование: ' + item.id;
    $('tag-id').value = item.id || '';
    $('tag-name').value = item.name || '';
    $('tag-slug').value = item.slug || '';
    $('tag-description').value = item.description || '';
  }

  function readTagForm() {
    return {
      id: ($('tag-id').value || '').trim(),
      name: ($('tag-name').value || '').trim(),
      slug: ($('tag-slug').value || '').trim(),
      description: ($('tag-description').value || '').trim()
    };
  }

  function clearGroupForm() {
    state.editingGroupId = null;
    $('group-form') && $('group-form').reset();
    $('group-id').value = nextReferenceId('groups');
    $('group-form-title').textContent = 'Новая группа';
  }

  function fillGroupForm(item) {
    state.editingGroupId = item.id;
    $('group-form-title').textContent = 'Редактирование: ' + item.id;
    $('group-id').value = item.id || '';
    $('group-name').value = item.name || '';
    $('group-slug').value = item.slug || '';
    $('group-description').value = item.description || '';
  }

  function readGroupForm() {
    return {
      id: ($('group-id').value || '').trim(),
      name: ($('group-name').value || '').trim(),
      slug: ($('group-slug').value || '').trim(),
      description: ($('group-description').value || '').trim()
    };
  }

  function bindTabs() {
    document.querySelectorAll('.admin-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.dataset.tab);
        if (btn.dataset.tab === 'db-schema' && !state.dbSchema) {
          refreshDbSchema();
        }
        if (btn.dataset.tab === 'audit' && canManageUsers()) {
          refreshAudit();
        }
      });
    });
  }

  function bindLogin() {
    var form = $('login-form');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = ($('login-email').value || '').trim().toLowerCase();
      var password = ($('login-password').value || '');
      var status = $('login-status');
      try {
        state.currentUser = await loginOnServer(email, password);
        await initData();
      } catch (err) {
        setStatus(status, err.message || 'Неверный email или пароль.', 'error');
        return;
      }
      setStatus(status, '', '');
      showApp(true);
      refreshUi();
    });
  }

  function bindPasswordToggle() {
    var input = $('login-password');
    var btn = $('login-password-toggle');
    if (!input || !btn) return;
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Скрыть пароль' : 'Показать пароль';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    });
  }

  function bindLogout() {
    var btn = $('btn-logout');
    if (btn) {
      btn.addEventListener('click', async function () {
        await logoutOnServer();
        state.currentUser = null;
        state.events = [];
        state.users = [];
        showApp(false);
      });
    }
  }

  function bindEvents() {
    var form = $('event-form');
    var status = $('events-status');
    var dbStatus = $('events-db-status');
    var textInput = $('event-text');

    $('btn-event-new') && $('btn-event-new').addEventListener('click', clearEventForm);

    $('btn-event-preview') && $('btn-event-preview').addEventListener('click', function () {
      if (!canEdit()) {
        setStatus(status, 'Недостаточно прав для предпросмотра.', 'error');
        return;
      }
      renderEventPreview();
    });

    textInput && textInput.addEventListener('input', updateEventTextCounter);

    $('event-status') && $('event-status').addEventListener('change', function () {
      syncEventStatuses('status');
    });
    $('event-verification-status') && $('event-verification-status').addEventListener('change', function () {
      syncEventStatuses('verification');
    });

    form && form.addEventListener('input', function () {
      if (isEventPreviewOpen()) {
        renderEventPreview();
      }
    });

    form && form.addEventListener('change', function () {
      if (isEventPreviewOpen()) {
        renderEventPreview();
      }
    });

    $('btn-event-preview-close') && $('btn-event-preview-close').addEventListener('click', closeEventPreviewModal);
    $('event-preview-backdrop') && $('event-preview-backdrop').addEventListener('click', closeEventPreviewModal);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('event-media-folder-modal').hidden) closeMediaFolderModal();
      else if (!$('event-media-db-modal').hidden) closeMediaDbModal();
      else if (!$('event-source-new-modal').hidden) closeSourceNewModal();
      else if (!$('event-source-db-modal').hidden) closeSourceDbModal();
      else if (!$('event-tag-new-modal').hidden) closeTagNewModal();
      else if (!$('event-tag-db-modal').hidden) closeTagDbModal();
      else if (!$('event-group-new-modal').hidden) closeGroupNewModal();
      else if (!$('event-group-db-modal').hidden) closeGroupDbModal();
      else if (isEventPreviewOpen()) closeEventPreviewModal();
      else closeAllAddMenus();
    });

    form && form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!canEdit()) {
        setStatus(status, 'Недостаточно прав для редактирования.', 'error');
        return;
      }
      var ev = readEventForm();
      if (!ev.start_year) {
        setStatus(status, 'Укажите год начала.', 'error');
        return;
      }
      if (window.ArchiveDateFormat) {
        var dateIssues = window.ArchiveDateFormat.validateDateInput(ev);
        if (dateIssues.length) {
          setStatus(status, dateIssues.join(' '), 'error');
          return;
        }
      }
      if (ev.status === 'published' && PUBLISH_BLOCKED_VERIFICATION.indexOf(ev.verification_status || 'unconfirmed') >= 0) {
        setStatus(status, 'Опубликовать можно только проверенные события. Установите «Проверка фактов» = Проверено.', 'error');
        return;
      }
      if (!state.editingEventId) {
        ev.id = allocateEventId();
        setEventIdField(ev.id);
      }
      if (!ev.id) {
        setStatus(status, 'Не удалось сформировать код события.', 'error');
        return;
      }
      var dup = state.events.some(function (x) {
        return x.id === ev.id && x.id !== state.editingEventId;
      });
      if (dup) {
        setStatus(status, 'Событие с таким кодом уже есть.', 'error');
        return;
      }
      try {
        ev = await saveEventToServer(ev);
      } catch (err) {
        setStatus(status, err.message || 'Не удалось сохранить событие в БД.', 'error');
        return;
      }
      if (state.editingEventId) {
        var idx = state.events.findIndex(function (x) { return x.id === state.editingEventId; });
        if (idx >= 0) state.events[idx] = ev;
      } else {
        state.events.push(ev);
      }
      renderEventsTable();
      clearEventForm();
      setStatus(status, 'Событие сохранено в БД.', 'ok');
    });

    $('btn-export-csv') && $('btn-export-csv').addEventListener('click', function () {
      var blob = new Blob(['\ufeff' + eventsToCsv(state.events)], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'events.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus(dbStatus, 'CSV-копия текущих данных скачана.', 'ok');
    });

    $('btn-reload-csv') && $('btn-reload-csv').addEventListener('click', async function () {
      try {
        state.events = await loadEventsFromServer();
        renderEventsTable();
        setStatus(dbStatus, 'Загружено из БД (' + state.events.length + ' записей).', 'ok');
      } catch (err) {
        setStatus(dbStatus, err.message || 'Не удалось загрузить события из БД.', 'error');
      }
    });

    $('btn-reset-events') && $('btn-reset-events').addEventListener('click', function () {
      clearEventForm();
      setStatus(status, 'Форма очищена.', 'ok');
    });

    $('events-table-body') && $('events-table-body').addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var id = btn.dataset.id;
      if (btn.dataset.action === 'edit-event') {
        var ev = state.events.find(function (x) { return x.id === id; });
        if (ev) {
          fillEventForm(ev);
          switchTab('events');
        }
      }
      if (btn.dataset.action === 'del-event') {
        if (!canEdit()) return;
        if (!confirm('Удалить событие ' + id + '?')) return;
        try {
          await deleteEventFromServer(id);
        } catch (err) {
          setStatus(dbStatus, err.message || 'Не удалось удалить событие из БД.', 'error');
          return;
        }
        state.events = state.events.filter(function (x) { return x.id !== id; });
        renderEventsTable();
        setStatus(dbStatus, 'Событие удалено из БД.', 'ok');
      }
    });
  }

  function setUsersPanelAccess() {
    var panel = $('panel-users');
    if (!panel) return;
    var allowed = canManageUsers();
    panel.querySelectorAll('input, select, button, textarea').forEach(function (el) {
      el.disabled = !allowed;
    });
  }

  function bindUsers() {
    var form = $('user-form');
    var status = $('users-status');

    $('btn-user-new') && $('btn-user-new').addEventListener('click', function () {
      if (!canManageUsers()) return;
      clearUserForm();
    });

    form && form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!canManageUsers()) {
        setStatus(status, 'Только администратор может управлять пользователями.', 'error');
        return;
      }
      var data = readUserForm();
      if (!data.name || !data.email) {
        setStatus(status, 'Заполните имя и email.', 'error');
        return;
      }
      var emailDup = state.users.some(function (u) {
        return u.email.toLowerCase() === data.email.toLowerCase() && u.id !== state.editingUserId;
      });
      if (emailDup) {
        setStatus(status, 'Email уже используется.', 'error');
        return;
      }

      if (!state.editingUserId && !data.password) {
        setStatus(status, 'Для нового пользователя укажите пароль.', 'error');
        return;
      }
      if (!data.id) {
        data.id = nextUserId();
      }

      var saved;
      try {
        saved = await saveUserToServer(data);
      } catch (err) {
        setStatus(status, err.message || 'Не удалось сохранить пользователя.', 'error');
        return;
      }

      if (state.editingUserId) {
        var idx = state.users.findIndex(function (u) { return u.id === state.editingUserId; });
        if (idx >= 0) state.users[idx] = saved;
      } else {
        state.users.push(saved);
      }
      renderUsersTable();
      clearUserForm();
      setStatus(status, 'Пользователь сохранён.', 'ok');
    });

    $('users-table-body') && $('users-table-body').addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn || !canManageUsers()) return;
      var id = btn.dataset.id;
      if (btn.dataset.action === 'edit-user') {
        var u = state.users.find(function (x) { return x.id === id; });
        if (u) fillUserForm(u);
      }
      if (btn.dataset.action === 'del-user') {
        if (!confirm('Удалить пользователя?')) return;
        try {
          await deleteUserFromServer(id);
        } catch (err) {
          setStatus(status, err.message || 'Не удалось удалить пользователя.', 'error');
          return;
        }
        state.users = state.users.filter(function (x) { return x.id !== id; });
        renderUsersTable();
        setStatus(status, 'Пользователь удалён.', 'ok');
      }
    });
  }

  function replaceOrAppend(list, id, item) {
    var idx = list.findIndex(function (x) { return x.id === id; });
    if (idx >= 0) {
      list[idx] = item;
    } else {
      list.push(item);
    }
  }

  function bindReferenceSection(options) {
    var form = $(options.formId);
    var status = $(options.statusId);
    var tbody = $(options.tbodyId);
    var newBtn = $(options.newBtnId);
    var refreshBtn = $(options.refreshBtnId);

    newBtn && newBtn.addEventListener('click', options.clear);

    refreshBtn && refreshBtn.addEventListener('click', async function () {
      try {
        state[options.kind] = await loadReferenceFromServer(options.kind);
        options.render();
        renderEventReferenceOptions();
        setStatus(status, 'Справочник обновлён.', 'ok');
      } catch (err) {
        setStatus(status, err.message || 'Не удалось обновить справочник.', 'error');
      }
    });

    form && form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!canEdit()) {
        setStatus(status, 'Недостаточно прав.', 'error');
        return;
      }
      var item = options.read();
      if (!item.id) item.id = nextReferenceId(options.kind);
      try {
        item = await saveReferenceToServer(options.kind, item);
      } catch (err) {
        setStatus(status, err.message || 'Не удалось сохранить запись.', 'error');
        return;
      }
      replaceOrAppend(state[options.kind], item.id, item);
      options.render();
      renderEventReferenceOptions();
      options.clear();
      setStatus(status, 'Запись сохранена.', 'ok');
    });

    tbody && tbody.addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn || !canEdit()) return;
      var id = btn.dataset.id;
      if (btn.dataset.action === options.editAction) {
        var item = state[options.kind].find(function (x) { return x.id === id; });
        if (item) options.fill(item);
      }
      if (btn.dataset.action === options.deleteAction) {
        if (!confirm('Удалить запись ' + id + '?')) return;
        try {
          await deleteReferenceFromServer(options.kind, id);
        } catch (err) {
          setStatus(status, err.message || 'Не удалось удалить запись.', 'error');
          return;
        }
        state[options.kind] = state[options.kind].filter(function (x) { return x.id !== id; });
        options.render();
        renderEventReferenceOptions();
        setStatus(status, 'Запись удалена.', 'ok');
      }
    });
  }

  function bindReferences() {
    bindReferenceSection({
      kind: 'sources',
      formId: 'source-form',
      statusId: 'sources-status',
      tbodyId: 'sources-table-body',
      newBtnId: 'btn-source-new',
      refreshBtnId: 'btn-source-refresh',
      editAction: 'edit-source',
      deleteAction: 'del-source',
      clear: clearSourceForm,
      fill: fillSourceForm,
      read: readSourceForm,
      render: renderSourcesTable
    });

    bindReferenceSection({
      kind: 'media',
      formId: 'media-form',
      statusId: 'media-status',
      tbodyId: 'media-table-body',
      newBtnId: 'btn-media-new',
      refreshBtnId: 'btn-media-refresh',
      editAction: 'edit-media',
      deleteAction: 'del-media',
      clear: clearMediaForm,
      fill: fillMediaForm,
      read: readMediaForm,
      render: renderMediaTable
    });

    bindReferenceSection({
      kind: 'tags',
      formId: 'tag-form',
      statusId: 'tags-status',
      tbodyId: 'tags-table-body',
      newBtnId: 'btn-tag-new',
      refreshBtnId: 'btn-tag-refresh',
      editAction: 'edit-tag',
      deleteAction: 'del-tag',
      clear: clearTagForm,
      fill: fillTagForm,
      read: readTagForm,
      render: renderTagsTable
    });

    bindReferenceSection({
      kind: 'groups',
      formId: 'group-form',
      statusId: 'groups-status',
      tbodyId: 'groups-table-body',
      newBtnId: 'btn-group-new',
      refreshBtnId: 'btn-group-refresh',
      editAction: 'edit-group',
      deleteAction: 'del-group',
      clear: clearGroupForm,
      fill: fillGroupForm,
      read: readGroupForm,
      render: renderGroupsTable
    });
  }

  async function refreshDbSchema() {
    var status = $('db-status');
    setStatus(status, 'Загрузка структуры БД...', '');
    try {
      state.dbSchema = await loadDbSchema();
      renderDbSchema(state.dbSchema);
      setStatus(status, 'Структура БД обновлена.', 'ok');
    } catch (err) {
      setStatus(status, err.message || 'Не удалось загрузить структуру БД.', 'error');
    }
  }

  function bindDatabase() {
    var btn = $('btn-db-refresh');
    if (btn) {
      btn.addEventListener('click', refreshDbSchema);
    }
  }

  async function refreshAudit() {
    var status = $('audit-status');
    setStatus(status, 'Загрузка аудита...', '');
    try {
      state.audit = await loadAuditFromServer();
      renderAuditTable();
      setStatus(status, 'Аудит обновлён.', 'ok');
    } catch (err) {
      setStatus(status, err.message || 'Не удалось загрузить аудит.', 'error');
    }
  }

  function bindAudit() {
    var btn = $('btn-audit-refresh');
    if (btn) {
      btn.addEventListener('click', refreshAudit);
    }
  }

  function refreshUi() {
    var user = currentUser();
    var info = $('admin-user-info');
    if (info && user) {
      info.textContent = user.name + ' (' + roleLabel(user.role) + ')';
    }
    renderEventsTable();
    renderUsersTable();
    renderSourcesTable();
    renderMediaTable();
    renderTagsTable();
    renderGroupsTable();
    renderAuditTable();
    renderEventReferenceOptions();
    clearEventForm();
    clearSourceForm();
    clearMediaForm();
    clearTagForm();
    clearGroupForm();
    setUsersPanelAccess();
  }

  async function init() {
    bindTabs();
    bindPasswordToggle();
    bindLogin();
    bindLogout();
    bindEvents();
    bindDateLogicEvents();
    bindUsers();
    bindReferences();
    bindEventMedia();
    bindEventSources();
    bindEventTags();
    bindEventGroups();
    bindAudit();
    bindDatabase();

    state.currentUser = await loadSessionFromServer().catch(function () { return null; });
    if (state.currentUser) {
      await initData();
      showApp(true);
      refreshUi();
      return;
    }
    showApp(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
