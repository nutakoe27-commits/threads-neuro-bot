import { Game } from './game.js';
import { getMap } from './maps.js';
import { load, save } from './storage.js';

const KEY = 'replays';
const MAX_REPLAYS = 8;

// A replay is just the setup plus every command that was issued, including the
// bots' — the simulation is deterministic, so re-running them reproduces the
// match exactly.
export function serializeSetup(setup) {
  return {
    mapId: setup.map.custom ? null : setup.map.id,
    mapDef: setup.map.custom ? setup.map : null,
    seed: setup.seed,
    slots: setup.slots,
  };
}

export function deserializeSetup(data) {
  return {
    map: data.mapDef || getMap(data.mapId),
    seed: data.seed,
    slots: data.slots,
  };
}

export function buildReplay(session) {
  return {
    id: `r${Date.now().toString(36)}`,
    name: `${session.setup.map.name} — ${new Date().toLocaleString()}`,
    mapName: session.setup.map.name,
    date: Date.now(),
    duration: session.game.time,
    winnerTeam: session.game.winnerTeam,
    viewerFaction: session.viewerFaction,
    setup: serializeSetup(session.setup),
    commands: session.game.commandLog,
  };
}

export function listReplays() {
  return load(KEY, []);
}

export function saveReplay(replay) {
  const all = listReplays();
  all.unshift(replay);
  save(KEY, all.slice(0, MAX_REPLAYS));
}

export function deleteReplay(id) {
  save(KEY, listReplays().filter((r) => r.id !== id));
}

// Deterministic playback: no AI controllers, commands are injected by tick.
export class ReplayPlayer {
  constructor(replay) {
    this.replay = replay;
    this.reset();
  }

  reset() {
    this.game = new Game(deserializeSetup(this.replay.setup));
    this.game.recording = false;
    this.cursor = 0;
    this.commands = this.replay.commands;
  }

  get finished() {
    return this.game.over || (this.cursor >= this.commands.length && this.game.time >= this.replay.duration);
  }

  step() {
    while (this.cursor < this.commands.length && this.commands[this.cursor].tick <= this.game.tickCount) {
      this.game.inject(this.commands[this.cursor]);
      this.cursor++;
    }
    this.game.step();
  }

  // Scrubbing re-simulates from tick 0; matches are short enough that this is
  // cheaper and simpler than keeping snapshots around.
  seek(targetTick) {
    if (targetTick < this.game.tickCount) this.reset();
    let guard = 0;
    while (this.game.tickCount < targetTick && !this.game.over && guard++ < 200000) this.step();
  }
}
