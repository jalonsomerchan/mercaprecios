const api = new window.GameAPI();

const GAME_NAME = 'MercaPrecios';
const GAME_ID_FALLBACK = 13;
const USER_KEY = 'mercaprecios_user';
const GAME_ID_KEY = 'mercaprecios_game_id';
const SESSION_KEY = 'mercaprecios_active_room';
const POLL_MS = 1500;
const SOCKET_RECONNECT_MS = 1800;
const SOCKET_MAX_RETRIES = 6;

const DEFAULT_SETTINGS = {
  articles: 8,
  roundSeconds: 45,
  justo: true,
  categories: [],
};

const state = {
  user: null,
  gameId: Number(localStorage.getItem(GAME_ID_KEY) || GAME_ID_FALLBACK),
  room: null,
  isHost: false,
  hostId: '',
  players: [],
  settings: { ...DEFAULT_SETTINGS },
  products: [],
  categories: [],
  gameProducts: [],
  currentRound: 0,
  answers: {},
  scores: {},
  reveal: null,
  status: 'idle',
  inputDigits: '',
  timerInterval: null,
  roundEndsAt: 0,
  socket: null,
  socketReady: false,
  socketRoomCode: null,
  socketReconnectAttempts: 0,
  socketReconnectTimer: null,
  socketManualClose: false,
  pollingTimer: null,
  pendingMessages: [],
  lastEventId: '',
  latestEvent: null,
};

