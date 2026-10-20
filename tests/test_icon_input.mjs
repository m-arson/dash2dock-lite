// Exercise the actual dock input methods with stage transforms, without a
// desktop. The native button remains the event target throughout magnification.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

class Actor {
  constructor(params = {}) {
    this.values = {x: 0, y: 0, width: 32, height: 32, scale_x: 1, scale_y: 1,
      translation_x: 0, translation_y: 0};
    this.writes = 0;
    this.allocationWrites = 0;
    for (const name of Object.keys(this.values)) {
      Object.defineProperty(this, name, {
        get: () => this.values[name],
        set: value => {
          this.writes++;
          if (['x', 'y', 'width', 'height'].includes(name)) this.allocationWrites++;
          this.values[name] = value;
        },
      });
    }
    Object.assign(this, {visible: true, opacity: 255, reactive: true,
      pivot_point: {x: 0, y: 0}, children: [], listeners: new Map()}, params);
    this.writes = this.allocationWrites = 0;
  }
  get_parent() { return this.parent ?? null; }
  add_child(child) { this.children.push(child); child.parent = this; }
  get_children() { return this.children; }
  get_n_children() { return this.children.length; }
  get_pivot_point() { return [this.pivot_point.x, this.pivot_point.y]; }
  get_scale() { return [this.scale_x, this.scale_y]; }
  set_scale(x, y) { this.scale_x = x; this.scale_y = y; }
  set_translation(x, y, z = 0) {
    this.translation_x = x; this.translation_y = y; this.translation_z = z;
  }
  get_size() { return [this.width, this.height]; }
  get_position() { return [this.x, this.y]; }
  get_allocation_box() {
    return {x1: this.x, y1: this.y, x2: this.x + this.width, y2: this.y + this.height,
      get_width: () => this.width, get_height: () => this.height};
  }
  _stageScale() {
    const [px, py] = this.parent?._stageScale() ?? [1, 1];
    return [px * this.scale_x, py * this.scale_y];
  }
  _stagePoint(x, y) {
    const point = [this.x + this.translation_x + this.width * this.pivot_point.x *
      (1 - this.scale_x) + x * this.scale_x,
    this.y + this.translation_y + this.height * this.pivot_point.y *
      (1 - this.scale_y) + y * this.scale_y];
    return this.parent ? this.parent._stagePoint(...point) : point;
  }
  get_transformed_position() { return this._stagePoint(0, 0); }
  get_transformed_size() {
    const [x, y] = this._stageScale();
    return [this.width * x, this.height * y];
  }
  transform_stage_point(x, y) {
    const [sx, sy] = this._stageScale();
    const [px, py] = this.get_transformed_position();
    return [true, (x - px) / sx, (y - py) / sy];
  }
  connect(name, callback) {
    this.listeners.set(name, callback);
    return this.listeners.size;
  }
  emit(name, ...args) { return this.listeners.get(name)?.(...args); }
}

const tracked = new Set();
let tracks = 0;
let untracks = 0;
let regionQueues = 0;
let wayland = true;
const layoutManager = {
  trackChrome(actor, params) {
    assert.equal(params.affectsInputRegion, true);
    assert.equal(tracked.has(actor), false, 'chrome is tracked only once');
    tracked.add(actor); tracks++;
  },
  untrackChrome(actor) {
    assert.equal(tracked.delete(actor), true, 'only tracked native buttons are untracked');
    untracks++;
  },
  _queueUpdateRegions() { regionQueues++; },
};
const isInRect = ([x, y, width, height], [px, py], pad = 0) =>
  px + pad >= x && px - pad < x + width && py + pad >= y && py - pad < y + height;
