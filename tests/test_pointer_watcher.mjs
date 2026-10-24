import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../pointerWatcher.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

function fixture({modern = true, initiallyIdle = false, backendIdle = true} = {}) {
  let nextId = 1;
  let pointer = [10, 20];
  const timers = new Map();
  const laterCallbacks = new Map();
  const signals = new Map();
  const idleCallbacks = new Map();
  const errors = [];
  let pointerReads = 0;
  let trackerReads = 0;
  const tracker = {
    connect(name, callback) {
      assert.equal(name, 'position-invalidated');
      if (!modern) throw new Error('unknown signal');
      const id = nextId++;
      signals.set(id, callback);
      return id;
    },
    disconnect(id) { assert.ok(signals.delete(id)); },
    get_pointer() { trackerReads++; return [{x: pointer[0], y: pointer[1]}, 0]; },
  };
  const laters = {
    add(type, callback) {
      assert.equal(type, 'before-redraw');
      const id = nextId++;
      laterCallbacks.set(id, callback);
      return id;
    },
    remove(id) { assert.ok(laterCallbacks.delete(id)); },
  };
  const monitor = {
    get_idletime: () => initiallyIdle ? 1500 : 0,
    add_idle_watch(delay, callback) {
      assert.equal(delay, 1000);
      const id = nextId++;
      idleCallbacks.set(id, {type: 'idle', callback});
      return id;
    },
    add_user_active_watch(callback) {
      const id = nextId++;
      idleCallbacks.set(id, {type: 'active', callback});
      return id;
    },
    remove_watch(id) { assert.ok(idleCallbacks.delete(id)); },
  };
  const global = {
    backend: {
      get_cursor_tracker: () => tracker,
      ...(backendIdle ? {get_core_idle_monitor: () => monitor} : {}),
    },
    compositor: {get_laters: () => laters},
    get_pointer() { pointerReads++; return [...pointer, 0]; },
  };
  const Meta = {LaterType: {BEFORE_REDRAW: 'before-redraw'},
    IdleMonitor: {get_core: () => monitor}};
  const GLib = {
    PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
    timeout_add(priority, interval, callback) {
      assert.equal(priority, 0);
      const id = nextId++;
      timers.set(id, {interval, callback});
      return id;
    },
    source_remove(id) { assert.ok(timers.delete(id)); },
  };
  const getPointerWatcher = new Function('GLib', 'Meta', 'global', 'console', `${source}\nreturn getPointerWatcher;`)(
    GLib, Meta, global, {error: (...args) => errors.push(args)});
  const watcher = getPointerWatcher();
  return {
    watcher, getPointerWatcher, timers, laterCallbacks, signals, idleCallbacks, errors, tracker, global,
    reads: () => ({pointerReads, trackerReads}),
    setPointer: (x, y) => { pointer = [x, y]; },
    invalidate() { for (const callback of [...signals.values()]) callback(); },
    paint() {
      const current = [...laterCallbacks];
      for (const [id, callback] of current) {
        laterCallbacks.delete(id);
        assert.equal(callback(), false);
      }
    },
    poll() {
      const [id, entry] = [...timers][0] ?? [];
      assert.ok(id, 'poll only with a live source');
      timers.delete(id);
      assert.equal(entry.callback(), false);
    },
    idle() {
      for (const entry of [...idleCallbacks.values()]) if (entry.type === 'idle') entry.callback();
    },
    active() {
      for (const [id, entry] of [...idleCallbacks]) {
        if (entry.type !== 'active') continue;
        idleCallbacks.delete(id);
        entry.callback();
      }
    },
  };
}

