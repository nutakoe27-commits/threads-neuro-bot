// Thin, failure-tolerant wrapper around localStorage. Portals like CrazyGames
// can run the game in a sandboxed iframe where storage throws, so every call
// degrades to an in-memory fallback instead of breaking the game.
const PREFIX = 'wod:';
const memory = new Map();

function backend() {
  try {
    const probe = `${PREFIX}__probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

const store = backend();

export function load(key, fallback) {
  try {
    const raw = store ? store.getItem(PREFIX + key) : memory.get(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  const raw = JSON.stringify(value);
  try {
    if (store) store.setItem(PREFIX + key, raw);
    else memory.set(key, raw);
  } catch {
    memory.set(key, raw);
  }
}

export function remove(key) {
  try {
    if (store) store.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
  memory.delete(key);
}
