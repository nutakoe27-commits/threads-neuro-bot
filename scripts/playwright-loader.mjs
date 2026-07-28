import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

// Resolves Playwright from a local install first, then from the global npm
// root. Keeping this out of the npm scripts means the tooling works the same
// on macOS, Linux and CI without a hardcoded NODE_PATH.
export function loadPlaywright() {
  const attempts = [];

  try {
    return createRequire(import.meta.url)('playwright');
  } catch (e) {
    attempts.push(`local node_modules (${e.code || 'not found'})`);
  }

  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return createRequire(path.join(globalRoot, 'index.js'))('playwright');
  } catch (e) {
    attempts.push(`global npm root (${e.code || 'not found'})`);
  }

  throw new Error(
    `Playwright is required for this script but was not found.\n` +
      `  Tried: ${attempts.join(', ')}\n` +
      `  Install it with:  npm install -D playwright && npx playwright install chromium`,
  );
}
