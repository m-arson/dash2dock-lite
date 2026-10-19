import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

let actors = [];
let pointer = [500, 500];
const context = vm.createContext({
  console: {log() {}}, Meta: {WindowType: {NORMAL: 0}},
  DockPosition: {LEFT: 'left', RIGHT: 'right', TOP: 'top', BOTTOM: 'bottom'},
  global: {get_pointer: () => pointer, get_window_actors: () => actors,
    workspace_manager: {get_active_workspace_index: () => 0}},
  isInRect: () => false, isOverlapRect: () => true,
});
vm.runInContext(readFileSync(new URL('../autohide.js', import.meta.url), 'utf8')
  .replace(/^import\s[\s\S]*?;\n/gm, '').replace(/export /g, '') +
  '\nglobalThis.AutoHide = AutoHide;', context);
let pending = new Set();
let schedules = 0;
let restarts = 0;
const timer = {
  runDebounced(callback) {
    if (typeof callback === 'object') restarts++;
    else schedules++;
    const job = typeof callback === 'object' ? callback : {callback};
    pending.add(job); return job;
  }, cancel(job) { pending.delete(job); },
};
let broadcasts = 0;
const extension = {_loTimer: timer, _hiTimer: timer,
  autohide_dash: true, autohide_dodge: true, checkHide() { broadcasts++; }};
function makeAutoHide() {
  const autohide = new context.AutoHide();
  autohide.extension = extension;
  autohide.dock = {
    _monitor: {index: 0, inFullscreen: false},
    struts: {width: 100, height: 30, get_transformed_position: () => [0, 0]},
    slideIn() { this.shown = true; }, slideOut() { this.shown = false; },
    _isWithinDash: () => false, extension,
  };
  autohide.enable();
  return autohide;
}
const owners = new Set();
const listeners = new Map();
let workspace = null;
const window = {
  connectObject(...args) {
    const owner = args.at(-1);
    owners.add(owner);
    listeners.set(owner, Object.fromEntries(args.slice(0, -1)
      .reduce((pairs, value, index, values) => {
        if (index % 2 === 0) pairs.push([value, values[index + 1]]);
        return pairs;
      }, [])));
  },
  disconnectObject(owner) { owners.delete(owner); listeners.delete(owner); },
  can_close: () => true, get_monitor: () => 0,
  get_workspace: () => workspace, showing_on_its_workspace: () => true,
  get_window_type: () => 0,
  get_frame_rect: () => ({x: 0, y: 0, width: 100, height: 100}),
};
actors = [{get_meta_window: () => window}];
const first = makeAutoHide();
assert.equal(first._checkOverlap(), false, 'unmanaged window may lack a workspace');
workspace = {index: () => 0};
assert.equal(first._checkOverlap(), true);
const second = makeAutoHide();
second._checkOverlap();
assert.equal(owners.size, 2, 'each dock tracks windows independently');
first.disable();
assert.equal(owners.size, 1);
actors = [];
second._checkOverlap();
assert.equal(owners.size, 0, 'stale window references are released');
second.dock._monitor.inFullscreen = true;
second.dock._isWithinDash = () => true;
assert.equal(second._checkOverlap(), true, 'fullscreen takes priority over a pointer inside the dock');
extension._inOverview = true;
assert.equal(second._checkOverlap(), false, 'overview can reveal a fullscreen dock');
extension._inOverview = false;
second.dock.shown = false;
second.disable();
assert.equal(second.dock.shown, true, 'disabling autohide restores a hidden fullscreen dock');
assert.equal(pending.size, 0);
second._debounceCheckHide();
assert.equal(pending.size, 0, 'disabled autohide cannot schedule callbacks');
const third = makeAutoHide();
extension.pressure_sense = true;
third._shown = false;
third.dock._monitor = {x: 0, y: 0, width: 100, height: 100};
third.dock.isVertical = () => true;
third.dock._position = 'right';
for (let i = 0; i < 100; i++) third._onMotionEvent();
assert.equal(third._shown, false, 'pressure on an adjacent monitor cannot reveal this dock');
pointer = [99, 50];
for (let i = 0; i < 100; i++) third._onMotionEvent();
assert.equal(third._shown, true, 'pressure on the actual monitor edge reveals the dock');
third.disable();

// Each dock already owns its window listeners. A native motion signal must
// schedule one local check, instead of broadcasting once per dock to all docks.
actors = [{get_meta_window: () => window}];
const fourth = makeAutoHide();
const fifth = makeAutoHide();
function flushChecks() {
  const jobs = [...pending];
  pending.clear();
  for (const job of jobs) job.callback();
}
flushChecks();
assert.equal(listeners.size, 2);
const scheduledBefore = schedules;
for (let event = 0; event < 100; event++) {
  for (const callbacks of listeners.values()) {
    callbacks['position-changed']();
    callbacks['size-changed']();
  }
}
assert.equal(broadcasts, 0, 'window motion must never multiply across docks');
assert.equal(schedules - scheduledBefore, 2, 'a motion burst queues one check per dock');
assert.equal(restarts, 0, 'continued motion cannot postpone checks indefinitely');
assert.equal(pending.size, 2);
flushChecks();
for (const callbacks of listeners.values()) callbacks['position-changed']();
assert.equal(schedules - scheduledBefore, 4, 'checks remain responsive throughout a long window drag');

let laterTracks = 0;
const laterWindow = {
  connectObject() { laterTracks++; }, disconnectObject() {},
  can_close() { throw new Error('geometry/state queries should stop after overlap is known'); },
};
actors.push({get_meta_window: () => laterWindow});
assert.equal(fourth._checkOverlap(), true);
assert.equal(laterTracks, 1, 'later windows are still tracked even after finding overlap');
fourth.disable();
fifth.disable();
assert.equal(pending.size, 0, 'all outstanding local overlap checks are cancelled on shutdown');
assert.equal(listeners.size, 0, 'all window listeners are released on shutdown');
console.log('Autohide regression tests passed');
