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

  async function request(path, { signed = false, method = 'GET' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const headers = { Accept: 'application/json' };
    if (signed && initData()) headers['X-Telegram-Init-Data'] = initData();
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(API + path, {
        method, headers, signal: controller.signal, cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer',
        ...(method === 'POST' ? { body: '{}' } : {})
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
    actions.append(action, externalAction, bot);
    const message = element('p', 'card-message');
    message.id = `message-${event.id}`;
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    action.setAttribute('aria-describedby', message.id);
    card.append(top, meta, description, places, roster, actions, message);
    const record = { event, viewer: null, revision: 0, pending: false, checking: false,
      message: '', messageError: false, rosterKey: null,
      nodes: { card, permalink, badge, values, description, places, roster, summary, people, noPeople, action, externalAction, bot, message } };
    action.addEventListener('click', () => act(record));
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
    setText(n.values[2], event.price || 'Уточняйте у организатора');
    setText(n.values[3], `${event.participant_count} из ${event.capacity}`);
    setText(n.description, event.description);
    n.description.hidden = !event.description;
    setText(n.places, cancelled ? 'Игра отменена организатором.' : `Свободных мест: ${event.free_places}`);
    setText(n.summary, `Участники · ${event.participant_count}`);
    // Keep the native details node and its open state, even after own mutations.
    const rosterKey = JSON.stringify(event.participants);
    if (record.rosterKey !== rosterKey) {
      n.people.replaceChildren(...event.participants.map(person => element('li', '', person.name)));
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
    const anchor = Array.from(list.children).find(card => card.getBoundingClientRect().bottom > 0);
    const top = anchor?.getBoundingClientRect().top;
    const active = document.activeElement;
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
  refresh().then(() => followTarget());
})();