const source = readFileSync(new URL('../dock.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm, '')
  .replace(/^export /gm, '');
function loadDock(shellVersion = '48.7') {
  const dependencies = {
    Main: {layoutManager}, DashModule: {Dash: class {}},
    GObject: {registerClass: (...args) => args.at(-1)},
    St: {Widget: Actor, Icon: Actor}, Config: {PACKAGE_VERSION: shellVersion},
    Clutter: {}, Graphene: {Point: class {}},
    Meta: {is_wayland_compositor: () => wayland},
    PointerWatcher: {getPointerWatcher: () => ({addWatch() {}})}, isInRect,
  };
  return new Function(...Object.keys(dependencies), `${source}\nreturn Dock;`)(
    ...Object.values(dependencies));
}
const Dock = loadDock();
function fixture(DockClass = Dock) {
  // The native button has a non-square allocation and a centered pivot, within
  // a scaled monitor at a negative stage origin. The renderer has its own tree.
  const nativeRoot = new Actor({x: -1920, y: -1080, width: 1000, height: 600,
    scale_x: 2, scale_y: 2});
  const container = new Actor({x: 75, y: 52, width: 60, height: 60});
  nativeRoot.add_child(container);
  const button = new Actor({x: 7, y: 11, width: 42, height: 30,
    scale_x: 0.8, scale_y: 1.2, translation_x: 3, translation_y: -4,
    pivot_point: {x: 0.5, y: 0.5}});
  container.add_child(button);
  const renderRoot = new Actor({x: -1920, y: -1080, width: 1000, height: 600});
  const renderer = new Actor({x: 105, y: 60, width: 32, height: 32,
    scale_x: 3, scale_y: 3, reactive: false});
  renderRoot.add_child(renderer);
  const icon = {_appwell: button, child: button, _renderer: renderer,
    _icon: new Actor(), width: 60, height: 60};
  const dock = Object.create(DockClass.prototype);
  Object.assign(dock, {
    extension: {animate_icons_unmute: true}, dash: new Actor(),
    _icons: [icon], _onChrome: true, _hidden: false, _dragging: false,
    struts: new Actor({x: -1920, y: -500, width: 1000, height: 60}),
    autohider: {_debounceCheckHide() {}}, _beginAnimation() {},
  });
  return {dock, icon, button, renderer, container};
}
function rect(actor) {
  return [...actor.get_transformed_position(), ...actor.get_transformed_size()];
}
function assertRect(actual, expected, message) {
  assert.equal(actual?.length, 4, `${message}: valid rectangle`);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-7,
    `${message}: ${value} versus ${expected[index]} at ${index}`));
}
function transform(actor) {
  return [actor.scale_x, actor.scale_y, actor.translation_x, actor.translation_y];
}

const {dock, icon, button, renderer, container} = fixture();
const originalTransform = transform(button);
const originalAllocation = [button.x, button.y, button.width, button.height];
let activations = 0;
button.connect('clicked', () => activations++);
const nativeListeners = button.listeners.size;
dock._syncIconInput(icon);
assertRect(rect(button), rect(renderer), 'native button follows rendered bounds');
assertRect(icon._inputRect, rect(renderer), 'hover rectangle matches the actual renderer');
assert.equal(icon._appwell, button, 'the existing app button remains the activation target');
assert.equal(button.get_parent(), container, 'the native event ancestry is preserved');
assert.equal(button.listeners.size, nativeListeners, 'native activation is not replaced');
assert.equal(container.children.length, 1, 'no synthetic hit actor is introduced');
assert.equal(renderer.reactive, false, 'painting does not become a separate activation target');
button.emit('clicked', 1);
assert.equal(activations, 1, 'one native click still activates once');
assert.deepEqual([button.x, button.y, button.width, button.height], originalAllocation,
  'sync transforms the native button without changing its allocation');
assert.equal(button.allocationWrites, 0, 'sync does not invalidate native layout');
assert.equal(tracks, 0, 'Wayland uses native picking without X11 chrome bookkeeping');
const writes = button.writes;
for (let frame = 0; frame < 100; frame++) dock._syncIconInput(icon);
assertRect(rect(button), rect(renderer), '100 stable frames do not accumulate drift');
assert.equal(button.writes, writes, 'stable frames avoid native transform writes');

// Spread, rise and launch bounce all move the renderer. Hit geometry follows
// its current stage rectangle, including the renderer's own translation.
renderer.x += 35;
renderer.y -= 19;
renderer.translation_x = 4;
renderer.translation_y = -27;
renderer.scale_x = 3.5;
renderer.scale_y = 3.5;
dock._syncIconInput(icon);
assertRect(rect(button), rect(renderer), 'moving and bouncing icons retain exact hit bounds');
dock._restoreIconInput(icon);
assert.deepEqual(transform(button), originalTransform, 'restore retains the original native transform');
assert.equal(icon._inputRect ?? null, null, 'restoration clears stale hover bounds');
dock._restoreIconInput(icon);
assert.deepEqual(transform(button), originalTransform, 'restoration is idempotent');

const asymmetric = fixture();
asymmetric.container.scale_x = 1.5;
asymmetric.container.scale_y = 0.75;
asymmetric.button.pivot_point = {x: 0.2, y: 0.9};
asymmetric.dock._syncIconInput(asymmetric.icon);
assertRect(rect(asymmetric.button), rect(asymmetric.renderer),
  'nonuniform parent scaling and an arbitrary native pivot preserve stage bounds');
asymmetric.dock._restoreIconInput(asymmetric.icon);

// Every orientation has clickable overhang beyond the old struts + 20px.
for (const [position, target] of [
  ['bottom', [1080, 880]], ['top', [1080, 1120]],
  ['left', [1240, 1000]], ['right', [880, 1000]],
]) {
  const f = fixture();
  f.dock._position = position;
  f.dock.struts = new Actor({x: 1000, y: 1000, width: 200, height: 80});
  f.renderer.parent = null;
  [f.renderer.x, f.renderer.y] = target;
  f.dock._syncIconInput(f.icon);
  const [x, y, width, height] = rect(f.renderer);
  assert.equal(f.dock._isWithinDash([x + width / 2, y + height / 2]), true,
    `${position} magnified overhang remains within the dock`);
  assert.equal(f.dock._isWithinDash([x - 0.01, y + height / 2]), false,
    `${position} input bounds do not extend beyond painted icons`);
  f.dock._hidden = true;
  assert.equal(f.dock._isWithinDash([x + width / 2, y + height / 2]), false,
    `${position} hidden docks cannot retain active hover bounds`);
  f.dock._syncIconInput(f.icon);
  assert.equal(f.icon._inputRect ?? null, null, 'hidden icon geometry is cleared');
}