const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value || 0)));
const sid = () => String(state.user?.id ?? '');
const euros = value => `${Number(value || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const byPrice = value => Number(Number(value || 0).toFixed(2));
const escapeHTML = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const initials = name => escapeHTML(String(name || '?').trim()[0]?.toUpperCase() || '?');

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
  $(`screen-${name}`)?.classList.add('active');
}

function toast(message, icon = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = `${icon ? `${icon} ` : ''}${message}`;
  el.classList.add('toast-visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('toast-visible'), 2800);
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

    if (!products.length) {
      throw new Error('data/products.json existe, pero no contiene productos con nombre y precio válidos.');
    }

    const categoriesRaw = await fetchJSON('data/categories.json').catch(() => null);
    state.products = products;
    state.categories = normalizeCategories(categoriesRaw, products);
    renderCategoryList();

    if (status) {
      const categoryCount = state.categories.length.toLocaleString('es-ES');
      status.textContent = `${products.length.toLocaleString('es-ES')} productos reales cargados desde /data/products.json · ${categoryCount} categorías`;
    }
  } catch (error) {
    console.warn(error);
    state.products = [];
    state.categories = [];
    if (status) status.textContent = 'No se ha podido cargar /data/products.json. Revisa que exista, que sea JSON válido y que tenga campos name y price.';
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
  const index = state.players.findIndex(item => item.id === p.id);
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

function serializeGame(extra = {}) {
  return {
    status: extra.status ?? state.status,
    hostId: state.hostId,
    players: state.players,
    settings: state.settings,
    gameProducts: state.gameProducts,
    currentRound: state.currentRound,
    answers: state.answers,
    scores: state.scores,
    reveal: state.reveal,
    roundEndsAt: state.roundEndsAt,
    latestEvent: extra.latestEvent ?? state.latestEvent ?? null,
    savedAt: Date.now(),
  };
}

function applyGameState(gameState = {}) {
  if (!gameState || typeof gameState !== 'object') return;
  state.status = gameState.status ?? state.status;
  state.hostId = String(gameState.hostId ?? state.hostId ?? '');
  state.isHost = state.hostId ? sid() === state.hostId : state.isHost;
  state.players = (gameState.players ?? state.players ?? []).map(normPlayer);
  state.settings = normalizeSettings(gameState.settings ?? state.settings);
  state.gameProducts = normalizeProducts(gameState.gameProducts ?? state.gameProducts);
  state.currentRound = Number(gameState.currentRound ?? state.currentRound ?? 0);
  state.answers = gameState.answers ?? state.answers ?? {};
  state.scores = gameState.scores ?? state.scores ?? {};
  state.reveal = gameState.reveal ?? state.reveal ?? null;
  state.roundEndsAt = Number(gameState.roundEndsAt ?? state.roundEndsAt ?? 0);
  state.latestEvent = gameState.latestEvent ?? state.latestEvent ?? null;
  if (state.user) upsertPlayer(currentPlayer());
}

function normalizeSettings(settings = {}) {
  const selectedCategories = Array.isArray(settings.categories) ? settings.categories.map(String) : [];
  return {
    articles: clamp(settings.articles ?? settings.rounds ?? DEFAULT_SETTINGS.articles, 3, 30),
    roundSeconds: clamp(settings.roundSeconds ?? settings.time ?? DEFAULT_SETTINGS.roundSeconds, 10, 180),
    justo: settings.justo ?? settings.priceIsRight ?? DEFAULT_SETTINGS.justo,
    categories: selectedCategories,
  };
}

function syncSettingsFromUI() {
  const selected = [...document.querySelectorAll('#category-list input:checked')].map(input => input.value);
  state.settings = normalizeSettings({
    articles: $('cfg-articles')?.value,
    roundSeconds: $('cfg-time')?.value,
    justo: $('cfg-justo')?.checked,
    categories: selected,
  });
  return state.settings;
}

function applySettingsToUI(settings = state.settings) {
  const normalized = normalizeSettings(settings);
  if ($('cfg-articles')) $('cfg-articles').value = normalized.articles;
  if ($('cfg-time')) $('cfg-time').value = normalized.roundSeconds;
  if ($('cfg-justo')) $('cfg-justo').checked = Boolean(normalized.justo);
  document.querySelectorAll('#category-list input').forEach(input => {
    input.checked = normalized.categories.includes(input.value);
  });
}

function saveActiveSession() {
  if (!state.user || !state.room?.code) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: state.room.code, userId: sid(), isHost: state.isHost, hostId: state.hostId, savedAt: Date.now() }));
}

function clearActiveSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function ensureGameId() {
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

function renderCategoryList() {
  const root = $('category-list');
  if (!root) return;
  root.innerHTML = state.categories.map(category => {
    const rgba = Array.isArray(category.color) ? `rgba(${category.color[0]},${category.color[1]},${category.color[2]},.22)` : 'rgba(255,255,255,.06)';
    return `<label class="category-pill cursor-pointer rounded-full border border-white/10 px-3 py-2 text-xs font-bold text-emerald-100/70 transition" style="background:${rgba}">
      <input type="checkbox" class="sr-only" value="${escapeHTML(category.name)}" />
      ${escapeHTML(category.name)} <span class="opacity-45">${Number(category.count || 0) || ''}</span>
    </label>`;
  }).join('');
}

function playerAvatar(player) {
  const colors = ['from-emerald-400 to-green-700', 'from-yellow-300 to-orange-600', 'from-cyan-300 to-blue-700', 'from-fuchsia-400 to-purple-700', 'from-rose-400 to-red-700', 'from-lime-300 to-emerald-700'];
  const hash = String(player.username || '?').split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return `<span class="w-10 h-10 rounded-2xl bg-gradient-to-br ${colors[hash % colors.length]} flex items-center justify-center font-black shadow-lg shadow-black/20">${initials(player.username)}</span>`;
}

function renderWaiting() {
  showScreen('waiting');
  $('waiting-code') && ($('waiting-code').textContent = state.room?.code || '—');
  $('waiting-count') && ($('waiting-count').textContent = String(state.players.length));
  $('admin-settings')?.classList.toggle('hidden', !state.isHost);
  $('start-button')?.classList.toggle('hidden', !state.isHost);
  $('guest-wait')?.classList.toggle('hidden', state.isHost);
  applySettingsToUI(state.settings);

  const root = $('waiting-players');
  if (root) {
    root.innerHTML = state.players.map(player => `
      <div class="panel rounded-2xl p-3 flex items-center gap-3">
        ${playerAvatar(player)}
        <div class="min-w-0 flex-1">
          <p class="font-black truncate">${escapeHTML(player.username)}</p>
          <p class="text-xs text-emerald-100/45">${String(player.id) === state.hostId ? 'Anfitrión' : 'Jugador'}${String(player.id) === sid() ? ' · Tú' : ''}</p>
        </div>
        ${String(player.id) === state.hostId ? '<span class="text-xl">👑</span>' : ''}
      </div>
    `).join('') || '<p class="text-emerald-100/45 text-sm text-center py-6">Aún no hay jugadores.</p>';
  }
}

function renderMiniScores() {
  const root = $('mini-scores');
  if (!root) return;
  root.innerHTML = state.players
    .map(player => ({ ...player, score: Number(state.scores[player.id] || 0) }))
    .sort((a, b) => b.score - a.score)
    .map(player => `<div class="panel rounded-2xl p-3 flex items-center justify-between gap-2"><span class="truncate text-sm font-bold">${escapeHTML(player.username)}</span><span class="font-black text-brand-light">${player.score}</span></div>`)
    .join('');
}

function currentProduct() {
  return state.gameProducts[state.currentRound] || null;
}

function renderGame() {
  showScreen('game');
  const product = currentProduct();
  if (!product) return;
  $('game-round') && ($('game-round').textContent = String(state.currentRound + 1));
  $('game-total') && ($('game-total').textContent = String(state.gameProducts.length || state.settings.articles));
  $('product-category') && ($('product-category').textContent = product.category || 'Mercadona');
  $('product-name') && ($('product-name').textContent = product.name);
  $('product-path') && ($('product-path').textContent = product.categoryPath || '');
  const img = $('product-image');
  if (img) {
    img.src = product.thumbnail || '';
    img.alt = product.name;
  }
  const card = $('product-card');
  card?.classList.remove('product-drop');
  void card?.offsetWidth;
  card?.classList.add('product-drop');
  state.inputDigits = state.answers[sid()] ? centsToDigits(Number(state.answers[sid()].value)) : '';
  renderAnswerDisplay();
  updateAnswerStatus();
  renderMiniScores();
  startTimer();
}

function centsToDigits(value) {
  const cents = Math.round(Number(value || 0) * 100);
  return cents ? String(cents) : '';
}

function inputValue() {
  return byPrice(Number(state.inputDigits || '0') / 100);
}

function renderAnswerDisplay() {
  $('answer-display') && ($('answer-display').textContent = euros(inputValue()));
  const submitted = Boolean(state.answers[sid()]);
  $('submit-answer') && ($('submit-answer').disabled = submitted || state.status !== 'playing');
  $('submit-answer')?.classList.toggle('opacity-60', submitted || state.status !== 'playing');
  if ($('submit-answer')) $('submit-answer').textContent = submitted ? 'Precio enviado ✓' : 'Enviar precio';
}

function updateAnswerStatus() {
  const required = state.players.length;
  const answered = Object.keys(state.answers || {}).filter(playerId => state.players.some(player => String(player.id) === String(playerId))).length;
  $('answers-status') && ($('answers-status').textContent = `${answered}/${required} jugadores han enviado precio`);
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

function selectedPool() {
  const categories = new Set(state.settings.categories || []);
  const pool = state.products.filter(product => !categories.size || categories.has(product.category));
  return pool.length >= 3 ? pool : state.products;
}

function pickProducts() {
  const pool = [...selectedPool()];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, state.settings.articles).map(product => ({ ...product }));
}

function calculateReveal() {
  const product = currentProduct();
  const price = Number(product?.price || 0);
  const rows = state.players.map(player => {
    const answer = state.answers?.[player.id];
    const value = answer ? byPrice(answer.value) : null;
    const diff = value === null ? Number.POSITIVE_INFINITY : byPrice(Math.abs(value - price));
    const over = value !== null && value > price;
    return { player, value, diff, over, missing: value === null };
  });

  let candidates = rows.filter(row => !row.missing);
  let nadieSinPasarse = false;
  if (state.settings.justo) {
    const underOrEqual = candidates.filter(row => !row.over);
    if (underOrEqual.length) candidates = underOrEqual;
    else nadieSinPasarse = true;
  }

  const bestDiff = Math.min(...candidates.map(row => row.diff), Number.POSITIVE_INFINITY);
  const winnerIds = candidates.filter(row => row.diff === bestDiff).map(row => row.player.id);
  const nextScores = { ...state.scores };
  rows.forEach(row => {
    const id = row.player.id;
    nextScores[id] = Number(nextScores[id] || 0);
    if (winnerIds.includes(id)) nextScores[id] += 3;
    if (!row.missing && row.diff === 0) nextScores[id] += 2;
    if (!row.missing && row.diff <= 0.1) nextScores[id] += 1;
  });

  rows.sort((a, b) => {
    if (winnerIds.includes(a.player.id) !== winnerIds.includes(b.player.id)) return winnerIds.includes(a.player.id) ? -1 : 1;
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    if (state.settings.justo && a.over !== b.over && !nadieSinPasarse) return a.over ? 1 : -1;
    return a.diff - b.diff;
  });

  return { product, price, rows, winnerIds, scores: nextScores, nadieSinPasarse };
}

function renderReveal() {
  clearInterval(state.timerInterval);
  showScreen('reveal');
  const reveal = state.reveal;
  if (!reveal?.product) return;
  $('reveal-product-name') && ($('reveal-product-name').textContent = reveal.product.name);
  $('reveal-price') && ($('reveal-price').textContent = euros(reveal.price));
  $('round-rule') && ($('round-rule').textContent = state.settings.justo ? 'Precio justo' : 'Más cercano');
  const img = $('reveal-image');
  if (img) {
    img.src = reveal.product.thumbnail || '';
    img.alt = reveal.product.name;
  }

  const winners = state.players.filter(player => reveal.winnerIds?.includes(player.id));
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
      const value = row.value === null ? 'Sin respuesta' : euros(row.value);
      const diffText = row.value === null ? '—' : `${row.over ? '+' : '−'}${euros(row.diff).replace('-', '')}`;
      return `<div class="${isWinner ? 'winner-card bg-brand/20 border-brand-light/40' : 'panel'} rounded-2xl p-3 flex items-center gap-3 border ${isWinner ? '' : 'border-white/10'}" style="animation-delay:${index * 60}ms">
        ${playerAvatar(row.player)}
        <div class="min-w-0 flex-1">
          <p class="font-black truncate">${escapeHTML(row.player.username)} ${String(row.player.id) === sid() ? '<span class="text-xs text-brand-light">Tú</span>' : ''}</p>
          <p class="text-xs text-emerald-100/45">Apuesta: <span class="font-bold text-emerald-100/80">${value}</span></p>
        </div>
        <div class="text-right">
          <p class="font-black ${isWinner ? 'text-market-yellow' : 'text-emerald-100/80'}">${diffText}</p>
          <p class="text-xs text-emerald-100/45">${row.over ? 'se pasa' : 'por debajo'}</p>
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
  launchConfetti('final-confetti', 120);
  const ranking = state.players
    .map(player => ({ ...player, score: Number(state.scores[player.id] || 0) }))
    .sort((a, b) => b.score - a.score);
  const best = ranking[0]?.score ?? 0;
  const winners = ranking.filter(player => player.score === best);
  $('final-winner') && ($('final-winner').textContent = winners.map(player => player.username).join(' + ') || '—');
  const root = $('final-scores');
  if (root) {
    root.innerHTML = ranking.map((player, index) => `<div class="${index === 0 ? 'winner-card bg-brand/20 border-brand-light/40' : 'panel'} rounded-2xl p-3 flex items-center gap-3 border ${index === 0 ? '' : 'border-white/10'}">
      <span class="w-9 text-center font-black text-emerald-100/55">#${index + 1}</span>
      ${playerAvatar(player)}
      <span class="flex-1 text-left font-black truncate">${escapeHTML(player.username)}</span>
      <span class="text-2xl font-black text-gradient">${player.score}</span>
    </div>`).join('');
  }
  $('new-game-button')?.classList.toggle('hidden', !state.isHost);
  $('guest-final-wait')?.classList.toggle('hidden', state.isHost);
}