{
  const f = fixture();
  assert.equal(f.getPointerWatcher(), f.watcher, 'docks share one watcher');
  assert.equal(f.signals.size + f.timers.size + f.idleCallbacks.size, 0,
    'unused singleton holds no backend resources');
  const points = [];
  const watch = f.watcher.addWatch(100, (x, y) => points.push([x, y]));
  assert.deepEqual(points, [], 'registering never calls back synchronously');
  assert.equal(f.signals.size, 1);
  assert.equal(f.timers.size + f.idleCallbacks.size, 0,
    'modern tracking uses compositor invalidation without polling or idle watches');
  const baselineReads = f.reads();
  for (let frame = 0; frame < 100; frame++) f.paint();
  assert.deepEqual(f.reads(), baselineReads, 'stationary modern hover performs no sampling');
  f.setPointer(30, 40);
  for (let event = 0; event < 100; event++) f.invalidate();
  assert.equal(f.laterCallbacks.size, 1, 'motion bursts share one before-redraw callback');
  assert.deepEqual(points, []);
  f.paint();
  assert.deepEqual(points, [[30, 40]]);
  assert.equal(f.laterCallbacks.size + f.timers.size, 0, 'motion never creates a repeating source');
  f.invalidate();
  f.paint();
  assert.equal(points.length, 1, 'unchanged coordinates do not wake animation');
  const other = f.watcher.addWatch(50, (x, y) => points.push(['other', x, y]));
  assert.equal(f.signals.size, 1, 'additional docks reuse the native signal');
  watch.remove();
  assert.equal(f.signals.size, 1);
  f.setPointer(-15, 4.5);
  f.invalidate();
  f.paint();
  assert.deepEqual(points.at(-1), ['other', -15, 4.5], 'negative/fractional native positions are retained');
  other.remove();
  other.remove();
  assert.equal(f.signals.size + f.laterCallbacks.size + f.timers.size + f.idleCallbacks.size, 0,
    'last removal releases all resources and is idempotent');
}

{
  const f = fixture();
  let callbacks = 0;
  const old = f.watcher.addWatch(100, () => callbacks++);
  const staleSignal = [...f.signals.values()][0];
  f.setPointer(50, 60);
  f.invalidate();
  const staleLater = [...f.laterCallbacks.values()][0];
  old.remove();
  assert.equal(f.laterCallbacks.size, 0, 'last removal cancels an outstanding frame callback');
  const fresh = f.watcher.addWatch(100, () => callbacks++);
  staleSignal();
  staleLater();
  assert.equal(f.laterCallbacks.size, 0, 'old signal cannot schedule into a new watch lifetime');
  assert.equal(callbacks, 0, 'old callback cannot affect a new watch lifetime');
  fresh.remove();
}

{
  const f = fixture();
  const calls = [];
  let laterWatch;
  let added;
  const first = f.watcher.addWatch(100, () => {
    calls.push('first');
    laterWatch.remove();
    if (!added) added = f.watcher.addWatch(100, () => calls.push('new'));
    throw new Error('disposed subscriber');
  });
  laterWatch = f.watcher.addWatch(100, () => calls.push('removed'));
  const last = f.watcher.addWatch(100, () => calls.push('last'));
  f.setPointer(20, 30); f.invalidate(); f.paint();
  assert.deepEqual(calls, ['first', 'last'], 'removed/new callbacks do not join a current dispatch');
  assert.equal(f.errors.length, 1, 'one subscriber failure does not block other docks');
  f.setPointer(25, 35); f.invalidate(); f.paint();
  assert.deepEqual(calls.slice(2), ['first', 'last', 'new']);
  first.remove(); last.remove(); added.remove();
  assert.equal(f.signals.size, 0);
}

