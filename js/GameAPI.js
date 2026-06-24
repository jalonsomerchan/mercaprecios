/**
 * Librería para interactuar con la API de juegos de alon.one
 */
class GameAPI {
  constructor(baseURL = 'https://alon.one/juegos/api') {
    this.baseURL = baseURL.replace(/\/$/, '');
  }

  async _request(endpoint, method = 'GET', data = null) {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      }
    };

    if (data !== null && data !== undefined) options.body = JSON.stringify(data);

    try {
      const response = await fetch(`${this.baseURL}/${endpoint}`, options);
      const text = await response.text();
      let result = {};

      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        result = { error: text || `Respuesta no JSON (${response.status})` };
      }

      if (!response.ok) throw new Error(result.error || `Error: ${response.status}`);
      return result;
    } catch (error) {
      console.error(`API Error (${method} ${endpoint}):`, error);
      throw error;
    }
  }

  async createUser(username, password, email = '') {
    return this._request('users', 'POST', { username, password, email });
  }

  async createGame(name, maxPlayers, defaultConfig = {}) {
    return this._request('games', 'POST', {
      name,
      max_players_per_room: maxPlayers,
      default_config: defaultConfig
    });
  }

  async createRoom(gameId, hostId, roomSettings = {}, initialState = { status: 'waiting' }) {
    return this._request('rooms', 'POST', {
      game_id: gameId,
      host_id: hostId,
      room_settings: roomSettings,
      game_state: initialState
    });
  }

  async getRoom(roomCode) {
    return this._request(`rooms/${roomCode}`, 'GET');
  }

  async joinRoom(roomCode, userId) {
    return this._request(`rooms/${roomCode}/join`, 'POST', { user_id: userId });
  }

  async updateRoomState(roomCode, { gameState, status, roomSettings }) {
    const payload = {};
    if (gameState !== undefined) payload.game_state = gameState;
    if (status !== undefined) payload.status = status;
    if (roomSettings !== undefined) payload.room_settings = roomSettings;
    return this._request(`rooms/${roomCode}/state`, 'PATCH', payload);
  }

  async saveScore(userId, gameId, scoreValue, roomId = null, metadata = {}) {
    return this._request('scores', 'POST', {
      user_id: userId,
      game_id: gameId,
      room_id: roomId,
      score_value: scoreValue,
      metadata
    });
  }
}

window.GameAPI = GameAPI;
