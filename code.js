'use strict';

(() => {
  const API = 'https://tours.multirate.cc/pickleball/api';
  const BOT = 'https://t.me/PickleballGame';
  const VALID_ID = /^[a-f0-9]{32}$/;
  const records = new Map();
  const list = document.getElementById('events');
  const status = document.getElementById('status');
  const refreshButton = document.getElementById('refresh');
  const moreButton = document.getElementById('load-more');
  const loadStatus = document.getElementById('load-status');
  const targetStatus = document.getElementById('target-status');
  let nextCursor = null;
  const consumedCursors = new Set();
  let initialized = false;
  let refreshing = false;
  let loadingMore = false;
  let lastTarget = null;
  let targetSequence = 0;
  let hadListError = false;

  // Only the backend can authenticate initData. No initDataUnsafe, names or IDs
  // supplied by the client are ever used as identity or authorization.
  function initData() {
    const value = window.Telegram?.WebApp?.initData;
    return typeof value === 'string' ? value : '';
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  function showStatus(message, error = false) {
    setText(status, message);
    status.classList.toggle('error', error);
  }

  async function request(path, { signed = false, method = 'GET', body = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const headers = { Accept: 'application/json' };
    if (signed && initData()) headers['X-Telegram-Init-Data'] = initData();
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(API + path, {
        method, headers, signal: controller.signal, cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer',
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
      });
      let data;
      try { data = await response.json(); } catch {
        throw new Error('Сервис вернул некорректный ответ. Попробуйте обновить страницу.');
      }
      if (!response.ok) {
        throw new Error(typeof data?.message === 'string' ? data.message : 'Не удалось выполнить запрос. Попробуйте ещё раз.');
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Сервис не ответил вовремя. Попробуйте ещё раз.');
      if (error instanceof TypeError) throw new Error('Нет связи с сервисом. Проверьте подключение и попробуйте ещё раз.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  function validateEvent(event) {
    const valid = event && typeof event.id === 'string' && VALID_ID.test(event.id) &&
      ['title', 'starts_at', 'timezone', 'venue', 'price', 'description', 'created_at', 'updated_at'].every(key => typeof event[key] === 'string') &&
      ['starts_at', 'created_at', 'updated_at'].every(key => Number.isFinite(Date.parse(event[key]))) &&
      event.timezone === 'Europe/Moscow' && ['open', 'cancelled'].includes(event.status) &&
      ['capacity', 'participant_count', 'free_places'].every(key => Number.isInteger(event[key]) && event[key] >= 0) &&
      Array.isArray(event.participants) && event.participants.every(person => person && typeof person.name === 'string');
    if (!valid) throw new Error('Не удалось прочитать данные игры. Попробуйте обновить страницу.');
    return event;
  }

  function validateDetail(data, id) {
    validateEvent(data?.event);
    if (data.event.id !== id || !data.viewer || !['authenticated', 'registered', 'is_organizer'].every(key => typeof data.viewer[key] === 'boolean')) {
      throw new Error('Не удалось прочитать состояние записи. Обновите игру.');
    }
    return data;
  }

  function validatePage(data) {
    if (!data || !Array.isArray(data.events) || !(data.next_cursor === null || typeof data.next_cursor === 'string')) {
      throw new Error('Не удалось прочитать список игр. Попробуйте ещё раз.');
    }
    data.events.forEach(validateEvent);
    return data;
  }

  function botLink(id) { return `${BOT}?start=event_${id}`; }

  function createCard(event) {
    const card = element('article', 'event-card');
    card.id = `event-${event.id}`;
    const top = element('div', 'card-top');
    const heading = element('h3');
    const permalink = element('a', 'title-link');
    permalink.href = `#event-${event.id}`;
    permalink.addEventListener('click', click => {
      if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
      click.preventDefault();
      const url = new URL(window.location.href);
      if (url.searchParams.has('event')) url.searchParams.set('event', event.id);
      url.hash = `event-${event.id}`;
      window.history.pushState(null, '', url);
      followTarget(true);
    });
    heading.append(permalink);
    const badge = element('span', 'badge');
    top.append(heading, badge);
    const meta = element('dl', 'meta');
    const values = ['Когда', 'Где', 'Стоимость', 'Места'].map(label => {
      const group = element('div');
      const value = element('dd');
      group.append(element('dt', '', label), value);
      meta.append(group);
      return value;
    });
    const description = element('p', 'description');
    const places = element('p', 'places');
    const roster = element('details', 'roster');
    const summary = element('summary');
    const people = element('ul');
    const noPeople = element('p', 'roster-empty', 'Пока никто не записался.');
    roster.append(summary, people, noPeople);
    const actions = element('div', 'actions');
    const action = element('button', 'primary');
    action.type = 'button';
    const externalAction = element('a', 'primary', 'Записаться через Telegram ↗');
    externalAction.href = botLink(event.id);
    externalAction.target = '_blank';
    externalAction.rel = 'noopener noreferrer';
    const bot = element('a', 'bot-link', 'Открыть в боте ↗');
    bot.href = botLink(event.id);
    bot.target = '_blank';
    bot.rel = 'noopener noreferrer';
    const edit = element('button', 'quiet edit-event', 'Редактировать');
    edit.type = 'button';
    edit.hidden = true;
    actions.append(action, externalAction, bot, edit);
    const organizer = element('div', 'organizer');
    const ending = element('p', 'event-end');
    const message = element('p', 'card-message');
    message.id = `message-${event.id}`;
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    action.setAttribute('aria-describedby', message.id);
    card.append(top, meta, ending, organizer, description, places, roster, actions, message);
    const record = { event, viewer: null, revision: 0, pending: false, checking: false,
      message: '', messageError: false, rosterKey: null,
      nodes: { card, permalink, badge, values, description, places, roster, summary, people, noPeople, action, externalAction, bot, edit, organizer, ending, message } };
    action.addEventListener('click', () => act(record));
    edit.addEventListener('click', () => openEvent(record));
    return record;
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', weekday: 'short'
    }).format(new Date(value)) + ' МСК';
  }

  function render(record) {
    const event = record.event;
    const n = record.nodes;
    const cancelled = event.status === 'cancelled';
    const full = event.free_places === 0;
    const signed = Boolean(initData());
    const authenticated = record.viewer?.authenticated === true;
    const registered = authenticated && record.viewer.registered;
    setText(n.permalink, event.title);
    n.card.classList.toggle('cancelled', cancelled);
    n.card.classList.toggle('full', full);
    setText(n.badge, cancelled ? 'Отменена' : full ? 'Мест нет' : 'Открыта запись');
    setText(n.values[0], formatDate(event.starts_at));
    setText(n.values[1], event.venue);
    setText(n.values[2], (event.price || 'Уточняйте у организатора') + (Object.hasOwn(CURRENCIES, event.currency) ? ` · ${CURRENCIES[event.currency]} ${event.currency}` : ''));
    const end = typeof event.ends_at === 'string' && Number.isFinite(Date.parse(event.ends_at)) ? formatDate(event.ends_at) : '';
    setText(n.ending, [Number.isInteger(event.duration_minutes) ? `${event.duration_minutes} мин` : '', end ? `Окончание: ${end}` : ''].filter(Boolean).join(' · '));
    n.ending.hidden = !n.ending.textContent;
    const organizerKey = JSON.stringify(event.organizer || null);
    if (record.organizerKey !== organizerKey) {
      n.organizer.replaceChildren();
      if (event.organizer) n.organizer.append(element('p', 'profile-meta', 'Организатор'), profileNode(event.organizer));
      record.organizerKey = organizerKey;
    }
    n.organizer.hidden = !event.organizer;
    n.edit.hidden = !(meState?.is_organizer && record.viewer?.authenticated && record.viewer?.is_organizer);
    setText(n.values[3], `${event.participant_count} из ${event.capacity}`);
    setText(n.description, event.description);
    n.description.hidden = !event.description;
    setText(n.places, cancelled ? 'Игра отменена организатором.' : `Свободных мест: ${event.free_places}`);
    setText(n.summary, `Участники · ${event.participant_count}`);
    // Keep the native details node and its open state, even after own mutations.
    const rosterKey = JSON.stringify(event.participants);
    if (record.rosterKey !== rosterKey) {
      n.people.replaceChildren(...event.participants.map(person => {
        const item = element('li', '', person.name);
        const profile = person.profile || person;
        if (profile.dupr_id || profile.username) item.append(profileNode(profile, false));
        return item;
      }));
      record.rosterKey = rosterKey;
    }
    n.people.hidden = !event.participants.length;
    n.noPeople.hidden = Boolean(event.participants.length);
    n.action.hidden = !signed && !cancelled && !full;
    n.externalAction.hidden = signed || cancelled || full;
    n.bot.hidden = !signed && !cancelled && !full;
    n.action.disabled = record.pending || record.checking || (!registered && (cancelled || full));
    n.action.setAttribute('aria-busy', String(record.pending || record.checking));
    let label;
    if (record.pending) label = 'Сохраняем…';
    else if (registered) label = 'Отменить участие';
    else if (cancelled) label = 'Игра отменена';
    else if (full) label = 'Все места заняты';
    else if (record.checking) label = 'Проверяем запись…';
    else if (!record.viewer && signed) label = 'Проверить запись';
    else if (!authenticated && signed) label = 'Открыть запись в боте';
    else label = 'Записаться';
    setText(n.action, label);
    setText(n.message, record.message);
    n.message.hidden = !record.message;
    n.message.classList.toggle('error', record.messageError);
  }

  // Updates are in place: no replacement of the list, focused controls or details.
  // If a new announcement is inserted above the viewport, retain the visible card.
  function preservePosition(update) {
    const active = document.activeElement;
    const anchor = active?.closest('.form-panel') ? null : Array.from(list.children).find(card => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });
    const top = anchor?.getBoundingClientRect().top;
    update();
    if (active && active !== document.body && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
    if (anchor?.isConnected && window.scrollY > 0) {
      const delta = anchor.getBoundingClientRect().top - top;
      if (Math.abs(delta) > 1) window.scrollBy(0, delta);
    }
  }

  function sortCards() {
    const ordered = Array.from(records.values()).sort((a, b) =>
      Date.parse(b.event.created_at) - Date.parse(a.event.created_at) || b.event.id.localeCompare(a.event.id));
    ordered.forEach((record, index) => {
      const current = list.children[index];
      if (current !== record.nodes.card) list.insertBefore(record.nodes.card, current || null);
    });
  }

  function merge(event, viewer, revisions) {
    let record = records.get(event.id);
    if (record && (record.pending || (revisions && record.revision !== (revisions.get(event.id) ?? 0)))) return record;
    if (!record) {
      record = createCard(event);
      records.set(event.id, record);
    } else if (Date.parse(event.updated_at) < Date.parse(record.event.updated_at)) {
      return record;
    }
    record.event = event;
    // Public list responses deliberately never replace personal viewer state.
    if (viewer !== undefined) record.viewer = viewer;
    render(record);
    return record;
  }

  function updateEmpty() {
    document.getElementById('empty').hidden = !initialized || records.size > 0 || hadListError;
    document.getElementById('unavailable').hidden = !hadListError || records.size > 0;
    moreButton.hidden = nextCursor === null;
  }

  async function getDetail(id, { silent = false } = {}) {
    const record = records.get(id);
    if (record?.pending || record?.checking) return false;
    const revisions = new Map([[id, record?.revision ?? 0]]);
    if (record && !silent) { record.checking = true; render(record); }
    try {
      const data = validateDetail(await request(`/events/${id}`, { signed: true }), id);
      preservePosition(() => { merge(data.event, data.viewer, revisions); sortCards(); });
      updateEmpty();
      return true;
    } catch (error) {
      if (record && !silent) {
        record.message = error.message;
        record.messageError = true;
        render(record);
      }
      if (!silent) throw error;
      return false;
    } finally {
      if (record && !silent) { record.checking = false; render(record); }
    }
  }

  async function detailBatch(ids) {
    let failures = 0;
    const queue = [...ids];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift();
        if (!await getDetail(id, { silent: true })) failures += 1;
      }
    }));
    return failures;
  }

  async function refresh() {
    if (refreshing || loadingMore) return;
    refreshing = true;
    refreshButton.disabled = true;
    moreButton.disabled = true;
    list.setAttribute('aria-busy', 'true');
    const revisions = new Map(Array.from(records, ([id, record]) => [id, record.revision]));
    try {
      const data = validatePage(await request('/events?limit=20'));
      preservePosition(() => {
        data.events.forEach(event => merge(event, undefined, revisions));
        sortCards();
      });
      // Do not reset an archive cursor on a first-page refresh, or remove older
      // cards. A keyset cursor continues from the user's last loaded page.
      if (!initialized) nextCursor = data.next_cursor;
      else if (nextCursor === null && data.next_cursor !== null && !consumedCursors.has(data.next_cursor)) nextCursor = data.next_cursor;
      initialized = true;
      hadListError = false;
      updateEmpty();
      const firstIds = new Set(data.events.map(event => event.id));
      const ids = Array.from(records.keys()).filter(id => initData() || !firstIds.has(id));
      const failures = await detailBatch(ids);
      showStatus(failures ? 'Список обновлён, но не все игры удалось проверить. Повторите обновление.' :
        'Актуальные данные · обновляем каждые 10 секунд, пока страница открыта', Boolean(failures));
    } catch (error) {
      hadListError = true;
      showStatus(`${error.message}${records.size ? ' Показаны последние загруженные данные.' : ''}`, true);
      updateEmpty();
    } finally {
      refreshing = false;
      refreshButton.disabled = false;
      moreButton.disabled = false;
      list.setAttribute('aria-busy', 'false');
    }
  }

  async function loadMore() {
    if (loadingMore || refreshing || nextCursor === null) return;
    loadingMore = true;
    moreButton.disabled = true;
    setText(moreButton, 'Загружаем…');
    setText(loadStatus, '');
    const cursor = nextCursor;
    const revisions = new Map(Array.from(records, ([id, record]) => [id, record.revision]));
    try {
      const data = validatePage(await request(`/events?limit=20&cursor=${encodeURIComponent(cursor)}`));
      if (data.next_cursor === cursor) throw new Error('Сервис повторил страницу. Попробуйте позже.');
      preservePosition(() => { data.events.forEach(event => merge(event, undefined, revisions)); sortCards(); });
      consumedCursors.add(cursor);
      nextCursor = data.next_cursor;
      updateEmpty();
      if (initData()) await detailBatch(data.events.map(event => event.id));
    } catch (error) { setText(loadStatus, error.message); }
    finally {
      loadingMore = false;
      moreButton.disabled = false;
      setText(moreButton, 'Показать ещё');
    }
  }

  async function act(record) {
    if (record.pending || record.checking) return;
    if (!initData()) { window.open(botLink(record.event.id), '_blank', 'noopener,noreferrer'); return; }
    if (!record.viewer) {
      try { await getDetail(record.event.id); } catch { /* Visible per-card error. */ }
      return;
    }
    if (!record.viewer.authenticated) {
      window.open(botLink(record.event.id), '_blank', 'noopener,noreferrer');
      return;
    }
    const registered = record.viewer.registered;
    if (!registered && (record.event.status === 'cancelled' || record.event.free_places === 0)) return;
    const actionHadFocus = document.activeElement === record.nodes.action;
    record.pending = true;
    record.revision += 1;
    record.message = '';
    record.messageError = false;
    render(record);
    try {
      const id = record.event.id;
      const data = validateDetail(await request(`/events/${id}/${registered ? 'leave' : 'join'}`, { signed: true, method: 'POST' }), id);
      // Only a persisted, server-returned state may change counts or membership.
      if (!data.viewer.authenticated) throw new Error('Telegram не подтвердил вход. Откройте игру заново из бота.');
      preservePosition(() => {
        record.event = data.event;
        record.viewer = data.viewer;
        record.message = data.viewer.registered ? 'Вы записаны на игру.' : 'Вы не записаны на эту игру.';
        render(record);
      });
    } catch (error) {
      record.message = `${error.message} Изменение не подтверждено. Обновите данные перед повторной попыткой.`;
      record.messageError = true;
    } finally {
      record.pending = false;
      record.revision += 1;
      render(record);
      if (actionHadFocus && document.activeElement === document.body && !record.nodes.action.disabled && !record.nodes.action.hidden) {
        record.nodes.action.focus({ preventScroll: true });
      }
    }
  }

  function targetId() {
    const query = new URLSearchParams(window.location.search);
    // An explicit event anchor wins; Telegram's own SDK fragment is ignored.
    if (window.location.hash.startsWith('#event-')) return window.location.hash.slice(7);
    if (query.has('event')) return query.get('event');
    return null;
  }

  async function followTarget(force = false) {
    const id = targetId();
    const sequence = ++targetSequence;
    if (window.location.hash === '#profile') {
      targetStatus.hidden = true;
      lastTarget = null;
      await authReady;
      // A slower /me must not reopen a route the user has already left.
      if (sequence === targetSequence && window.location.hash === '#profile') await openProfile();
      return;
    }
    if (id === null) { targetStatus.hidden = true; lastTarget = null; return; }
    if (!VALID_ID.test(id)) {
      setText(targetStatus, 'Некорректная ссылка на игру. Идентификатор должен состоять из 32 строчных шестнадцатеричных символов.');
      targetStatus.hidden = false;
      return;
    }
    if (id === lastTarget && !force) return;
    targetStatus.hidden = true;
    try {
      // Fetch this exact ID even when it is not in the first page or archive.
      await getDetail(id);
      if (sequence !== targetSequence) return;
      const record = records.get(id);
      if (!record) return;
      record.nodes.roster.open = true;
      record.nodes.card.scrollIntoView({ block: 'start', behavior: 'instant' });
      lastTarget = id;
    } catch (error) {
      if (sequence !== targetSequence) return;
      setText(targetStatus, `Не удалось открыть игру по ссылке: ${error.message}`);
      targetStatus.hidden = false;
    }
  }

  // Profile and event editors are deliberately outside the live list renderer.
  // A poll can update cards, never the user's draft or its captured edit base.
  const CURRENCIES = Object.freeze({ RUB: '₽', EUR: '€', USD: '$', TRY: '₺', GBP: '£', CNY: '¥', AED: 'د.إ' });
  const DUPR_ID = /^[A-Z0-9]{6}$/;
  const $ = id => document.getElementById(id);
  const profileForm = $('profile-form');
  const eventForm = $('event-form');
  const search = $('player-search');
  const results = $('player-results');
  const duprInput = $('dupr-id');
  let meState = null;
  let profilePending = false;
  let searchSequence = 0;
  let searchTimer;
  let suggestions = [];
  let activeOption = -1;
  let editor = null;
  let eventPending = false;

  function externalLink(href, label) {
    const link = element('a', '', label);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function profileNode(profile, includeName = true, links = true) {
    const node = element('div', 'person-profile');
    const text = value => typeof value === 'string' ? value : '';
    if (includeName) {
      node.append(element('span', '', [text(profile.name_ru), text(profile.name)].filter(Boolean).join(' · ')));
    }
    if (links && typeof profile.username === 'string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(profile.username)) {
      node.append(document.createTextNode(' '), externalLink(`https://t.me/${profile.username}`, `@${profile.username}`));
    }
    if (typeof profile.dupr_id === 'string' && DUPR_ID.test(profile.dupr_id)) {
      const catalogName = [text(profile.dupr_name_ru), text(profile.dupr_name)].filter(Boolean).join(' · ');
      if (catalogName) node.append(element('div', '', catalogName));
      node.append(document.createTextNode(`\nDUPR ${profile.dupr_id}${links ? ' · ' : ''}`));
      const url = profile.dupr_profile_url;
      if (links && typeof url === 'string' && /^https:\/\/dashboard\.dupr\.com\/dashboard\/player\/[0-9]+$/.test(url)) {
        node.append(externalLink(url, 'Профиль DUPR ↗'));
      } else if (links) node.append(document.createTextNode('ссылка неизвестна'));
      const rating = value => typeof value === 'string' && /^\d+\.\d{3}$/.test(value) ? value : 'неизвестно';
      node.append(element('div', '', `Doubles: ${rating(profile.doubles)} · Singles: ${rating(profile.singles)}`));
      const source = text(profile.ratings_source);
      const date = text(profile.ratings_as_of);
      node.append(element('div', 'profile-meta', `Источник рейтингов: ${source || 'неизвестно'} · Снимок каталога: ${date || 'дата неизвестна'}. Не live-рейтинг DUPR.`));
    }
    return node;
  }

  function formMessage(id, text, error = false) {
    setText($(id), text);
    $(id).classList.toggle('error', error);
  }

  function validateMe(data) {
    if (!data || typeof data.is_organizer !== 'boolean' || !data.telegram || typeof data.telegram.name !== 'string' ||
        !(data.profile === null || (data.profile && typeof data.profile.dupr_id === 'string' && DUPR_ID.test(data.profile.dupr_id)))) {
      throw new Error('Не удалось проверить профиль. Откройте приложение заново из бота.');
    }
    return data;
  }

  function applyMe(data) {
    meState = validateMe(data);
    $('create-event').hidden = !meState.is_organizer;
    records.forEach(render);
  }

  const authReady = (async () => {
    if (!initData()) return;
    try { applyMe(await request('/me', { signed: true })); }
    catch {
      meState = null;
      $('auth-help').hidden = false;
    }
  })();

  function closeResults() {
    results.hidden = true;
    search.setAttribute('aria-expanded', 'false');
    search.removeAttribute('aria-activedescendant');
    activeOption = -1;
  }

  function invalidateSearch() {
    clearTimeout(searchTimer);
    searchSequence += 1;
    closeResults();
  }

  async function openProfile() {
    await authReady;
    if (!initData() || !meState) { $('auth-help').hidden = false; return; }
    if (profilePending) return;
    profileForm.hidden = false;
    $('auth-help').hidden = true;
    // Opening a second time must not erase a draft.
    if (!profileForm.dataset.opened) {
      duprInput.value = meState.profile?.dupr_id || '';
      $('profile-preview').replaceChildren(...(meState.profile ? [profileNode(meState.profile)] : []));
      profileForm.dataset.opened = 'true';
    }
    profileForm.scrollIntoView({ block: 'start' });
    search.focus({ preventScroll: true });
  }

  function choosePlayer(index) {
    const player = suggestions[index];
    if (!player) return;
    invalidateSearch();
    duprInput.value = player.dupr_id;
    $('profile-preview').replaceChildren(profileNode(player));
    formMessage('profile-message', 'Выбран профиль из каталога. Привязка ещё не сохранена.');
    search.focus({ preventScroll: true });
  }

  search.addEventListener('input', () => {
    invalidateSearch();
    const q = search.value.trim();
    suggestions = [];
    results.replaceChildren();
    if (q.length < 2) {
      setText($('search-message'), 'Введите от двух букв или точный DUPR ID. Ручной ввод ID доступен всегда.');
      return;
    }
    const sequence = searchSequence;
    setText($('search-message'), 'Ищем в каталоге…');
    searchTimer = setTimeout(async () => {
      try {
        const data = await request(`/players?q=${encodeURIComponent(q)}`);
        if (sequence !== searchSequence) return;
        if (!Array.isArray(data?.players)) throw new Error('Некорректный каталог');
        suggestions = data.players.filter(player => player && typeof player.name === 'string' &&
          typeof player.dupr_id === 'string' && DUPR_ID.test(player.dupr_id)).slice(0, 15);
        results.replaceChildren(...suggestions.map((player, index) => {
          const option = element('li');
          option.id = `player-option-${index}`;
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', 'false');
          option.append(profileNode(player, true, false));
          option.addEventListener('pointerdown', click => click.preventDefault());
          option.addEventListener('click', () => choosePlayer(index));
          return option;
        }));
        results.hidden = !suggestions.length;
        search.setAttribute('aria-expanded', String(Boolean(suggestions.length)));
        setText($('search-message'), suggestions.length ? `Найдено: ${suggestions.length}. Снимок каталога: ${typeof data.as_of === 'string' ? data.as_of : 'дата неизвестна'}${data.stale ? ' · сохранённая копия' : ''}. Выберите игрока или введите ID вручную.` : 'Не найдено. Введите точный DUPR ID вручную.');
      } catch {
        if (sequence !== searchSequence) return;
        closeResults();
        setText($('search-message'), 'Поиск недоступен. Введите точный DUPR ID вручную.');
      }
    }, 250);
  });

  search.addEventListener('keydown', key => {
    if (key.key === 'Escape') { invalidateSearch(); key.preventDefault(); return; }
    if (key.key === 'Enter') {
      key.preventDefault(); // Searching must never submit a proposed profile binding.
      if (!results.hidden && activeOption >= 0) choosePlayer(activeOption);
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(key.key) || results.hidden || !suggestions.length) return;
    key.preventDefault();
    activeOption = activeOption < 0 ? (key.key === 'ArrowDown' ? 0 : suggestions.length - 1) :
      (activeOption + (key.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
    Array.from(results.children).forEach((option, index) => option.setAttribute('aria-selected', String(index === activeOption)));
    search.setAttribute('aria-activedescendant', `player-option-${activeOption}`);
    results.children[activeOption].scrollIntoView({ block: 'nearest' });
  });
  search.addEventListener('blur', invalidateSearch);
  duprInput.addEventListener('input', () => {
    invalidateSearch();
    $('profile-preview').replaceChildren();
    formMessage('profile-message', 'ID изменён. Для привязки нажмите «Сохранить профиль».');
  });
  $('profile-open').addEventListener('click', openProfile);
  $('profile-close').addEventListener('click', () => {
    if (!profilePending) { profileForm.hidden = true; invalidateSearch(); }
  });

  function setFormPending(form, pending) {
    form.setAttribute('aria-busy', String(pending));
    form.querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = pending; });
  }

  profileForm.addEventListener('submit', async submit => {
    submit.preventDefault();
    if (profilePending || !initData() || !meState) return;
    if (!DUPR_ID.test(duprInput.value)) {
      formMessage('profile-message', 'Введите точный ID: шесть заглавных латинских букв или цифр, без пробелов.', true);
      return;
    }
    const id = duprInput.value;
    invalidateSearch();
    profilePending = true;
    setFormPending(profileForm, true);
    formMessage('profile-message', 'Сохраняем профиль…');
    try {
      const data = validateMe(await request('/profile', { signed: true, method: 'POST', body: { dupr_id: id } }));
      if (data.profile?.dupr_id !== id) throw new Error('Сохранение профиля не подтверждено. Откройте профиль заново.');
      applyMe(data);
      $('profile-preview').replaceChildren(profileNode(data.profile));
      formMessage('profile-message', 'Профиль сохранён. DUPR ID указан вами, владение аккаунтом не проверено.');
      refresh();
    } catch (error) { formMessage('profile-message', `${error.message} Сохранение не подтверждено.`, true); }
    finally { profilePending = false; setFormPending(profileForm, false); }
  });

  const EVENT_INPUTS = Object.freeze({ title: 'event-title', venue: 'event-venue', capacity: 'event-capacity',
    price: 'event-price', description: 'event-description', duration_minutes: 'event-duration', currency: 'event-currency' });

  function matchesCreatedFields(event, fields) {
    return Object.entries(fields).every(([key, value]) => {
      if (key === 'starts_at') return Date.parse(event[key]) === Date.parse(value);
      // Match the service's Python str.strip(), including Unicode whitespace.
      if (['title', 'venue', 'price', 'description'].includes(key)) {
        value = value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
      }
      return event[key] === value;
    });
  }

  function randomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function fillEvent(event) {
    Object.entries(EVENT_INPUTS).forEach(([key, id]) => { $(id).value = event?.[key] ?? ''; });
    // Format only for display. Never round-trip this minute-level representation
    // unless the user actually changes the date/time controls.
    const parts = event ? Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(event.starts_at)).map(part => [part.type, part.value])) : null;
    $('event-date').value = parts ? `${parts.year}-${parts.month}-${parts.day}` : '';
    $('event-time').value = parts ? `${parts.hour}:${parts.minute}` : '';
    $('event-duration').required = !event;
    $('event-currency').required = !event;
    editor = { id: event?.id || randomId(), original: event ? structuredClone(event) : null,
      initial: Object.fromEntries(Object.entries(EVENT_INPUTS).map(([key, id]) => [key, $(id).value])),
      date: $('event-date').value, time: $('event-time').value, operation: null, fingerprint: null };
  }

  async function openEvent(record = null) {
    await authReady;
    if (eventPending || !initData() || !meState?.is_organizer) return;
    if (record && !(record.viewer?.authenticated && record.viewer?.is_organizer)) return;
    if (!record && !meState.profile) {
      await openProfile();
      formMessage('profile-message', 'Сначала сохраните свой профиль с DUPR ID.');
      return;
    }
    fillEvent(record?.event);
    setText($('event-heading'), record ? 'Редактировать игру' : 'Создать игру');
    formMessage('event-message', '');
    eventForm.hidden = false;
    eventForm.scrollIntoView({ block: 'start' });
    $('event-title').focus({ preventScroll: true });
  }
  $('create-event').addEventListener('click', () => openEvent());
  $('event-close').addEventListener('click', () => { if (!eventPending) eventForm.hidden = true; });

  eventForm.addEventListener('submit', async submit => {
    submit.preventDefault();
    if (eventPending || !editor || !initData() || !meState?.is_organizer) return;
    const fields = {};
    const base = {};
    try {
      for (const [key, id] of Object.entries(EVENT_INPUTS)) {
        const value = $(id).value;
        if (editor.original && value === editor.initial[key]) continue;
        if (['duration_minutes', 'capacity'].includes(key)) {
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || (key === 'duration_minutes' && Number(value) > 1440)) {
            throw new Error('Укажите целое положительное количество мест и длительность от 1 до 1440 минут.');
          }
          fields[key] = Number(value);
        } else {
          if (key === 'currency' && !Object.hasOwn(CURRENCIES, value)) throw new Error('Выберите валюту.');
          fields[key] = value;
        }
        if (editor.original && fields[key] === editor.original[key]) { delete fields[key]; continue; }
        if (editor.original) base[key] = editor.original[key] ?? null;
      }
      if (!editor.original || $('event-date').value !== editor.date || $('event-time').value !== editor.time) {
        const timestamp = new Date(`${$('event-date').value}T${$('event-time').value}:00+03:00`);
        if (!Number.isFinite(timestamp.getTime())) throw new Error('Укажите дату и время по Москве.');
        fields.starts_at = timestamp.toISOString();
        if (editor.original) base.starts_at = editor.original.starts_at;
      }
      if (editor.original && !Object.keys(fields).length) { formMessage('event-message', 'Нет изменений для сохранения.'); return; }
      const fingerprint = JSON.stringify({ fields, base });
      if (editor.fingerprint !== fingerprint) { editor.operation = randomId(); editor.fingerprint = fingerprint; }
      const body = editor.original ? { fields, base, operation: editor.operation } : { id: editor.id, fields };
      eventPending = true;
      setFormPending(eventForm, true);
      const record = records.get(editor.id);
      if (record) { record.revision += 1; record.pending = true; render(record); }
      formMessage('event-message', 'Сохраняем игру…');
      try {
        const data = validateDetail(await request(editor.original ? `/events/${editor.id}/edit` : '/events', {
          signed: true, method: 'POST', body
        }), editor.id);
        if (!data.viewer.authenticated || !data.viewer.is_organizer) throw new Error('Сохранение не подтверждено сервером.');
        // Bump the card revision so any older in-flight poll cannot overwrite
        // this server-returned state, including newly created records.
        if (record) record.pending = false;
        const saved = merge(data.event, data.viewer);
        saved.revision += 1;
        sortCards();
        updateEmpty();
        // Create retries return the first persisted record, not necessarily
        // this submission. Expose that card, but never replace a changed draft.
        if (!editor.original && !matchesCreatedFields(data.event, fields)) {
          throw new Error('Конфликт: игра уже создана с другими данными. Ваш черновик оставлен в форме. Скопируйте нужные изменения, откройте «Редактировать» в сохранённой карточке ниже и внесите их заново.');
        }
        fillEvent(data.event);
        setText($('event-heading'), 'Редактировать игру');
        formMessage('event-message', 'Игра сохранена.');
      } finally {
        if (record) { record.pending = false; record.revision += 1; render(record); }
      }
    } catch (error) { formMessage('event-message', `${error.message} Изменение не подтверждено.`, true); }
    finally { eventPending = false; setFormPending(eventForm, false); }
  });

  const miniApp = window.Telegram?.WebApp;
  if (initData()) {
    setText(document.getElementById('auth-notice'), 'Запись и отмена участия доступны здесь после проверки Telegram на сервере. Состояние кнопки и список участников меняются только после сохранения.');
    try { miniApp.ready(); } catch { /* SDK availability must not block public reading. */ }
  }
  refreshButton.addEventListener('click', async () => {
    await refresh();
    if (!targetStatus.hidden) await followTarget(true);
  });
  moreButton.addEventListener('click', loadMore);
  window.addEventListener('hashchange', () => followTarget());
  window.addEventListener('popstate', () => followTarget());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  // Profile entry waits for /me, not the independent public event-list request.
  if (window.location.hash === '#profile') followTarget();
  refresh().then(() => { if (window.location.hash !== '#profile') followTarget(); });
})();
