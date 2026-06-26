const api = window.GameAPI ? new window.GameAPI() : null;

const GAME_NAME = 'MercaPrecios';
const GAME_ID_FALLBACK = 13;
const USER_KEY = 'mercaprecios_user';
const GAME_ID_KEY = 'mercaprecios_game_id';
const SESSION_KEY = 'mercaprecios_active_room';
const POLL_MS = 1500;

const GAME_MODES = {
  price: {
    id: 'price',
    icon: '🎯',
    title: 'Precio clásico',
    short: 'Precio clásico',
    description: 'Un producto. Adivina su precio exacto.',
    input: 'number',
    numeric: true,
  },
  basket: {
    id: 'basket',
    icon: '🧺',
    title: 'Cesta completa',
    short: 'Cesta completa',
    description: 'Salen 3–5 productos. Adivina el total de la cesta.',
    input: 'number',
    numeric: true,
  },
  versus: {
    id: 'versus',
    icon: '⚖️',
    title: 'Más caro / más barato',
    short: 'Más caro',
    description: 'Aparecen dos productos. Elige cuál cuesta más.',
    input: 'choice',
    numeric: false,
  },
  order: {
    id: 'order',
    icon: '📊',
    title: 'Ordena por precio',
    short: 'Ordenar',
    description: 'Ordena 4 productos de menor a mayor precio.',
    input: 'order',
    numeric: false,
  },
  lightning: {
    id: 'lightning',
    icon: '⚡',
    title: 'Precio relámpago',
    short: 'Relámpago',
    description: '10 productos. Solo 8 segundos por producto.',
    input: 'number',
    numeric: true,
    forceArticles: 10,
    forceSeconds: 8,
  },
};

const DEFAULT_SETTINGS = {
  articles: 8,
  roundSeconds: 45,
  justo: true,
  categories: [],
  mode: 'price',
};

const state = {
  user: null,
  gameId: Number(localStorage.getItem(GAME_ID_KEY) || GAME_ID_FALLBACK),
  room: null,
  playScope: 'multi',
  isSolo: false,
  isHost: false,
  hostId: '',
  players: [],
  settings: { ...DEFAULT_SETTINGS },
  products: [],
  categories: [],
  rounds: [],
  currentRound: 0,
  answers: {},
  scores: {},
  medals: {},
  reveal: null,
  status: 'idle',
  inputDigits: '',
  selectedChoice: '',
  orderSelection: [],
  timerInterval: null,
  pollingTimer: null,
  roundEndsAt: 0,
  lastRenderedRoundKey: '',
  lastRenderedScreen: '',
};