for (const backendIdle of [true, false]) {
  const f = fixture({modern: false, backendIdle});
  const points = [];
  const watch = f.watcher.addWatch(100, (x, y) => points.push([x, y]));
  assert.deepEqual(points, []);
  assert.equal(f.signals.size, 0);
  assert.equal(f.idleCallbacks.size, 1, 'legacy watches share one idle monitor');
  assert.equal([...f.timers.values()][0].interval, 100);
  f.poll();
  assert.deepEqual(points, [], 'legacy polling samples silently while stationary');
  f.setPointer(25, 35); f.poll();
  assert.deepEqual(points, [[25, 35]]);
  const quicker = f.watcher.addWatch(25, () => {});
  assert.equal([...f.timers.values()][0].interval, 25, 'legacy sampling uses the shortest requested interval');
  quicker.remove();
  assert.equal([...f.timers.values()][0].interval, 100);
  f.idle();
  assert.equal(f.timers.size, 0, 'idle legacy pointer sleeps without polling');
  assert.equal(f.idleCallbacks.size, 2, 'idle has one one-shot active watch');
  f.idle();
  assert.equal(f.idleCallbacks.size, 2, 'repeated idle does not duplicate resume watches');
  f.setPointer(90, 95); f.active();
  assert.equal(f.timers.size, 1, 'user activity resumes the sampler');
  assert.equal(points.length, 1, 'resuming does not synchronously dispatch callbacks');
  f.poll();
  assert.deepEqual(points.at(-1), [90, 95]);
  const stalePoll = [...f.timers.values()][0].callback;
  const staleIdle = [...f.idleCallbacks.values()][0].callback;
  watch.remove();
  assert.equal(f.timers.size + f.idleCallbacks.size, 0, 'last legacy watch releases timer and idle subscription');
  const fresh = f.watcher.addWatch(100, () => points.push('fresh'));
  const newTimer = [...f.timers.keys()][0];
  stalePoll(); staleIdle();
  assert.equal([...f.timers.keys()][0], newTimer, 'old legacy callbacks cannot remove a new generation timer');
  fresh.remove();
}

{
  const f = fixture({modern: false, initiallyIdle: true});
  const watch = f.watcher.addWatch(100, () => assert.fail('idle registration dispatched'));
  assert.equal(f.timers.size, 0, 'registering while idle does not start polling');
  assert.equal(f.idleCallbacks.size, 2);
  watch.remove();
  assert.equal(f.idleCallbacks.size, 0, 'removal while idle releases both native watches');
}

for (const missingAPI of ['backend', 'laters']) {
  const f = fixture();
  if (missingAPI === 'backend') f.global.backend = undefined;
  else f.global.compositor = undefined;
  let points = 0;
  const watch = f.watcher.addWatch(100, () => points++);
  assert.equal(f.signals.size, 0, `${missingAPI}: old backends use the polling fallback`);
  assert.equal(f.timers.size, 1);
  f.setPointer(70, 80); f.poll();
  assert.equal(points, 1);
  watch.remove();
  assert.equal(f.timers.size + f.idleCallbacks.size, 0);
}

{
  const f = fixture();
  const points = [];
  f.tracker.get_pointer = () => [1, 2, 0];
  const watch = f.watcher.addWatch(100, (x, y) => points.push([x, y]));
  f.tracker.get_pointer = () => [3, 4, 0];
  f.invalidate(); f.paint();
  assert.deepEqual(points, [[3, 4]], 'numeric tracker tuples remain compatible');
  watch.remove();
}

{
  const f = fixture();
  let calls = 0;
  f.tracker.get_pointer = () => { throw new Error('tracker unavailable'); };
  const watch = f.watcher.addWatch(100, () => calls++);
  f.setPointer(55, 66); f.invalidate(); f.paint();
  assert.equal(calls, 1, 'temporary tracker query failure uses Shell global pointer coordinates');
  watch.remove();
  for (const interval of [0, -1, NaN, Infinity])
    assert.throws(() => f.watcher.addWatch(interval, () => {}), TypeError);
  assert.throws(() => f.watcher.addWatch(100, null), TypeError);
  assert.equal(f.signals.size + f.timers.size + f.idleCallbacks.size, 0);
}

console.log('Pointer watcher compatibility regressions passed (native invalidation, idle-aware legacy sampling, shared lifecycle)');
