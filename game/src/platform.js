// Optional portal integration (CrazyGames). The game is fully playable without
// it: if the SDK is absent, blocked, or slow, every call quietly no-ops.
let sdk = null;
let ready = false;
let inGameplay = false;

const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

export async function initPlatform({ enabled = true, timeoutMs = 4000 } = {}) {
  if (!enabled) return false;
  // Only bother inside an iframe — that is how portals embed the game.
  if (window.self === window.top) return false;
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
      setTimeout(reject, timeoutMs);
    });
    sdk = window.CrazyGames?.SDK || null;
    if (!sdk) return false;
    await sdk.init?.();
    ready = true;
    return true;
  } catch {
    sdk = null;
    ready = false;
    return false;
  }
}

function call(path, ...args) {
  if (!ready || !sdk) return;
  try {
    const parts = path.split('.');
    let ctx = sdk;
    for (let i = 0; i < parts.length - 1; i++) ctx = ctx?.[parts[i]];
    ctx?.[parts[parts.length - 1]]?.(...args);
  } catch {
    /* the portal is never allowed to break the game */
  }
}

export const platform = {
  get available() {
    return ready;
  },
  loadingStart() {
    call('game.loadingStart');
  },
  loadingStop() {
    call('game.loadingStop');
  },
  gameplayStart() {
    if (inGameplay) return;
    inGameplay = true;
    call('game.gameplayStart');
  },
  gameplayStop() {
    if (!inGameplay) return;
    inGameplay = false;
    call('game.gameplayStop');
  },
  happytime() {
    call('game.happytime');
  },
};