const $ = id => document.getElementById(id);
const sid = () => String(state.user?.id ?? '');
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value || 0)));
const byPrice = value => Number(Number(value || 0).toFixed(2));
const euros = value => `${Number(value || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const escapeHTML = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const initials = name => escapeHTML(String(name || '?').trim()[0]?.toUpperCase() || '?');
const roundMode = round => GAME_MODES[round?.mode || state.settings.mode] || GAME_MODES.price;
const currentRound = () => state.rounds[state.currentRound] || null;

function toast(message, icon = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = `${icon ? `${icon} ` : ''}${message}`;
  el.classList.remove('opacity-0');
  el.classList.add('opacity-100');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.classList.add('opacity-0');
    el.classList.remove('opacity-100');
  }, 2800);
}

function showScreen(name) {
  state.lastRenderedScreen = name;
  document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
  $(`screen-${name}`)?.classList.add('active');
}

function setBusy(button, busy, text = '') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.dataset.originalText || button.textContent;
    button.textContent = text || 'Cargando…';
    button.disabled = true;
    button.classList.add('opacity-60');
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.classList.remove('opacity-60');
  }
}

async function fetchJSON(path) {
  const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`No se pudo cargar ${path}`);
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function normalizeProducts(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.products) ? raw.products : Object.values(raw || {}));
  return list
    .map(item => {
      const price = Number(item.price ?? item.unit_price ?? item.price_instructions?.unit_price ?? item.price_instructions?.bulk_price ?? 0);
      const name = String(item.name ?? item.display_name ?? item.title ?? '').trim();
      if (!name || !Number.isFinite(price) || price <= 0) return null;
      const category = String(item.top_category ?? item.category ?? item.categories?.[0]?.name ?? item.category_path?.split('>')?.[0] ?? 'Mercadona').trim();
      return {
        id: String(item.id ?? item.slug ?? name),
        name,
        price: byPrice(price),
        category,
        categoryPath: String(item.category_path ?? item.categoryPath ?? item.categories?.map?.(cat => cat.name)?.join(' > ') ?? category),
        thumbnail: String(item.thumbnail ?? item.image ?? item.image_url ?? item.photos?.[0]?.regular ?? ''),
        url: String(item.url ?? item.share_url ?? ''),
        color: Array.isArray(item.color) ? item.color : null,
      };
    })
    .filter(Boolean);
}

function normalizeCategories(raw, products = state.products) {
  const explicit = Array.isArray(raw) ? raw : (Array.isArray(raw?.categories) ? raw.categories : []);
  const fromData = explicit.map(cat => ({
    name: String(cat.name ?? cat.title ?? cat.id ?? '').trim(),
    count: Number(cat.count ?? 0),
    color: Array.isArray(cat.color) ? cat.color : null,
  })).filter(cat => cat.name);
  if (fromData.length) return fromData;

  const counts = products.reduce((acc, product) => {
    acc[product.category] = (acc[product.category] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count, color: null }));
}

async function loadCatalog() {
  const status = $('catalog-status');
  if (status) status.textContent = 'Cargando catálogo real de /data/products.json…';
  try {
    const productsRaw = await fetchJSON('data/products.json');
    const products = normalizeProducts(productsRaw);
    if (!products.length) throw new Error('No hay productos válidos.');
    const categoriesRaw = await fetchJSON('data/categories.json').catch(() => null);
    state.products = products;
    state.categories = normalizeCategories(categoriesRaw, products);
    renderCategoryList();
    if (status) status.textContent = `${products.length.toLocaleString('es-ES')} productos reales cargados · ${state.categories.length.toLocaleString('es-ES')} categorías`;
  } catch (error) {
    console.warn(error);
    state.products = [];
    state.categories = [];
    if (status) status.textContent = 'No se ha podido cargar /data/products.json.';
  }
}

function normPlayer(player = {}) {
  const username = String(player.username ?? player.name ?? player.display_name ?? player.user_name ?? '?');
  const id = String(player.id ?? player.user_id ?? player.userId ?? player.uuid ?? username);
  return { id, username };
}

function currentPlayer() {
  return state.user ? { id: sid(), username: state.user.username } : null;
}

function upsertPlayer(player) {
  if (!player) return null;
  const p = normPlayer(player);
  const index = state.players.findIndex(item => String(item.id) === String(p.id));
  if (index >= 0) state.players[index] = { ...state.players[index], ...p };
  else state.players.push(p);
  return p;
}

function normalizeRoom(raw = {}, fallbackCode = '') {
  const room = raw.room ?? raw.data?.room ?? raw;
  const code = String(room.code ?? room.room_code ?? room.roomCode ?? raw.room_code ?? fallbackCode ?? '').toUpperCase();
  return { ...room, code, id: room.id ?? room.room_id ?? raw.room_id ?? null };
}

function extractGameState(roomData = {}) {
  const room = roomData.room ?? roomData;
  const raw = room.game_state ?? room.gameState ?? room.state ?? {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return raw || {};
}

function roomHostId(roomData = {}, fallback = '') {
  const room = roomData.room ?? roomData;
  return String(room.host_id ?? room.hostId ?? room.host?.id ?? fallback ?? '');
}

function normalizeSettings(settings = {}) {
  const modeId = GAME_MODES[settings.mode] ? settings.mode : DEFAULT_SETTINGS.mode;
  const mode = GAME_MODES[modeId];
  const selectedCategories = Array.isArray(settings.categories) ? settings.categories.map(String) : [];
  return {
    articles: mode.forceArticles || clamp(settings.articles ?? settings.rounds ?? DEFAULT_SETTINGS.articles, 3, 30),
    roundSeconds: mode.forceSeconds || clamp(settings.roundSeconds ?? settings.time ?? DEFAULT_SETTINGS.roundSeconds, 5, 180),
    justo: settings.justo ?? settings.priceIsRight ?? DEFAULT_SETTINGS.justo,
    categories: selectedCategories,
    mode: modeId,
  };
}

function serializeGame(extra = {}) {
  return {
    status: extra.status ?? state.status,
    playScope: state.playScope,
    hostId: state.hostId,
    players: state.players,
    settings: state.settings,
    rounds: state.rounds,
    currentRound: state.currentRound,
    answers: state.answers,
    scores: state.scores,
    medals: state.medals,
    reveal: state.reveal,
    roundEndsAt: state.roundEndsAt,
    savedAt: Date.now(),
  };
}

function applyGameState(gameState = {}) {
  if (!gameState || typeof gameState !== 'object') return;
  const localAnswers = state.status === 'playing' && gameState.status === 'playing' && Number(gameState.currentRound) === Number(state.currentRound)
    ? state.answers
    : {};
  state.status = gameState.status ?? state.status;
  state.playScope = gameState.playScope ?? state.playScope;
  state.isSolo = state.playScope === 'solo';
  state.hostId = String(gameState.hostId ?? state.hostId ?? '');
  state.isHost = state.isSolo || (state.hostId ? sid() === state.hostId : state.isHost);
  state.players = (gameState.players ?? state.players ?? []).map(normPlayer);
  state.settings = normalizeSettings(gameState.settings ?? state.settings);
  state.rounds = Array.isArray(gameState.rounds) ? gameState.rounds : normalizeLegacyRounds(gameState.gameProducts ?? []);
  state.currentRound = Number(gameState.currentRound ?? state.currentRound ?? 0);
  state.answers = mergeAnswers(localAnswers, gameState.answers ?? state.answers ?? {});
  state.scores = gameState.scores ?? state.scores ?? {};
  state.medals = gameState.medals ?? state.medals ?? {};
  state.reveal = gameState.reveal ?? state.reveal ?? null;
  state.roundEndsAt = Number(gameState.roundEndsAt ?? state.roundEndsAt ?? 0);
  if (state.user) upsertPlayer(currentPlayer());
}

function normalizeLegacyRounds(products) {
  return normalizeProducts(products).map((product, index) => ({
    id: `legacy-${product.id}-${index}`,
    mode: 'price',
    title: product.name,
    subtitle: product.category,
    products: [product],
    targetPrice: product.price,
  }));
}

function mergeAnswers(localAnswers = {}, incomingAnswers = {}) {
  const merged = { ...(incomingAnswers || {}) };
  Object.entries(localAnswers || {}).forEach(([playerId, answer]) => {
    const id = String(playerId);
    const current = merged[id];
    const incomingAt = Number(answer?.at || 0);
    const currentAt = Number(current?.at || 0);
    if (!current || incomingAt >= currentAt) merged[id] = answer;
  });
  return merged;
}

function selectedCategoryInputs() {
  return [...document.querySelectorAll('#category-list input:checked')];
}

function syncSettingsFromUI() {
  const selected = selectedCategoryInputs().map(input => input.value);
  state.settings = normalizeSettings({
    articles: $('cfg-articles')?.value,
    roundSeconds: $('cfg-time')?.value,
    justo: $('cfg-justo')?.checked,
    categories: selected,
    mode: state.settings.mode,
  });
  applySettingsToUI(state.settings, { skipChecks: true });
  updateCategorySummary();
  updateModeSummary();
  return state.settings;
}

function applySettingsToUI(settings = state.settings, { skipChecks = false } = {}) {
  const normalized = normalizeSettings(settings);
  state.settings = normalized;
  if ($('cfg-articles')) $('cfg-articles').value = normalized.articles;
  if ($('cfg-time')) $('cfg-time').value = normalized.roundSeconds;
  if ($('cfg-justo')) $('cfg-justo').checked = Boolean(normalized.justo);
  if (!skipChecks) {
    document.querySelectorAll('#category-list input').forEach(input => {
      input.checked = normalized.categories.includes(input.value);
    });
  }
  document.querySelectorAll('.mode-card').forEach(card => card.classList.toggle('active', card.dataset.mode === normalized.mode));
  updateCategorySummary();
  updateModeSummary();
}

function updateCategorySummary() {
  const selected = selectedCategoryInputs().map(input => input.value);
  const total = state.categories.length;
  const examples = selected.slice(0, 2).join(' · ');
  if ($('category-summary')) {
    $('category-summary').textContent = selected.length === 0
      ? `Se usarán todas las categorías (${total}).`
      : `Solo saldrán productos de ${examples}${selected.length > 2 ? ` y ${selected.length - 2} más` : ''}.`;
  }
}

function updateModeSummary() {
  const mode = GAME_MODES[state.settings.mode] || GAME_MODES.price;
  if ($('mode-summary')) $('mode-summary').textContent = mode.description;
}

function renderModeList() {
  const root = $('mode-list');
  if (!root) return;
  root.innerHTML = Object.values(GAME_MODES).map(mode => `
    <button type="button" data-mode="${mode.id}" onclick="App.selectMode('${mode.id}')" class="mode-card text-left rounded-2xl p-4 ${mode.id === state.settings.mode ? 'active' : ''}">
      <div class="flex items-start gap-3">
        <span class="text-3xl">${mode.icon}</span>
        <span class="min-w-0">
          <span class="block font-black">${escapeHTML(mode.title)}</span>
          <span class="block text-xs text-emerald-100/48 mt-1">${escapeHTML(mode.description)}</span>
        </span>
      </div>
    </button>
  `).join('');
}

function renderCategoryList() {
  const root = $('category-list');
  if (!root) return;
  root.innerHTML = state.categories.map(category => {
    const rgba = Array.isArray(category.color) ? `rgba(${category.color[0]},${category.color[1]},${category.color[2]},.16)` : 'rgba(255,255,255,.055)';
    return `<label class="category-pill cursor-pointer rounded-2xl border border-white/10 px-3 py-2.5 text-xs font-bold text-emerald-100/75 transition" style="background:${rgba}" data-category-name="${escapeHTML(category.name).toLowerCase()}">
      <input type="checkbox" class="sr-only" value="${escapeHTML(category.name)}" />
      <span class="category-check w-5 h-5 rounded-full bg-white/10 flex items-center justify-center text-[11px] font-black flex-shrink-0">✓</span>
      <span class="min-w-0 flex-1 truncate">${escapeHTML(category.name)}</span>
      <span class="opacity-45 text-[11px]">${Number(category.count || 0) || ''}</span>
    </label>`;
  }).join('');
  updateCategorySummary();
}

function playerAvatar(player) {
  const colors = ['from-emerald-400 to-green-700', 'from-yellow-300 to-orange-600', 'from-cyan-300 to-blue-700', 'from-fuchsia-400 to-purple-700', 'from-rose-400 to-red-700', 'from-lime-300 to-emerald-700'];
  const hash = String(player.username || '?').split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return `<span class="w-10 h-10 rounded-2xl bg-gradient-to-br ${colors[hash % colors.length]} flex items-center justify-center font-black shadow-lg shadow-black/20">${initials(player.username)}</span>`;
}

function saveActiveSession() {
  if (!state.user || !state.room?.code || state.isSolo) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: state.room.code, userId: sid(), isHost: state.isHost, hostId: state.hostId, savedAt: Date.now() }));
}

function clearActiveSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function ensureGameId() {
  if (!api) return GAME_ID_FALLBACK;
  const saved = Number(localStorage.getItem(GAME_ID_KEY) || 0);
  if (saved > 0) {
    state.gameId = saved;
    return saved;
  }
  try {
    const result = await api.createGame(GAME_NAME, 16, DEFAULT_SETTINGS);
    const id = Number(result.game_id ?? result.id ?? result.game?.id ?? 0);
    if (id > 0) {
      state.gameId = id;
      localStorage.setItem(GAME_ID_KEY, String(id));
      return id;
    }
  } catch (error) {
    console.warn('No se pudo crear el juego. Se usará el ID de reserva.', error);
  }
  state.gameId = GAME_ID_FALLBACK;
  return state.gameId;
}

async function prepareUser({ allowFallback = true } = {}) {
  const input = $('input-username');
  const error = $('login-error');
  const username = (input?.value || state.user?.username || '').trim();
  error?.classList.add('hidden');
  input?.classList.remove('shake');
  if (!username || username.length < 2) {
    if (error) {
      error.textContent = 'Pon un nombre de al menos 2 caracteres.';
      error.classList.remove('hidden');
    }
    input?.classList.add('shake');
    setTimeout(() => input?.classList.remove('shake'), 400);
    return false;
  }
  if (state.user?.id && state.user.username === username) return true;

  if (!api) {
    const fallback = { id: `local-${Date.now()}`, username };
    state.user = fallback;
    localStorage.setItem(USER_KEY, JSON.stringify(fallback));
    return true;
  }

  try {
    const result = await api.createUser(username, 'mercaprecios', '');
    const user = { id: String(result.user_id ?? result.id ?? result.user?.id), username };
    state.user = user;
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    $('switch-user')?.classList.remove('hidden');
    return true;
  } catch (error) {
    if (allowFallback) {
      const fallback = { id: `local-${Date.now()}`, username };
      state.user = fallback;
      localStorage.setItem(USER_KEY, JSON.stringify(fallback));
      $('switch-user')?.classList.remove('hidden');
      toast('Jugador local creado. Revisa la API si no puedes crear sala.', '⚠️');
      return true;
    }
    return false;
  }
}

function restoreUser() {
  try {
    const saved = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    if (saved?.id && saved?.username) {
      saved.id = String(saved.id);
      state.user = saved;
      const input = $('input-username');
      if (input) input.value = saved.username;
      $('switch-user')?.classList.remove('hidden');
    }
  } catch {
    localStorage.removeItem(USER_KEY);
  }
}

function joinCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  return String(params.get('sala') || params.get('room') || '').toUpperCase();
}

function getShareUrl() {
  return `${location.origin}${location.pathname}?sala=${encodeURIComponent(state.room?.code || '')}`;
}

function renderQR(url) {
  const container = $('qr-container');
  if (!container) return;
  container.innerHTML = '';
  const img = document.createElement('img');
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}`;
  img.width = 220;
  img.height = 220;
  img.alt = 'QR para unirse a la sala';
  img.className = 'rounded-2xl bg-white p-2';
  container.appendChild(img);
}

