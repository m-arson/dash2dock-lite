import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../dock.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm, '')
  .replace(/^export /gm, '');

// Like Shell's shared watcher, deliver a callback only when pointer coordinates
// change. Removed callbacks are retained separately to exercise stale dispatch.
const watcher = {
  watches: new Set(),
  additions: 0,
  point: [0, 0],
  addWatch(interval, callback) {
    assert.equal(interval, 100, 'zoom recovery uses a shared low-frequency watch');
    this.additions++;
    const watch = {callback, remove: () => this.watches.delete(watch)};
    this.watches.add(watch);
    return watch;
  },
  move(x, y) {
    if (this.point[0] === x && this.point[1] === y) return;
    this.point = [x, y];
    for (const watch of [...this.watches]) watch.callback(x, y);
  },
};
const dependencies = {
  Main: {}, DashModule: {Dash: class {}},
  GObject: {registerClass: (...args) => args.at(-1)},
  St: {Widget: class {}}, Config: {PACKAGE_VERSION: '48'},
  Graphene: {Point: class {}},
  PointerWatcher: {getPointerWatcher: () => watcher},
};
const Dock = new Function(...Object.keys(dependencies), `${source}\nreturn Dock;`)(
  ...Object.values(dependencies));
function makeDock() {
  const dock = Object.create(Dock.prototype);
  dock.dash = {};
  dock.extension = {};
  dock.starts = 0;
  dock.hideChecks = 0;
  dock._beginAnimation = () => dock.starts++;
  dock._isWithinDash = ([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 40;
  dock.autohider = {_debounceCheckHide: () => dock.hideChecks++};
  return dock;
}

const dock = makeDock();
const initialAdditions = watcher.additions;
for (let frame = 0; frame < 120; frame++) dock._syncPointerWatch(true);
assert.equal(watcher.watches.size, 1, 'magnified frames retain one shared watch');
assert.equal(watcher.additions - initialAdditions, 1, 'frames do not recreate the watch');
watcher.move(20, 20);
assert.equal(dock.starts, 1, 'motion swallowed by a click grab wakes the zoom renderer');
assert.equal(dock.hideChecks, 0, 'motion within painted icons does not request hiding');
for (let interval = 0; interval < 120; interval++) watcher.move(20, 20);
assert.equal(dock.starts, 1, 'a stationary hovered icon does not restart frame work');
watcher.move(160, 80);
assert.equal(dock.starts, 2, 'a missed leave wakes the icon return animation');
assert.equal(dock.hideChecks, 1, 'a missed leave updates autohide state');
dock._dragging = true;
watcher.move(180, 90);
assert.equal(dock.starts, 2, 'dragging does not trigger zoom recovery');
assert.equal(dock.hideChecks, 1, 'dragging outside the dock does not request hiding');
dock._dragging = false;
watcher.move(200, 100);
assert.equal(dock.starts, 3, 'pointer recovery resumes when the drag ends');

// A stable magnified dock releases its frame loop, while retaining the shared
// movement watch so a later missed leave can still restart its return animation.
dock._updateFocusedIcon = () => {};
dock._settleAnimation();
assert.equal(watcher.watches.size, 1, 'settling retains recovery for a magnified icon');
const staleWatch = dock._pointerWatch;
dock._syncPointerWatch(false);
assert.equal(watcher.watches.size, 0, 'resting icons release the pointer watch');
const beforeStale = dock.starts;
staleWatch.callback(300, 200);
assert.equal(dock.starts, beforeStale, 'a removed watch cannot revive animations');
dock._syncPointerWatch(true);
staleWatch.callback(400, 300);
assert.equal(dock.starts, beforeStale, 'a previous watch cannot act on a new activation');
dock.cancelAnimations();
assert.equal(watcher.watches.size, 0, 'cancelAnimations releases zoom recovery');
assert.equal(dock._pointerWatch, null, 'cancelAnimations clears the watch reference');

for (const invalidState of ['_destroyed', '_hidden', 'dashMissing', 'dashDestroying']) {
  const testDock = makeDock();
  testDock._syncPointerWatch(true);
  const retained = testDock._pointerWatch;
  if (invalidState === 'dashMissing') testDock.dash = null;
  else if (invalidState === 'dashDestroying') testDock.dash._d2dlDestroying = true;
  else testDock[invalidState] = true;
  retained.callback(500, 400);
  assert.equal(watcher.watches.size, 0, `${invalidState} removes a remaining watch`);
  testDock._syncPointerWatch(true);
  retained.callback(600, 500);
  assert.equal(watcher.watches.size, 0, `${invalidState} cannot register a new watch`);
  assert.equal(testDock.starts, 0, `${invalidState} callbacks cannot revive animations`);
}

const hiding = makeDock();
hiding._syncPointerWatch(true);
hiding.slideOut();
assert.equal(watcher.watches.size, 0, 'hiding removes the watch before another pointer movement');

const ending = makeDock();
ending._syncPointerWatch(true);
ending._icons = [];
ending._updateFocusedIcon = () => {};
ending._endAnimation();
assert.equal(watcher.watches.size, 0, 'ending animation releases zoom recovery');
ending._syncPointerWatch(true);
ending._destroyed = true;
ending._endAnimation();
assert.equal(watcher.watches.size, 0, 'ending after destruction still releases zoom recovery');

console.log('Zoom exit regressions passed (missed leave recovery and watch lifecycle)');
