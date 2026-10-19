import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

function load(name, declaration, dependencies) {
  const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm, '')
    .replace(/^export default /gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(dependencies), `${source}\nreturn ${declaration};`)(
    ...Object.values(dependencies));
}

const monitor = {x: 1920, y: 0, width: 1920, height: 1080, geometry_scale: 2};
const dependencies = {
  Main: {layoutManager: {monitors: [monitor], primaryMonitor: monitor}},
  DashModule: {Dash: class {}}, GObject: {registerClass: (...args) => args.at(-1)},
  St: {Widget: class {}}, Config: {PACKAGE_VERSION: '48'},
  Clutter: {TextDirection: {LTR: 0, RTL: 1}, Orientation: {HORIZONTAL: 0, VERTICAL: 1}},
  Graphene: {Point: class {}},
};
const Dock = load('dock.js', 'Dock', dependencies);
const dock = Object.create(Dock.prototype);
dock.extension = {icon_size: 0.5, scale: 1, icon_spacing: 0.5,
  animation_spread: 0.5, animation_magnify: 0.5, edge_distance: 0,
  _config: {}, apps_icon_front: false};
dock.dash = {last_child: {layout_manager: {}}, _box: {layout_manager: {}},
  width: 300, height: 64};
dock.dwell = {};
dock.getMonitor = () => monitor;
const icons = Array.from({length: 8}, () => ({}));
dock._findIcons = () => icons;
let reconciliations = 0;
dock._updateExtraIcons = () => reconciliations++;
let sizeComputations = 0;
dock._preferredIconSize = () => { sizeComputations++; return 48; };
let width = 0, height = 0, resizes = 0;
Object.defineProperties(dock, {
  width: {get: () => width, set: value => { if (width !== value) resizes++; width = value; }},
  height: {get: () => height, set: value => { if (height !== value) resizes++; height = value; }},
});
dock.layout();
const initialResizes = resizes;
for (let frame = 0; frame < 120; frame++) dock.layout();
assert.equal(resizes, initialResizes, 'stable frames cannot resize through full-monitor dimensions');
assert.equal(sizeComputations, 1, 'stable frames reuse layout calculations');
const previousWidth = dock.width;
monitor.width = 2560;
dock.layout();
assert.notEqual(dock.width, previousWidth, 'monitor changes invalidate the layout');
const oldSize = dock._iconSizeScaledDown;
dock.extension.icon_spacing = 1;
dock.layout();
assert.equal(sizeComputations, 3, 'settings changes invalidate the layout');
dock.extension.dock_location = 1;
dock.layout();
assert.equal(dock.height, monitor.height, 'vertical docks use monitor height');
assert.ok(dock.width < monitor.width && oldSize > 0, 'vertical dock retains finite thickness');

const active = new Set();
const timer = {cancel: sequence => active.delete(sequence)};
dock.extension._hiTimer = timer;
dock.extension._loTimer = timer;
dock._animationSeq = {};
dock.debounceEndSeq = {};
active.add(dock._animationSeq);
active.add(dock.debounceEndSeq);
dock._icons = [{_icon: {translation_x: 20}, _renderer: {scale_x: 1.5}}];
dock._settleAnimation();
assert.equal(active.size, 0, 'settled docks release both animation and end timers');
assert.equal(dock._icons[0]._icon.translation_x, 20, 'settling preserves the hovered position');
assert.equal(dock._icons[0]._renderer.scale_x, 1.5, 'settling preserves the hovered scale');
let starts = 0;
dock._beginAnimation = () => starts++;
dock._debounceEndAnimation = () => {};
dock.autohider = {_debounceCheckHide() {}};
dock._onLeaveEvent();
assert.equal(starts, 1, 'leaving a settled dock restarts its return animation');
console.log('Dock resource regressions passed (120 unchanged frames reuse one layout)');

let now = 0;
const session = {isLocked: false, isGreeter: false};
const Extension = load('extension.js', 'Dash2DockLiteExt', {
  Main: {sessionMode: session}, Extension: class {},
  GLib: {get_monotonic_time: () => now * 1000},
});
const extension = new Extension();
let enabled = false;
let remaining = 60000;
let callbacks = 0;
const jobs = new Set();
extension._enabled = true;
extension._timer = {
  cancel(job) { jobs.delete(job); },
  stop() { this.running = false; },
  start(delay) { this.delay = delay; this.running = true; },
  runOnce(callback, delay) {
    const job = {delay, callback() { jobs.delete(job); callback(); }};
    jobs.add(job);
    return job;
  },
};
extension.services = {
  nextUpdateDelay: () => enabled ? remaining : null,
  update(elapsed) {
    if (!enabled) return;
    remaining -= elapsed;
    if (remaining <= 0) { callbacks++; remaining = 60000 - (-remaining % 60000); }
  },
};
extension._syncServiceTimer();
assert.equal(jobs.size, 0, 'disabled widgets require no service timer');
enabled = true;
extension._syncServiceTimer();
assert.equal(extension._timer.delay, 60000, 'clock-only work sleeps a full minute between updates');
assert.equal(jobs.size, 1, 'service rescheduling retains one timer');
now = 30000;
extension._syncServiceTimer();
assert.equal(extension._timer.delay, 30000, 'rescheduling preserves elapsed time');
now = 70000;
[...jobs][0].callback();
assert.equal(callbacks, 1, 'delayed service callbacks use real elapsed time');
assert.equal(extension._timer.delay, 50000, 'late callbacks preserve the next deadline');
session.isLocked = true;
extension._syncServiceTimer();
assert.equal(jobs.size, 0, 'locked sessions require no service timer');
assert.equal(extension._timer.running, false, 'lock releases the service source');
console.log('Service scheduler regressions passed (no idle polling; deadline-based wakeups)');