function setupPolling(roomCode) {
  clearInterval(state.pollingTimer);
  $('realtime-badge')?.classList.remove('hidden');
  if ($('realtime-badge')) $('realtime-badge').textContent = 'API';
  state.pollingTimer = setInterval(() => pollRoomState(roomCode), POLL_MS);
  pollRoomState(roomCode);
}

function closeRealtime() {
  clearInterval(state.pollingTimer);
  state.pollingTimer = null;
}

async function pollRoomState(roomCode) {
  if (!api || !roomCode || state.isSolo) return;
  try {
    const roomData = await api.getRoom(roomCode);
    const gameState = extractGameState(roomData);
    applyGameState(gameState);
    routeByStatus();
    saveActiveSession();
    if (state.isHost && state.status === 'playing' && allPlayersAnswered()) setTimeout(() => App.revealRound(), 120);
  } catch (error) {
    console.warn('Error actualizando sala por polling', error);
  }
}

async function mergeLatestRoomState() {
  if (!api || !state.room?.code || state.isSolo) return;
  try {
    const roomData = await api.getRoom(state.room.code);
    const remote = extractGameState(roomData);
    if (state.status === 'playing' && remote.status === 'playing' && Number(remote.currentRound) === Number(state.currentRound)) {
      remote.answers = mergeAnswers(state.answers, remote.answers);
    }
    applyGameState(remote);
  } catch (error) {
    console.warn('No se pudo fusionar el estado de la sala', error);
  }
}

async function persistGameState() {
  if (!api || state.isSolo || !state.room?.code) return;
  const gameState = serializeGame({ status: state.status });
  return api.updateRoomState(state.room.code, { gameState, status: state.status, roomSettings: state.settings }).catch(error => {
    console.warn('No se pudo persistir el estado', error);
  });
}

function renderWaiting() {
  showScreen('waiting');
  const solo = state.isSolo;
  $('waiting-kicker') && ($('waiting-kicker').textContent = solo ? 'Modo individual' : 'Sala');
  $('waiting-code') && ($('waiting-code').textContent = solo ? 'SOLO' : (state.room?.code || '—'));
  $('waiting-count') && ($('waiting-count').textContent = String(state.players.length));
  $('share-room-button')?.classList.toggle('hidden', solo);
  $('guest-wait')?.classList.toggle('hidden', state.isHost);
  $('admin-settings')?.classList.toggle('hidden', !state.isHost);
  $('start-button')?.classList.toggle('hidden', !state.isHost);
  applySettingsToUI(state.settings);

  const root = $('waiting-players');
  if (root) {
    root.innerHTML = state.players.map(player => `
      <div class="panel rounded-2xl p-3 flex items-center gap-3">
        ${playerAvatar(player)}
        <div class="min-w-0 flex-1">
          <p class="font-black truncate">${escapeHTML(player.username)}</p>
          <p class="text-xs text-emerald-100/45">${solo ? 'Jugador individual' : (String(player.id) === state.hostId ? 'Anfitrión' : 'Jugador')}${String(player.id) === sid() ? ' · Tú' : ''}</p>
        </div>
        ${String(player.id) === state.hostId || solo ? '<span class="text-xl">👑</span>' : ''}
      </div>
    `).join('') || '<p class="text-emerald-100/45 text-sm text-center py-6">Aún no hay jugadores.</p>';
  }
}

function routeByStatus() {
  if (state.status === 'waiting') renderWaiting();
  else if (state.status === 'playing') renderGame();
  else if (state.status === 'reveal') renderReveal();
  else if (state.status === 'finished') renderFinal();
  else showScreen('login');
}