function routeByStatus() {
  if (state.status === 'waiting') renderWaiting();
  else if (state.status === 'playing') renderGame();
  else if (state.status === 'reveal') renderReveal();
  else if (state.status === 'finished') renderFinal();
  else renderWaiting();
}

function launchConfetti(containerId = 'confetti-container', count = 90) {
  const colors = ['#00A651', '#42E28A', '#FFE36E', '#FF8A3D', '#F43F5E', '#E7FFF0'];
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
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

let socketConnectorPromise = null;
async function loadSocketConnector() {
  if (!socketConnectorPromise) {
    socketConnectorPromise = import('https://esm.sh/itty-sockets').then(mod => mod.connect).catch(error => {
      console.warn('No se pudo cargar itty-sockets. Se usará polling contra la API.', error);
      return null;
    });
  }
  return socketConnectorPromise;
}

function closeSocket(manual = true) {
  state.socketManualClose = manual;
  clearTimeout(state.socketReconnectTimer);
  clearInterval(state.pollingTimer);
  state.socketReconnectTimer = null;
  state.pollingTimer = null;
  state.socketReady = false;
  try { state.socket?.close?.(); } catch {}
  state.socket = null;
}

async function pollRoomState(roomCode) {
  try {
    const roomData = await api.getRoom(roomCode);
    const gameState = extractGameState(roomData);
    applyGameState(gameState);
    const latestEvent = gameState.latestEvent;
    if (latestEvent?.id && latestEvent.id !== state.lastEventId) {
      handleEvent(latestEvent, { fromPoll: true });
    } else {
      routeByStatus();
    }
  } catch (error) {
    console.warn('Error actualizando sala por polling', error);
  }
}

function setupPolling(roomCode) {
  $('realtime-badge') && ($('realtime-badge').textContent = 'API');
  $('realtime-badge')?.classList.remove('bg-brand/20', 'text-brand-light');
  clearInterval(state.pollingTimer);
  state.socketReady = true;
  state.pollingTimer = setInterval(() => pollRoomState(roomCode), POLL_MS);
  pollRoomState(roomCode);
  flushPendingMessages();
  return true;
}

async function connectRealtime(roomCode, { reconnect = false } = {}) {
  if (!roomCode) return false;
  if (!reconnect) {
    closeSocket(false);
    state.socketReconnectAttempts = 0;
  }
  state.socketRoomCode = roomCode;
  state.socketManualClose = false;

  const connect = await loadSocketConnector();
  if (!connect) return setupPolling(roomCode);

  try {
    state.socket = connect(`mercaprecios-${roomCode}`);
    state.socketReady = true;
    state.socketReconnectAttempts = 0;
    $('realtime-badge') && ($('realtime-badge').textContent = 'LIVE');
    $('realtime-badge')?.classList.add('bg-brand/20', 'text-brand-light');
    state.socket.on?.('message', ({ message }) => {
      try { handleEvent(typeof message === 'string' ? JSON.parse(message) : message); }
      catch (error) { console.warn('socket parse error', error); }
    });
    const scheduleReconnect = () => {
      state.socketReady = false;
      if (state.socketManualClose || !state.socketRoomCode) return;
      if (state.socketReconnectAttempts >= SOCKET_MAX_RETRIES) {
        toast('Conexión por API activada', '📡');
        setupPolling(state.socketRoomCode);
        return;
      }
      state.socketReconnectAttempts += 1;
      clearTimeout(state.socketReconnectTimer);
      state.socketReconnectTimer = setTimeout(() => connectRealtime(state.socketRoomCode, { reconnect: true }), SOCKET_RECONNECT_MS * state.socketReconnectAttempts);
    };
    state.socket.on?.('close', scheduleReconnect);
    state.socket.on?.('error', scheduleReconnect);
    flushPendingMessages();
    return true;
  } catch (error) {
    console.warn('socket connect error', error);
    state.socketReady = false;
    return setupPolling(roomCode);
  }
}

function flushPendingMessages() {
  const queued = state.pendingMessages.splice(0);
  queued.forEach(event => emit(event.type, event));
}

function persistGameState(latestEvent = null) {
  if (!state.room?.code) return Promise.resolve();
  if (latestEvent) state.latestEvent = latestEvent;
  const gameState = serializeGame({ latestEvent: state.latestEvent, status: state.status });
  return api.updateRoomState(state.room.code, { gameState, status: state.status, roomSettings: state.settings }).catch(error => {
    console.warn('No se pudo persistir el estado', error);
  });
}

function emit(type, data = {}) {
  if (!state.room?.code) return;
  const event = { ...data, type, id: data.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`, senderId: sid() };
  state.latestEvent = event;
  const payload = { ...event, gameState: serializeGame({ latestEvent: event }) };
  if (state.socketReady && state.socket?.send && !state.pollingTimer) state.socket.send(JSON.stringify(payload));
  else if (!state.pollingTimer) state.pendingMessages.push(payload);
  persistGameState(event);
}

function handleEvent(event, { fromPoll = false } = {}) {
  if (!event?.type) return;
  if (event.id && event.id === state.lastEventId && fromPoll) return;
  if (event.id) state.lastEventId = event.id;
  if (event.gameState) applyGameState(event.gameState);

  switch (event.type) {
    case 'player_joined':
      upsertPlayer(event.player);
      if (state.isHost && !fromPoll) emit('room_update', { players: state.players });
      break;
    case 'room_update':
      state.players = (event.players ?? state.players).map(normPlayer);
      break;
    case 'settings_update':
      state.settings = normalizeSettings(event.settings ?? state.settings);
      applySettingsToUI(state.settings);
      break;
    case 'answer_submitted':
      if (event.playerId && event.answer) {
        state.answers = { ...state.answers, [String(event.playerId)]: event.answer };
        if (state.isHost && state.status === 'playing' && allPlayersAnswered()) setTimeout(() => App.revealRound(), 120);
      }
      break;
    case 'round_revealed':
      launchConfetti('confetti-container', 70);
      break;
    case 'next_round':
    case 'game_started':
    case 'game_finished':
    case 'new_game':
      break;
  }
  saveActiveSession();
  routeByStatus();
}

async function mergeLatestRoomState() {
  if (!state.room?.code) return;
  try {
    const roomData = await api.getRoom(state.room.code);
    const gameState = extractGameState(roomData);
    applyGameState(gameState);
  } catch (error) {
    console.warn('No se pudo fusionar el estado de la sala', error);
  }
}

async function prepareUser() {
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
  try {
    const result = await api.createUser(username, 'mercaprecios', '');
    const user = { id: String(result.user_id ?? result.id ?? result.user?.id), username };
    state.user = user;
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    $('switch-user')?.classList.remove('hidden');
    return true;
  } catch (error) {
    if (error) {
      const fallback = { id: `local-${Date.now()}`, username };
      state.user = fallback;
      localStorage.setItem(USER_KEY, JSON.stringify(fallback));
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
  img.className = 'rounded-2xl';
  container.appendChild(img);
}

window.App = {
  async init() {
    restoreUser();
    await loadCatalog();
    const pendingCode = joinCodeFromUrl();
    if (pendingCode) {
      $('join-container')?.classList.remove('hidden');
      $('login-actions')?.classList.add('hidden');
      const input = $('input-room-code');
      if (input) input.value = pendingCode;
      sessionStorage.setItem('pending_room', pendingCode);
    }

    document.querySelectorAll('#keypad [data-key]').forEach(button => {
      button.addEventListener('click', () => App.pressKey(button.dataset.key));
    });

    document.querySelectorAll('#admin-settings input').forEach(input => {
      input.addEventListener('change', () => App.syncSettings());
      input.addEventListener('input', () => App.syncSettings());
    });
  },

  async createHomeRoom() {
    const button = $('btn-create-room');
    setBusy(button, true, 'Creando…');
    try {
      if (!(await prepareUser())) return;
      if (!state.products.length) {
        toast('Falta data/products.json con productos.', '⚠️');
        return;
      }
      await ensureGameId();
      syncSettingsFromUI();
      const player = currentPlayer();
      state.hostId = sid();
      state.isHost = true;
      state.players = [player];
      state.status = 'waiting';
      state.scores = { [sid()]: 0 };
      state.answers = {};
      state.gameProducts = [];
      state.currentRound = 0;
      state.reveal = null;
      const initialState = serializeGame({ status: 'waiting' });
      const roomResult = await api.createRoom(state.gameId, sid(), state.settings, initialState);
      state.room = normalizeRoom(roomResult);
      saveActiveSession();
      await connectRealtime(state.room.code);
      emit('player_joined', { player });
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
      if (!(await prepareUser())) return;
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
      applyGameState(extractGameState(roomData));
      upsertPlayer(currentPlayer());
      if (!state.players.length) state.players = [currentPlayer()];
      if (!state.hostId) state.hostId = String(state.players[0]?.id || '');
      saveActiveSession();
      await connectRealtime(state.room.code);
      emit('player_joined', { player: currentPlayer() });
      routeByStatus();
      toast('Has entrado en la sala', '✅');
    } catch (error) {
      console.error(error);
      if (error) {
        error.message = error.message || 'No se pudo entrar en la sala.';
      }
      if (error && $('join-error')) {
        $('join-error').textContent = error.message;
        $('join-error').classList.remove('hidden');
      }
    }
  },

  switchUser() {
    closeSocket(true);
    clearActiveSession();
    localStorage.removeItem(USER_KEY);
    state.user = null;
    state.room = null;
    $('switch-user')?.classList.add('hidden');
    if ($('input-username')) $('input-username').value = '';
    showScreen('login');
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

  syncSettings() {
    if (!state.isHost || state.status !== 'waiting') return;
    syncSettingsFromUI();
    emit('settings_update', { settings: state.settings });
  },

  async startGame() {
    if (!state.isHost) return;
    if (!state.products.length) {
      toast('No hay productos cargados.', '⚠️');
      return;
    }
    syncSettingsFromUI();
    state.gameProducts = pickProducts();
    if (!state.gameProducts.length) {
      toast('No hay productos para esas categorías.', '⚠️');
      return;
    }
    state.players.forEach(player => { state.scores[player.id] = 0; });
    state.currentRound = 0;
    state.answers = {};
    state.reveal = null;
    state.status = 'playing';
    state.roundEndsAt = Date.now() + state.settings.roundSeconds * 1000;
    await persistGameState();
    emit('game_started', {});
    renderGame();
  },

  pressKey(key) {
    if (state.answers[sid()] || state.status !== 'playing') return;
    if (/^\d$/.test(key)) {
      state.inputDigits = (state.inputDigits + key).replace(/^0+(?=\d)/, '').slice(0, 5);
    } else if (key === 'back') {
      state.inputDigits = state.inputDigits.slice(0, -1);
    } else if (key === 'clear') {
      state.inputDigits = '';
    }
    renderAnswerDisplay();
  },

  async submitAnswer() {
    if (state.status !== 'playing' || state.answers[sid()]) return;
    const value = inputValue();
    if (value <= 0) {
      toast('Pon un precio mayor que 0.', '💸');
      return;
    }
    await mergeLatestRoomState();
    const answer = { value, username: state.user.username, at: Date.now() };
    state.answers = { ...state.answers, [sid()]: answer };
    await persistGameState();
    emit('answer_submitted', { playerId: sid(), answer, player: currentPlayer() });
    renderAnswerDisplay();
    updateAnswerStatus();
    toast('Precio enviado', '✅');
    if (state.isHost && allPlayersAnswered()) setTimeout(() => App.revealRound(), 180);
  },

  async revealRound() {
    if (!state.isHost || state.status !== 'playing') return;
    await mergeLatestRoomState();
    if (state.status !== 'playing') return;
    state.reveal = calculateReveal();
    state.scores = state.reveal.scores;
    state.status = 'reveal';
    await persistGameState();
    emit('round_revealed', { reveal: state.reveal });
    launchConfetti('confetti-container', 70);
    renderReveal();
  },

  async nextRound() {
    if (!state.isHost || state.status !== 'reveal') return;
    if (state.currentRound + 1 >= state.gameProducts.length) {
      state.status = 'finished';
      await persistGameState();
      emit('game_finished', {});
      renderFinal();
      return;
    }
    state.currentRound += 1;
    state.answers = {};
    state.reveal = null;
    state.status = 'playing';
    state.roundEndsAt = Date.now() + state.settings.roundSeconds * 1000;
    await persistGameState();
    emit('next_round', {});
    renderGame();
  },

  async newGame() {
    if (!state.isHost) return;
    state.status = 'waiting';
    state.gameProducts = [];
    state.currentRound = 0;
    state.answers = {};
    state.reveal = null;
    state.players.forEach(player => { state.scores[player.id] = 0; });
    await persistGameState();
    emit('new_game', {});
    renderWaiting();
  },

  openShareModal() {
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

  exitToHome() {
    closeSocket(true);
    clearActiveSession();
    state.room = null;
    state.status = 'idle';
    history.replaceState({}, '', location.pathname);
    showScreen('login');
  },
};

window.addEventListener('keydown', event => {
  if (event.key === 'Escape') App.closeShareModal();
  if (state.status !== 'playing') return;
  if (/^\d$/.test(event.key)) App.pressKey(event.key);
  if (event.key === 'Backspace') App.pressKey('back');
  if (event.key === 'Enter') App.submitAnswer();
});

App.init();