// Invalid or disabled icons cannot retain a transform or stale input rectangle.
for (const disable of [
  f => { f.renderer.visible = false; },
  f => { f.renderer.width = 0; },
  f => { f.renderer.x = NaN; },
  f => { f.button.width = 0; },
  f => { f.dock.extension.animate_icons_unmute = false; },
  f => { f.dock._dragging = true; },
]) {
  const f = fixture();
  const original = transform(f.button);
  f.dock._syncIconInput(f.icon);
  disable(f);
  f.dock._syncIconInput(f.icon);
  assert.equal(f.icon._inputRect ?? null, null, 'invalid/disabled geometry cannot remain a hit target');
  assert.deepEqual(transform(f.button), original, 'invalid/disabled geometry restores the native transform');
}

// Show Apps uses its existing native button via the same geometry path.
const apps = fixture();
delete apps.icon._appwell;
apps.icon._button = apps.button;
apps.dock._syncIconInput(apps.icon);
assertRect(rect(apps.button), rect(apps.renderer), 'Show Apps native button follows its renderer');
apps.dock._restoreIconInput(apps.icon);

// X11's input shape follows the actual native buttons, without parenting or
// repeated updates while magnification is stationary.
wayland = false;
const x11 = fixture();
const x11Original = transform(x11.button);
const beforeTracks = tracks;
x11.dock._syncIconInput(x11.icon);
assert.equal(tracks, beforeTracks + 1, 'X11 tracks the native transformed button');
assert.equal(tracked.has(x11.button), true);
const queueCount = regionQueues;
const x11Writes = x11.button.writes;
for (let frame = 0; frame < 100; frame++) x11.dock._syncIconInput(x11.icon);
assert.equal(tracks, beforeTracks + 1, 'stationary X11 icons are tracked once');
assert.equal(regionQueues, queueCount, 'stationary X11 icons do not requeue input regions');
assert.equal(x11.button.writes, x11Writes, 'stationary X11 input transforms avoid writes');
x11.renderer.translation_y -= 12;
x11.dock._syncIconInput(x11.icon);
assert.ok(regionQueues > queueCount, 'moving X11 hit geometry refreshes the input shape');
const beforeUntracks = untracks;
x11.dock._restoreIconInput(x11.icon);
assert.equal(untracks, beforeUntracks + 1, 'restoring native input releases chrome tracking');
assert.deepEqual(transform(x11.button), x11Original);
assert.equal(tracked.has(x11.button), false);

// Cleanup and drag must find transformed buttons even after the icon cache was
// invalidated; otherwise invisible hit rectangles can survive redisplay.
const cleanup = fixture();
const cleanupOriginal = transform(cleanup.button);
cleanup.dock._syncIconInput(cleanup.icon);
cleanup.dock._icons = null;
cleanup.dock._cleanupIcon(cleanup.icon);
assert.deepEqual(transform(cleanup.button), cleanupOriginal, 'icon cleanup restores native geometry');
assert.equal(tracked.has(cleanup.button), false, 'icon cleanup releases chrome tracking');
const dragging = fixture();
const dragOriginal = transform(dragging.button);
const secondDragged = fixture();
const secondOriginal = transform(secondDragged.button);
dragging.dock._syncIconInput(dragging.icon);
dragging.dock._syncIconInput(secondDragged.icon);
dragging.dock._icons = null;
dragging.dock._setDragState(true);
assert.deepEqual(transform(dragging.button), dragOriginal, 'drag setup restores native source geometry');
assert.deepEqual(transform(secondDragged.button), secondOriginal,
  'drag setup restores every transformed icon after cache invalidation');
assert.equal(dragging.icon._inputRect ?? null, null, 'drag setup clears magnified hit geometry');
assert.equal(tracked.has(dragging.button), false, 'drag setup releases chrome tracking');
assert.equal(tracked.has(secondDragged.button), false, 'drag setup releases all chrome tracking');

const shell50 = fixture(loadDock('50.0'));
const shell50Tracks = tracks;
shell50.dock._syncIconInput(shell50.icon);
assertRect(rect(shell50.button), rect(shell50.renderer), 'GNOME 50 still uses native hit geometry');
assert.equal(tracks, shell50Tracks, 'GNOME 50 does not use the removed X11 input-region API');
shell50.dock._restoreIconInput(shell50.icon);
assert.equal(tracked.size, 0, 'input lifecycle leaves no chrome tracking behind');

console.log('Magnified icon input regressions passed (native picking, four edges, Wayland/X11 lifecycle)');