function selectedPool() {
  const categories = new Set(state.settings.categories || []);
  const pool = state.products.filter(product => !categories.size || categories.has(product.category));
  return pool.length >= 8 ? pool : state.products;
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function productSnapshot(product) {
  return { ...product };
}

function generateRounds() {
  const settings = normalizeSettings(state.settings);
  const pool = shuffle(selectedPool());
  const rounds = [];
  const count = settings.mode === 'lightning' ? 10 : settings.articles;

  for (let i = 0; i < count; i += 1) {
    if (settings.mode === 'basket') {
      const basketSize = 3 + Math.floor(Math.random() * 3);
      const products = shuffle(pool).slice(0, basketSize).map(productSnapshot);
      const targetPrice = byPrice(products.reduce((sum, product) => sum + Number(product.price || 0), 0));
      rounds.push({
        id: `basket-${Date.now()}-${i}-${Math.random().toString(16).slice(2)}`,
        mode: 'basket',
        title: `Cesta de ${basketSize} productos`,
        subtitle: 'Adivina el total de la compra',
        products,
        targetPrice,
      });
    } else if (settings.mode === 'versus') {
      let pair = shuffle(pool).slice(0, 2).map(productSnapshot);
      let guard = 0;
      while (pair.length === 2 && Number(pair[0].price) === Number(pair[1].price) && guard < 10) {
        pair = shuffle(pool).slice(0, 2).map(productSnapshot);
        guard += 1;
      }
      const correct = pair[0].price >= pair[1].price ? pair[0] : pair[1];
      rounds.push({
        id: `versus-${Date.now()}-${i}-${Math.random().toString(16).slice(2)}`,
        mode: 'versus',
        title: '¿Cuál es más caro?',
        subtitle: 'Toca el producto que creas que cuesta más',
        products: pair,
        correctProductId: correct.id,
        targetPrice: correct.price,
      });
    } else if (settings.mode === 'order') {
      const products = shuffle(pool).slice(0, 4).map(productSnapshot);
      const correctOrder = [...products].sort((a, b) => Number(a.price) - Number(b.price)).map(product => product.id);
      rounds.push({
        id: `order-${Date.now()}-${i}-${Math.random().toString(16).slice(2)}`,
        mode: 'order',
        title: 'Ordena por precio',
        subtitle: 'Del más barato al más caro',
        products,
        correctOrder,
        targetPrice: products.reduce((sum, product) => sum + Number(product.price || 0), 0),
      });
    } else {
      const product = productSnapshot(pool[i % pool.length]);
      rounds.push({
        id: `${settings.mode}-${product.id}-${i}-${Math.random().toString(16).slice(2)}`,
        mode: settings.mode,
        title: product.name,
        subtitle: product.category,
        products: [product],
        targetPrice: product.price,
      });
    }
  }

  return rounds;
}

function renderMiniScores() {
  const root = $('mini-scores');
  if (!root) return;
  root.classList.toggle('hidden', state.players.length <= 1);
  root.innerHTML = state.players
    .map(player => ({ ...player, score: Number(state.scores[player.id] || 0) }))
    .sort((a, b) => b.score - a.score)
    .map(player => `<div class="panel rounded-2xl p-3 flex items-center justify-between gap-2"><span class="truncate text-sm font-bold">${escapeHTML(player.username)}</span><span class="font-black text-brand-light">${player.score}</span></div>`)
    .join('');
}

function renderGame() {
  const round = currentRound();
  if (!round) return;
  const mode = roundMode(round);
  const roundKey = `${state.currentRound}:${round.id}:${state.roundEndsAt}`;
  const isNewRound = state.lastRenderedScreen !== 'game' || state.lastRenderedRoundKey !== roundKey;
  if (isNewRound) {
    state.lastRenderedRoundKey = roundKey;
    state.inputDigits = '';
    state.selectedChoice = '';
    state.orderSelection = [];
    showScreen('game');
  }

  $('game-mode-label') && ($('game-mode-label').textContent = `${mode.icon} ${mode.title}`);
  $('game-round') && ($('game-round').textContent = String(state.currentRound + 1));
  $('game-total') && ($('game-total').textContent = String(state.rounds.length || state.settings.articles));
  renderRoundContent(round);
  renderInputArea(round);
  updateAnswerStatus();
  renderMiniScores();
  renderAnswerDisplay(round);
  if (isNewRound) startTimer();
}

function productImage(product, extra = '') {
  return `<div class="bg-white rounded-[1.6rem] p-3 shadow-2xl shadow-black/25 ${extra}">
    <img src="${escapeHTML(product.thumbnail || '')}" alt="${escapeHTML(product.name)}" class="w-full h-full object-contain max-h-64" loading="lazy" onerror="this.style.display='none'; this.parentElement.innerHTML='<div class=&quot;text-5xl&quot;>🛒</div>'" />
  </div>`;
}

function renderRoundContent(round) {
  const root = $('game-content');
  if (!root) return;
  const mode = roundMode(round);
  if (mode.input === 'number' && round.mode !== 'basket') {
    const product = round.products[0];
    root.innerHTML = `<div id="product-area" class="product-drop w-full max-w-lg mx-auto text-center flex flex-col items-center">
      <p class="inline-flex rounded-full bg-brand/20 border border-brand-light/25 px-3 py-1 text-[11px] font-black uppercase tracking-widest text-brand-light">${escapeHTML(product.category || 'Mercadona')}</p>
      ${productImage(product, 'w-64 h-64 sm:w-80 sm:h-80 mt-4')}
      <h2 class="text-2xl sm:text-4xl font-black mt-4 leading-tight">${escapeHTML(product.name)}</h2>
      <p class="text-sm text-emerald-100/45 mt-2">${escapeHTML(product.categoryPath || '')}</p>
    </div>`;
  } else if (round.mode === 'basket') {
    root.innerHTML = `<div id="product-area" class="product-drop w-full text-center">
      <p class="inline-flex rounded-full bg-market-yellow/15 border border-market-yellow/30 px-3 py-1 text-[11px] font-black uppercase tracking-widest text-market-yellow">Cesta completa</p>
      <h2 class="text-2xl sm:text-4xl font-black mt-3">${escapeHTML(round.title)}</h2>
      <p class="text-sm text-emerald-100/45 mt-1">${escapeHTML(round.subtitle)}</p>
      <div class="grid grid-cols-${Math.min(round.products.length, 5)} gap-2 sm:gap-3 mt-5">
        ${round.products.map(product => `<div class="panel rounded-2xl p-2 sm:p-3 min-w-0">
          ${productImage(product, 'aspect-square rounded-2xl')}
          <p class="text-xs sm:text-sm font-black mt-2 leading-tight line-clamp-2">${escapeHTML(product.name)}</p>
        </div>`).join('')}
      </div>
    </div>`;
  } else if (round.mode === 'versus') {
    root.innerHTML = `<div id="product-area" class="product-drop w-full text-center">
      <p class="inline-flex rounded-full bg-brand/20 border border-brand-light/25 px-3 py-1 text-[11px] font-black uppercase tracking-widest text-brand-light">Duelo de precios</p>
      <h2 class="text-2xl sm:text-4xl font-black mt-3">¿Cuál es más caro?</h2>
      <div class="grid sm:grid-cols-2 gap-4 mt-5">
        ${round.products.map((product, index) => `<button type="button" onclick="App.chooseProduct('${escapeAttr(product.id)}')" class="choice-card rounded-[2rem] border border-white/10 bg-white/5 p-4 text-center ${state.selectedChoice === product.id ? 'selected' : ''}">
          <span class="inline-flex w-8 h-8 items-center justify-center rounded-xl bg-brand/20 text-brand-light font-black mb-2">${index + 1}</span>
          ${productImage(product, 'aspect-square')}
          <span class="block text-lg font-black mt-3 leading-tight">${escapeHTML(product.name)}</span>
          <span class="block text-xs text-emerald-100/45 mt-1">${escapeHTML(product.category)}</span>
        </button>`).join('')}
      </div>
    </div>`;
  } else if (round.mode === 'order') {
    const remaining = round.products.filter(product => !state.orderSelection.includes(product.id));
    root.innerHTML = `<div id="product-area" class="product-drop w-full text-center">
      <p class="inline-flex rounded-full bg-market-yellow/15 border border-market-yellow/30 px-3 py-1 text-[11px] font-black uppercase tracking-widest text-market-yellow">Ordena por precio</p>
      <h2 class="text-2xl sm:text-4xl font-black mt-3">Del más barato al más caro</h2>
      <div id="order-slots" class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
        ${[0, 1, 2, 3].map(index => {
          const product = round.products.find(item => item.id === state.orderSelection[index]);
          return `<button type="button" onclick="App.removeOrderAt(${index})" class="order-slot rounded-2xl bg-white/5 p-2 text-left ${product ? 'border-solid border-brand-light/50' : ''}">
            <span class="block text-[11px] text-emerald-100/40 font-black uppercase">#${index + 1}</span>
            ${product ? `<span class="block font-black text-sm mt-1 line-clamp-2">${escapeHTML(product.name)}</span>` : '<span class="block text-sm text-emerald-100/35 mt-2">Toca un producto</span>'}
          </button>`;
        }).join('')}
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        ${remaining.map(product => `<button type="button" onclick="App.addToOrder('${escapeAttr(product.id)}')" class="order-chip rounded-2xl border border-white/10 bg-white/5 p-3">
          ${productImage(product, 'aspect-square rounded-xl')}
          <span class="block text-xs font-black mt-2 leading-tight line-clamp-2">${escapeHTML(product.name)}</span>
        </button>`).join('')}
      </div>
    </div>`;
  }
}

function escapeAttr(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function renderInputArea(round) {
  const root = $('input-area');
  if (!root) return;
  const mode = roundMode(round);
  if (mode.input === 'number') {
    root.innerHTML = `<div id="keypad" class="grid grid-cols-3 gap-2">
      ${['1','2','3','4','5','6','7','8','9','clear','0','back'].map(key => `<button type="button" data-key="${key}" class="key btn-soft rounded-2xl text-2xl font-black">${key === 'clear' ? 'C' : key === 'back' ? '⌫' : key}</button>`).join('')}
    </div>
    <button id="submit-answer" onclick="App.submitAnswer()" class="btn-brand w-full rounded-2xl py-4 mt-3 font-black uppercase tracking-widest">Enviar precio</button>`;
    document.querySelectorAll('#keypad [data-key]').forEach(button => {
      button.addEventListener('pointerdown', () => flashKey(button.dataset.key));
      button.addEventListener('click', () => App.pressKey(button.dataset.key));
    });
    $('answer-title') && ($('answer-title').textContent = round.mode === 'basket' ? 'Total de la cesta' : 'Tu precio');
    $('answer-helper') && ($('answer-helper').textContent = 'Introduce el importe en euros y céntimos. Ejemplo: 245 = 2,45 €');
  } else if (mode.input === 'choice') {
    root.innerHTML = `<button id="submit-answer" onclick="App.submitAnswer()" class="btn-brand w-full rounded-2xl py-4 font-black uppercase tracking-widest">Confirmar elección</button>`;
    $('answer-title') && ($('answer-title').textContent = 'Tu elección');
    $('answer-helper') && ($('answer-helper').textContent = 'Toca el producto que creas que cuesta más.');
  } else if (mode.input === 'order') {
    root.innerHTML = `<button id="submit-answer" onclick="App.submitAnswer()" class="btn-brand w-full rounded-2xl py-4 font-black uppercase tracking-widest">Confirmar orden</button>
      <button onclick="App.clearOrder()" class="btn-soft w-full rounded-2xl py-3 mt-2 text-sm font-black">Reiniciar orden</button>`;
    $('answer-title') && ($('answer-title').textContent = 'Tu orden');
    $('answer-helper') && ($('answer-helper').textContent = 'Pulsa productos para colocarlos de menor a mayor.');
  }
}

function flashKey(key) {
  const button = document.querySelector(`#keypad [data-key="${CSS.escape(String(key))}"]`);
  if (!button) return;
  button.classList.add('key-active');
  clearTimeout(button._activeTimer);
  button._activeTimer = setTimeout(() => button.classList.remove('key-active'), 140);
}

function centsToDigits(value) {
  const cents = Math.round(Number(value || 0) * 100);
  return cents ? String(cents) : '';
}

function inputValue() {
  return byPrice(Number(state.inputDigits || '0') / 100);
}

function renderAnswerDisplay(round = currentRound()) {
  const submitted = Boolean(state.answers[sid()]);
  const mode = roundMode(round);
  if (mode.input === 'number') {
    if ($('answer-display')) $('answer-display').textContent = euros(inputValue());
  } else if (mode.input === 'choice') {
    const product = round?.products?.find(item => item.id === state.selectedChoice);
    if ($('answer-display')) $('answer-display').textContent = product ? 'Elegido ✓' : '—';
  } else if (mode.input === 'order') {
    if ($('answer-display')) $('answer-display').textContent = `${state.orderSelection.length}/4`;
  }
  const disabled = submitted || state.status !== 'playing';
  $('submit-answer') && ($('submit-answer').disabled = disabled);
  $('submit-answer')?.classList.toggle('opacity-60', disabled);
  if ($('submit-answer')) $('submit-answer').textContent = submitted ? 'Respuesta enviada ✓' : (mode.input === 'number' ? 'Enviar precio' : 'Confirmar respuesta');
}

function updateAnswerStatus() {
  const required = state.players.length;
  const answered = Object.keys(state.answers || {}).filter(playerId => state.players.some(player => String(player.id) === String(playerId))).length;
  $('answers-status') && ($('answers-status').textContent = `${answered}/${required} jugadores han respondido`);
}

function startTimer() {
  clearInterval(state.timerInterval);
  tickTimer();
  state.timerInterval = setInterval(tickTimer, 250);
}

function tickTimer() {
  const total = Number(state.settings.roundSeconds || DEFAULT_SETTINGS.roundSeconds);
  const remainingMs = Math.max(0, Number(state.roundEndsAt || 0) - Date.now());
  const remaining = Math.ceil(remainingMs / 1000);
  $('timer-label') && ($('timer-label').textContent = String(remaining));
  $('timer-bar') && ($('timer-bar').style.width = `${clamp((remainingMs / 1000) / total, 0, 1) * 100}%`);
  $('timer-label')?.classList.toggle('text-market-red', remaining <= 8);
  if (remaining <= 0 && state.status === 'playing') {
    clearInterval(state.timerInterval);
    if (state.isHost) App.revealRound();
    else $('answers-status') && ($('answers-status').textContent = 'Tiempo agotado. Esperando resultados…');
  }
}

function allPlayersAnswered() {
  const ids = new Set(state.players.map(player => String(player.id)));
  if (!ids.size) return false;
  return [...ids].every(id => state.answers?.[id]);
}

function answerLabel(answer, round) {
  if (!answer) return 'Sin respuesta';
  if (answer.type === 'number') return euros(answer.value);
  if (answer.type === 'choice') return round.products.find(product => product.id === answer.productId)?.name || 'Producto elegido';
  if (answer.type === 'order') return (answer.order || []).map(id => round.products.find(product => product.id === id)?.name || '?').join(' → ');
  return 'Respuesta';
}

function orderDistance(order = [], correctOrder = []) {
  if (order.length !== correctOrder.length) return 999;
  return correctOrder.reduce((sum, id, correctIndex) => {
    const answerIndex = order.indexOf(id);
    return sum + Math.abs(correctIndex - (answerIndex < 0 ? 99 : answerIndex));
  }, 0);
}

function calculateReveal() {
  const round = currentRound();
  const mode = roundMode(round);
  const rows = state.players.map(player => {
    const answer = state.answers?.[player.id] || null;
    let value = null;
    let diff = Number.POSITIVE_INFINITY;
    let over = false;
    let correct = false;
    let distance = Number.POSITIVE_INFINITY;

    if (mode.input === 'number') {
      value = answer ? byPrice(answer.value) : null;
      diff = value === null ? Number.POSITIVE_INFINITY : byPrice(Math.abs(value - Number(round.targetPrice || 0)));
      over = value !== null && value > Number(round.targetPrice || 0);
      correct = value !== null && diff === 0;
      distance = diff;
    } else if (mode.input === 'choice') {
      value = answer?.productId || null;
      correct = Boolean(value && value === round.correctProductId);
      diff = correct ? 0 : 1;
      distance = diff;
    } else if (mode.input === 'order') {
      value = answer?.order || [];
      distance = answer ? orderDistance(value, round.correctOrder) : Number.POSITIVE_INFINITY;
      diff = distance;
      correct = distance === 0;
    }
    return { player, answer, value, diff, distance, over, correct, missing: !answer };
  });

  let candidates = rows.filter(row => !row.missing);
  let nadieSinPasarse = false;
  if (mode.numeric && state.settings.justo) {
    const underOrEqual = candidates.filter(row => !row.over);
    if (underOrEqual.length) candidates = underOrEqual;
    else nadieSinPasarse = true;
  }

  const bestDistance = Math.min(...candidates.map(row => row.distance), Number.POSITIVE_INFINITY);
  const winnerIds = candidates.filter(row => row.distance === bestDistance && Number.isFinite(row.distance)).map(row => row.player.id);
  const nextScores = { ...state.scores };
  const medalMap = { ...state.medals };

  rows.forEach(row => {
    const id = row.player.id;
    nextScores[id] = Number(nextScores[id] || 0);
    const medal = getMedal(row, round);
    if (medal) medalMap[id] = [...(medalMap[id] || []), medal.key];

    if (winnerIds.includes(id)) nextScores[id] += 3;
    if (mode.input === 'number') {
      if (!row.missing && row.diff === 0) nextScores[id] += 2;
      if (!row.missing && row.diff <= 0.1) nextScores[id] += 1;
    } else if (mode.input === 'choice') {
      if (row.correct) nextScores[id] += 2;
    } else if (mode.input === 'order') {
      if (row.correct) nextScores[id] += 2;
      else if (!row.missing && row.distance <= 2) nextScores[id] += 1;
    }
  });

  rows.sort((a, b) => {
    if (winnerIds.includes(a.player.id) !== winnerIds.includes(b.player.id)) return winnerIds.includes(a.player.id) ? -1 : 1;
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    if (mode.numeric && state.settings.justo && a.over !== b.over && !nadieSinPasarse) return a.over ? 1 : -1;
    return a.distance - b.distance;
  });

  return { round, mode: round.mode, targetPrice: round.targetPrice, rows, winnerIds, scores: nextScores, medals: medalMap, nadieSinPasarse };
}

function getMedal(row, round) {
  const mode = roundMode(round);
  if (row.missing) return { key: 'sin-respuesta', icon: '⏳', label: 'Sin respuesta', tone: 'text-emerald-100/45' };
  if (mode.input === 'number') {
    const target = Number(round.targetPrice || 0);
    const ratio = target ? row.diff / target : row.diff;
    if (row.diff === 0) return { key: 'clavado', icon: '🎯', label: 'Clavado', tone: 'text-market-yellow' };
    if (row.diff <= 0.1) return { key: 'casi', icon: '🔥', label: 'Casi', tone: 'text-brand-light' };
    if (row.over && ratio >= 0.5) return { key: 'pasado', icon: '🚀', label: 'Te has pasado muchísimo', tone: 'text-market-red' };
    if (!row.over && ratio >= 0.5) return { key: 'lejisimos', icon: '🧊', label: 'Te has quedado lejísimos', tone: 'text-cyan-200' };
    return { key: 'bien', icon: '👌', label: 'Buena aproximación', tone: 'text-emerald-100/80' };
  }
  if (mode.input === 'choice') {
    return row.correct
      ? { key: 'clavado', icon: '🎯', label: 'Clavado', tone: 'text-market-yellow' }
      : { key: 'pasado', icon: '😅', label: 'Te has pasado muchísimo', tone: 'text-market-red' };
  }
  if (mode.input === 'order') {
    if (row.correct) return { key: 'clavado', icon: '🎯', label: 'Clavado', tone: 'text-market-yellow' };
    if (row.distance <= 2) return { key: 'casi', icon: '🔥', label: 'Casi', tone: 'text-brand-light' };
    return { key: 'pasado', icon: '🌀', label: 'Te has pasado muchísimo', tone: 'text-market-red' };
  }
  return null;
}

function launchConfetti(containerId = 'confetti-container', count = 90) {
  const colors = ['#00A651', '#42E28A', '#FFE36E', '#FF8A3D', '#F43F5E', '#E7FFF0'];
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.width = `${5 + Math.random() * 9}px`;
    piece.style.height = `${5 + Math.random() * 9}px`;
    piece.style.background = colors[i % colors.length];
    piece.style.borderRadius = Math.random() > .5 ? '50%' : '3px';
    piece.style.animationDuration = `${2.2 + Math.random() * 2.8}s`;
    piece.style.animationDelay = `${Math.random() * .8}s`;
    container.appendChild(piece);
  }
  setTimeout(() => { container.innerHTML = ''; }, 6200);
}

function renderRevealVisual(reveal) {
  const root = $('reveal-visual');
  if (!root) return;
  const round = reveal.round;
  const mode = roundMode(round);
  if (round.mode === 'basket') {
    root.innerHTML = `<div class="grid grid-cols-${Math.min(round.products.length, 5)} gap-2">
      ${round.products.map(product => `<div class="panel rounded-2xl p-2">
        ${productImage(product, 'aspect-square rounded-xl')}
        <p class="text-xs font-black mt-2 line-clamp-2">${escapeHTML(product.name)}</p>
        <p class="text-brand-light font-black">${euros(product.price)}</p>
      </div>`).join('')}
    </div>`;
  } else if (round.mode === 'versus') {
    root.innerHTML = `<div class="grid grid-cols-2 gap-3">
      ${round.products.map(product => `<div class="${product.id === round.correctProductId ? 'winner-card bg-brand/20 border-brand-light/40' : 'panel'} rounded-2xl border p-3">
        ${productImage(product, 'aspect-square rounded-xl')}
        <p class="text-sm font-black mt-2 line-clamp-2">${escapeHTML(product.name)}</p>
        <p class="text-2xl text-gradient font-black">${euros(product.price)}</p>
      </div>`).join('')}
    </div>`;
  } else if (round.mode === 'order') {
    const sorted = round.correctOrder.map(id => round.products.find(product => product.id === id)).filter(Boolean);
    root.innerHTML = `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      ${sorted.map((product, index) => `<div class="winner-card bg-brand/15 border border-brand-light/30 rounded-2xl p-2" style="animation-delay:${index * 80}ms">
        <span class="inline-flex w-7 h-7 items-center justify-center rounded-lg bg-brand-light text-[#03120B] font-black">${index + 1}</span>
        ${productImage(product, 'aspect-square rounded-xl mt-2')}
        <p class="text-xs font-black mt-2 line-clamp-2">${escapeHTML(product.name)}</p>
        <p class="text-brand-light font-black">${euros(product.price)}</p>
      </div>`).join('')}
    </div>`;
  } else {
    const product = round.products[0];
    root.innerHTML = `${productImage(product, 'w-60 h-60 mx-auto')}<p class="font-black text-xl mt-3">${escapeHTML(product.name)}</p>`;
  }
}

function renderReveal() {
  clearInterval(state.timerInterval);
  showScreen('reveal');
  const reveal = state.reveal;
  if (!reveal?.round) return;
  const round = reveal.round;
  const mode = roundMode(round);
  const winners = state.players.filter(player => reveal.winnerIds?.includes(player.id));

  $('reveal-title') && ($('reveal-title').textContent = mode.input === 'number' ? round.title : mode.title);
  $('reveal-price') && ($('reveal-price').textContent = mode.input === 'number' ? euros(round.targetPrice) : '¡Desvelado!');
  $('round-rule') && ($('round-rule').textContent = mode.numeric ? (state.settings.justo ? 'Precio justo' : 'Más cercano') : round.subtitle);
  $('reveal-medal-summary') && ($('reveal-medal-summary').textContent = mode.short);
  renderRevealVisual(reveal);

  const winnerBox = $('winner-box');
  if (winnerBox) {
    winnerBox.innerHTML = `
      <p class="text-xs text-brand-light font-black uppercase tracking-widest">Ganador${winners.length > 1 ? 'es' : ''}</p>
      <div class="text-5xl my-2">${winners.length > 1 ? '🤝' : '👑'}</div>
      <p class="text-3xl font-black text-gradient">${winners.map(player => escapeHTML(player.username)).join(' + ') || 'Sin ganador'}</p>
      <p class="text-xs text-emerald-100/55 mt-2">+3 puntos${reveal.nadieSinPasarse ? ' · todos se pasaron' : ''}</p>
    `;
  }

  const results = $('reveal-results');
  if (results) {
    results.innerHTML = reveal.rows.map((row, index) => {
      const isWinner = reveal.winnerIds?.includes(row.player.id);
      const medal = getMedal(row, round);
      let detail = '';
      if (mode.input === 'number') {
        const value = row.value === null ? 'Sin respuesta' : euros(row.value);
        const diffText = row.value === null ? '—' : `${row.over ? '+' : '−'}${euros(row.diff).replace('-', '')}`;
        detail = `<p class="text-xs text-emerald-100/45">Apuesta: <span class="font-bold text-emerald-100/80">${value}</span></p><p class="font-black ${isWinner ? 'text-market-yellow' : 'text-emerald-100/80'}">${diffText}</p>`;
      } else if (mode.input === 'choice') {
        detail = `<p class="text-xs text-emerald-100/45">Eligió: <span class="font-bold text-emerald-100/80">${escapeHTML(answerLabel(row.answer, round))}</span></p><p class="font-black ${row.correct ? 'text-market-yellow' : 'text-market-red'}">${row.correct ? 'Correcto' : 'Falló'}</p>`;
      } else {
        detail = `<p class="text-xs text-emerald-100/45 line-clamp-2">${escapeHTML(answerLabel(row.answer, round))}</p><p class="font-black ${row.correct ? 'text-market-yellow' : 'text-emerald-100/80'}">Distancia: ${Number.isFinite(row.distance) ? row.distance : '—'}</p>`;
      }
      return `<div class="${isWinner ? 'winner-card bg-brand/20 border-brand-light/40' : 'panel'} rounded-2xl p-3 flex items-center gap-3 border ${isWinner ? '' : 'border-white/10'}" style="animation-delay:${index * 60}ms">
        ${playerAvatar(row.player)}
        <div class="min-w-0 flex-1">
          <p class="font-black truncate">${escapeHTML(row.player.username)} ${String(row.player.id) === sid() ? '<span class="text-xs text-brand-light">Tú</span>' : ''}</p>
          ${detail}
        </div>
        <div class="text-right min-w-[110px]">
          <p class="text-2xl">${medal?.icon || '✨'}</p>
          <p class="text-[11px] font-black uppercase leading-tight ${medal?.tone || 'text-emerald-100/60'}">${escapeHTML(medal?.label || '')}</p>
        </div>
      </div>`;
    }).join('');
  }

  $('next-round-button')?.classList.toggle('hidden', !state.isHost);
  $('guest-next-wait')?.classList.toggle('hidden', state.isHost);
}

function renderFinal() {
  clearInterval(state.timerInterval);
  showScreen('final');
  launchConfetti('final-confetti', 140);
  const ranking = state.players
    .map(player => ({ ...player, score: Number(state.scores[player.id] || 0), medals: state.medals[player.id] || [] }))
    .sort((a, b) => b.score - a.score);
  const best = ranking[0]?.score ?? 0;
  const winners = ranking.filter(player => player.score === best);
  $('final-winner') && ($('final-winner').textContent = winners.map(player => player.username).join(' + ') || '—');
  const mode = GAME_MODES[state.settings.mode] || GAME_MODES.price;
  $('final-summary') && ($('final-summary').textContent = `${mode.title} · ${state.rounds.length} rondas · ${state.isSolo ? 'modo individual' : state.players.length + ' jugadores'}`);
  const root = $('final-scores');
  if (root) {
    root.innerHTML = ranking.map((player, index) => {
      const medalCounts = countMedals(player.medals);
      return `<div class="${index === 0 ? 'winner-card bg-brand/20 border-brand-light/40' : 'panel'} rounded-2xl p-3 flex items-center gap-3 border ${index === 0 ? '' : 'border-white/10'}">
        <span class="w-9 text-center font-black text-emerald-100/55">#${index + 1}</span>
        ${playerAvatar(player)}
        <span class="flex-1 text-left min-w-0"><span class="block font-black truncate">${escapeHTML(player.username)}</span><span class="block text-xs text-emerald-100/45">🎯 ${medalCounts.clavado || 0} · 🔥 ${medalCounts.casi || 0} · 🚀 ${medalCounts.pasado || 0}</span></span>
        <span class="text-2xl font-black text-gradient">${player.score}</span>
      </div>`;
    }).join('');
  }
  $('new-game-button')?.classList.toggle('hidden', !state.isHost);
  $('guest-final-wait')?.classList.toggle('hidden', state.isHost);
}

function countMedals(medals = []) {
  return medals.reduce((acc, medal) => {
    acc[medal] = (acc[medal] || 0) + 1;
    return acc;
  }, {});
}

function finalShareText() {
  const ranking = state.players
    .map(player => ({ ...player, score: Number(state.scores[player.id] || 0) }))
    .sort((a, b) => b.score - a.score);
  const mode = GAME_MODES[state.settings.mode] || GAME_MODES.price;
  const winner = ranking[0]?.username || 'nadie';
  const lines = [
    `🏆 MercaPrecios: ganó ${winner}`,
    `🎮 ${mode.title} · ${state.rounds.length} rondas`,
    '',
    ...ranking.slice(0, 5).map((player, index) => `${index + 1}. ${player.username}: ${player.score} puntos`),
    '',
    '¿Te atreves a adivinar los precios del súper?'
  ];
  return lines.join('\n');
}

function resetRoundInput() {
  state.inputDigits = '';
  state.selectedChoice = '';
  state.orderSelection = [];
}

window.App = {
  async init() {
    restoreUser();
    renderModeList();
    await loadCatalog();
    applySettingsToUI(state.settings);
    const pendingCode = joinCodeFromUrl();
    if (pendingCode) {
      $('join-container')?.classList.remove('hidden');
      $('login-actions')?.classList.add('hidden');
      const input = $('input-room-code');
      if (input) input.value = pendingCode;
      sessionStorage.setItem('pending_room', pendingCode);
    }

    document.querySelectorAll('#admin-settings input').forEach(input => {
      input.addEventListener('change', () => App.syncSettings());
      input.addEventListener('input', () => App.syncSettings());
    });
  },

  async startSoloFlow() {
    const button = $('btn-solo');
    setBusy(button, true, 'Preparando…');
    try {
      if (!(await prepareUser())) return;
      if (!state.products.length) {
        toast('Falta data/products.json con productos.', '⚠️');
        return;
      }
      closeRealtime();
      clearActiveSession();
      state.playScope = 'solo';
      state.isSolo = true;
      state.isHost = true;
      state.hostId = sid();
      state.room = { code: 'SOLO', id: null };
      state.players = [currentPlayer()];
      state.status = 'waiting';
      state.scores = { [sid()]: 0 };
      state.medals = { [sid()]: [] };
      state.answers = {};
      state.rounds = [];
      state.currentRound = 0;
      state.reveal = null;
      renderWaiting();
      toast('Modo individual listo', '🎮');
    } finally {
      setBusy(button, false);
    }
  },

  async createHomeRoom() {
    const button = $('btn-create-room');
    setBusy(button, true, 'Creando…');
    try {
      if (!api) throw new Error('No está disponible GameAPI.js');
      if (!(await prepareUser({ allowFallback: false }))) return;
      if (!state.products.length) {
        toast('Falta data/products.json con productos.', '⚠️');
        return;
      }
      await ensureGameId();
      syncSettingsFromUI();
      const player = currentPlayer();
      state.playScope = 'multi';
      state.isSolo = false;
      state.hostId = sid();
      state.isHost = true;
      state.players = [player];
      state.status = 'waiting';
      state.scores = { [sid()]: 0 };
      state.medals = { [sid()]: [] };
      state.answers = {};
      state.rounds = [];
      state.currentRound = 0;
      state.reveal = null;
      const initialState = serializeGame({ status: 'waiting' });
      const roomResult = await api.createRoom(state.gameId, sid(), state.settings, initialState);
      state.room = normalizeRoom(roomResult);
      saveActiveSession();
      setupPolling(state.room.code);
      await persistGameState();
      renderWaiting();
      toast('Sala creada', '🛒');
    } catch (error) {
      console.error(error);
      toast(error.message || 'No se pudo crear la sala.', '⚠️');
    } finally {
      setBusy(button, false);
    }
  },

  async showJoinForm(roomCode = '') {
    if (!(await prepareUser())) return;
    $('join-container')?.classList.remove('hidden');
    $('login-actions')?.classList.add('hidden');
    const input = $('input-room-code');
    if (input && roomCode) input.value = roomCode.toUpperCase();
    setTimeout(() => input?.focus(), 50);
  },

  hideJoinForm() {
    $('join-container')?.classList.add('hidden');
    $('login-actions')?.classList.remove('hidden');
    $('join-error')?.classList.add('hidden');
    if ($('input-room-code')) $('input-room-code').value = '';
    history.replaceState({}, '', location.pathname);
  },

  async joinHomeRoom() {
    const error = $('join-error');
    error?.classList.add('hidden');
    try {
      if (!api) throw new Error('No está disponible GameAPI.js');
      if (!(await prepareUser({ allowFallback: false }))) return;
      const code = String($('input-room-code')?.value || sessionStorage.getItem('pending_room') || '').trim().toUpperCase();
      if (!code) {
        if (error) {
          error.textContent = 'Escribe el código de la sala.';
          error.classList.remove('hidden');
        }
        return;
      }
      await api.joinRoom(code, sid()).catch(joinError => console.warn('joinRoom avisó:', joinError));
      const roomData = await api.getRoom(code);
      state.room = normalizeRoom(roomData, code);
      state.hostId = roomHostId(roomData, extractGameState(roomData).hostId);
      state.isHost = sid() === state.hostId;
      state.playScope = 'multi';
      state.isSolo = false;
      applyGameState(extractGameState(roomData));
      upsertPlayer(currentPlayer());
      if (!state.hostId) state.hostId = String(state.players[0]?.id || '');
      saveActiveSession();
      await persistGameState();
      setupPolling(state.room.code);
      routeByStatus();
      toast('Has entrado en la sala', '✅');
    } catch (err) {
      console.error(err);
      if (error) {
        error.textContent = err.message || 'No se pudo entrar en la sala.';
        error.classList.remove('hidden');
      }
    }
  },

  switchUser() {
    closeRealtime();
    clearActiveSession();
    localStorage.removeItem(USER_KEY);
    state.user = null;
    state.room = null;
    state.status = 'idle';
    $('switch-user')?.classList.add('hidden');
    if ($('input-username')) $('input-username').value = '';
    showScreen('login');
  },

  selectMode(modeId) {
    if (!GAME_MODES[modeId] || (!state.isHost && state.status !== 'idle')) return;
    state.settings = normalizeSettings({ ...state.settings, mode: modeId });
    applySettingsToUI(state.settings);
    App.syncSettings();
  },

  adjustSetting(name, delta) {
    const input = name === 'articles' ? $('cfg-articles') : $('cfg-time');
    if (!input) return;
    const step = Number(delta);
    const min = Number(input.min || 0);
    const max = Number(input.max || 999);
    input.value = clamp(Number(input.value || 0) + step, min, max);
    App.syncSettings();
  },

  clearCategories() {
    document.querySelectorAll('#category-list input').forEach(input => { input.checked = false; });
    App.syncSettings();
  },

  filterCategories(query = '') {
    const normalized = String(query).trim().toLowerCase();
    document.querySelectorAll('#category-list .category-pill').forEach(label => {
      label.classList.toggle('hidden', normalized && !label.dataset.categoryName.includes(normalized));
    });
  },

  syncSettings() {
    if (!state.isHost || !['waiting', 'idle'].includes(state.status)) return;
    syncSettingsFromUI();
    if (!state.isSolo && state.room?.code) persistGameState();
  },

  async startGame() {
    if (!state.isHost) return;
    if (!state.products.length) {
      toast('No hay productos cargados.', '⚠️');
      return;
    }
    syncSettingsFromUI();
    state.rounds = generateRounds();
    if (!state.rounds.length) {
      toast('No hay productos para esas categorías.', '⚠️');
      return;
    }
    state.players.forEach(player => {
      state.scores[player.id] = 0;
      state.medals[player.id] = [];
    });
    state.currentRound = 0;
    state.answers = {};
    state.reveal = null;
    state.status = 'playing';
    state.roundEndsAt = Date.now() + state.settings.roundSeconds * 1000;
    resetRoundInput();
    await persistGameState();
    renderGame();
  },

  pressKey(key) {
    if (state.answers[sid()] || state.status !== 'playing') return;
    flashKey(key);
    if (/^\d$/.test(key)) {
      state.inputDigits = (state.inputDigits + key).replace(/^0+(?=\d)/, '').slice(0, 5);
    } else if (key === 'back') {
      state.inputDigits = state.inputDigits.slice(0, -1);
    } else if (key === 'clear') {
      state.inputDigits = '';
    }
    renderAnswerDisplay();
  },

  chooseProduct(productId) {
    if (state.answers[sid()] || state.status !== 'playing') return;
    state.selectedChoice = String(productId);
    renderRoundContent(currentRound());
    renderAnswerDisplay();
  },

  addToOrder(productId) {
    if (state.answers[sid()] || state.status !== 'playing') return;
    const id = String(productId);
    if (!state.orderSelection.includes(id) && state.orderSelection.length < 4) state.orderSelection.push(id);
    renderRoundContent(currentRound());
    renderAnswerDisplay();
  },

  removeOrderAt(index) {
    if (state.answers[sid()] || state.status !== 'playing') return;
    state.orderSelection.splice(index, 1);
    renderRoundContent(currentRound());
    renderAnswerDisplay();
  },

  clearOrder() {
    if (state.answers[sid()] || state.status !== 'playing') return;
    state.orderSelection = [];
    renderRoundContent(currentRound());
    renderAnswerDisplay();
  },

  async submitAnswer() {
    if (state.status !== 'playing' || state.answers[sid()]) return;
    const round = currentRound();
    const mode = roundMode(round);
    let answer;
    if (mode.input === 'number') {
      const value = inputValue();
      if (value <= 0) {
        toast('Pon un precio mayor que 0.', '💸');
        return;
      }
      answer = { type: 'number', value, username: state.user.username, at: Date.now() };
    } else if (mode.input === 'choice') {
      if (!state.selectedChoice) {
        toast('Elige un producto.', '👆');
        return;
      }
      answer = { type: 'choice', productId: state.selectedChoice, username: state.user.username, at: Date.now() };
    } else if (mode.input === 'order') {
      if (state.orderSelection.length !== 4) {
        toast('Ordena los 4 productos.', '📊');
        return;
      }
      answer = { type: 'order', order: [...state.orderSelection], username: state.user.username, at: Date.now() };
    }

    await mergeLatestRoomState();
    if (state.status !== 'playing' || state.answers[sid()]) return;
    state.answers = { ...state.answers, [sid()]: answer };
    await persistGameState();
    renderAnswerDisplay();
    updateAnswerStatus();
    toast('Respuesta enviada', '✅');
    if (state.isHost && allPlayersAnswered()) setTimeout(() => App.revealRound(), 160);
  },

  async revealRound() {
    if (!state.isHost || state.status !== 'playing') return;
    await mergeLatestRoomState();
    if (state.status !== 'playing') return;
    state.reveal = calculateReveal();
    state.scores = state.reveal.scores;
    state.medals = state.reveal.medals;
    state.status = 'reveal';
    await persistGameState();
    launchConfetti('confetti-container', 90);
    renderReveal();
  },

  async nextRound() {
    if (!state.isHost || state.status !== 'reveal') return;
    if (state.currentRound + 1 >= state.rounds.length) {
      state.status = 'finished';
      await persistGameState();
      renderFinal();
      return;
    }
    state.currentRound += 1;
    state.answers = {};
    state.reveal = null;
    state.status = 'playing';
    state.roundEndsAt = Date.now() + state.settings.roundSeconds * 1000;
    resetRoundInput();
    await persistGameState();
    renderGame();
  },

  async newGame() {
    if (!state.isHost) return;
    state.status = 'waiting';
    state.rounds = [];
    state.currentRound = 0;
    state.answers = {};
    state.reveal = null;
    state.players.forEach(player => {
      state.scores[player.id] = 0;
      state.medals[player.id] = [];
    });
    await persistGameState();
    renderWaiting();
  },

  openShareModal() {
    if (state.isSolo) return;
    const modal = $('share-modal');
    const url = getShareUrl();
    $('share-code') && ($('share-code').textContent = state.room?.code || '—');
    $('share-link') && ($('share-link').value = url);
    renderQR(url);
    modal?.classList.remove('hidden');
    modal?.classList.add('flex');
  },

  closeShareModal() {
    const modal = $('share-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
  },

  async copyShareLink() {
    try {
      await navigator.clipboard.writeText(getShareUrl());
      toast('Enlace copiado', '📋');
    } catch {
      $('share-link')?.select();
      toast('Copia el enlace manualmente', '📋');
    }
  },

  async nativeShare() {
    const url = getShareUrl();
    if (!navigator.share) return App.copyShareLink();
    try { await navigator.share({ title: 'MercaPrecios', text: 'Únete a mi sala de MercaPrecios', url }); }
    catch {}
  },

  async shareFinalResult() {
    const text = finalShareText();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Resultado de MercaPrecios', text });
        return;
      } catch {}
    }
    const whatsapp = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(whatsapp, '_blank', 'noopener,noreferrer');
  },

  exitToHome() {
    closeRealtime();
    clearActiveSession();
    state.room = null;
    state.status = 'idle';
    state.isSolo = false;
    state.playScope = 'multi';
    history.replaceState({}, '', location.pathname);
    showScreen('login');
  },
};

window.addEventListener('keydown', event => {
  if (event.key === 'Escape') App.closeShareModal();
  if (state.status !== 'playing') return;
  const mode = roundMode(currentRound());
  if (mode.input === 'number') {
    if (/^\d$/.test(event.key)) App.pressKey(event.key);
    if (event.key === 'Backspace') App.pressKey('back');
    if (event.key === 'Enter') App.submitAnswer();
  } else if (event.key === 'Enter') {
    App.submitAnswer();
  }
});

App.init();
