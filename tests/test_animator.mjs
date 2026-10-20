// Run with node tests/test_animator.mjs. Executes the actual Animator with
// actors exposing only native Clutter property names, without a live desktop.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Actor {
  static allocations = 0;
  constructor(params = {}) {
    Actor.allocations++;
    Object.assign(this, {x: 0, y: 0, width: 32, height: 32,
      translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1,
      opacity: 255, visible: true, icon_size: 32, children: [], signals: new Map()}, params);
  }
  get_children() { return this.children; }
  get_n_children() { return this.children.length; }
  add_child(child) { this.children.push(child); child.parent = this; }
  get_parent() { return this.parent; }
  get_transformed_position() {
    this.positionReads = (this.positionReads ?? 0) + 1;
    return [this.x + this.translation_x, this.y + this.translation_y];
  }
  get_transformed_size() { return [this.width * this.scale_x, this.height * this.scale_y]; }
  set_position(x, y) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), 'finite actor position');
    this.x = x; this.y = y;
  }
  set_scale(x, y) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0,
      'finite positive actor scale');
    this.scale_x = x; this.scale_y = y;
  }
  set_size(width, height) {
    assert.ok(Number.isFinite(width) && Number.isFinite(height));
    this.width = width; this.height = height;
  }
  set_icon_size(size) { this.icon_size = size; }
  set_style_class_name(name) { this.style_class = name; }
  hide() { this.hides = (this.hides ?? 0) + 1; this.visible = false; }
  show() { this.shows = (this.shows ?? 0) + 1; this.visible = true; }
  connect(name, callback) {
    const id = this.signals.size + 1;
    this.signals.set(id, {name, callback});
    return id;
  }
  disconnect(id) { this.signals.delete(id); }
  destroy() {
    for (const {name, callback} of [...this.signals.values()]) {
      if (name === 'destroy') callback();
    }
    this.destroyed = true;
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
  }
  destroy_all_children() { [...this.children].forEach(c => c.destroy()); }
  update() {}
}
const timer = {
  sequences: new Set(),
  runAnimation(frames) {
    const sequence = {frames}; this.sequences.add(sequence); return sequence;
  },
  cancel(sequence) { this.sequences.delete(sequence); },
};
const context = vm.createContext({
  console, St: {Icon: Actor}, Dot: Actor, DockItemDotsOverlay: Actor,
  DockItemBadgeOverlay: Actor,
  DockPosition: {BOTTOM: 'bottom', TOP: 'top', LEFT: 'left', RIGHT: 'right'},
  QuadraticEaseOut: p => p * (2 - p), CubicEaseOut: p => 1 - (1 - p) ** 3,
  Linear: {easeNone: (t, b, c, d) => b + c * t / d},
  Bounce: {easeOut: (t, b, c, d) => b + c * t / d},
  get_distance_sqr: (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2,
  global: {get_pointer: () => [16, 16]},
});
const source = readFileSync(new URL('../animator.js', import.meta.url), 'utf8')
  .replace(/^import\s[\s\S]*?;\n/gm, '').replace(/export /g, '');
vm.runInContext(readFileSync(new URL('../vector.js', import.meta.url), 'utf8')
  .replace(/export /g, ''), context);
vm.runInContext(source + '\nglobalThis.Animator = Animator;', context);
const icon = new Actor();
icon._icon = new Actor({icon_name: 'app'});
icon._icon.parent = new Actor();
const background = new Actor({x: 7, y: 9});
const extension = {
  _hiTimer: timer, _config: {}, animate_icons_unmute: true,
  animation_rise: 0.5, animation_magnify: 1, animation_spread: 0.5,
  animation_fps: 60, animation_bounce_height: 0.5, animation_bounce_frequency: 1,
  icon_quality: 1, services: {_appNotices: {}, updateIcon() {}},
  integrations: {bms_update_size() {}}, autohide_speed: 0.5,
};
let within = true;
let endRearms = 0;
let settles = 0;
const inputSyncs = [];
const pointerWatchStates = [];
let inputRestores = 0;
const dock = {
  extension, _icons: [icon], _iconSizeScaledDown: 32, _iconSize: 32,
  _scaleFactor: 1, _edge_distance: 0, _position: 'bottom', _separators: [],
  _monitor: {x: 1000, y: 0, geometry_scale: 1}, opacity: 255,
  x: 1000, y: 0, width: 100, height: 100,
  dash: new Actor(), renderArea: new Actor(), inputArea: new Actor(),
  struts: new Actor(), _background: background,
  autohider: {_debounceCheckHide() {}},
  layout: () => true, isVertical: () => false,
  getMonitor() { return this._monitor; },
  _isWithinDash: () => within, _updateTransparenies() {},
  _debounceEndAnimation() { endRearms++; }, _beginAnimation() {},
  _settleAnimation() { settles++; },
  _syncIconInput(container) {
    const renderer = container._renderer;
    assert.ok(renderer?.visible, 'native input sync follows the rendered icon commit');
    assert.ok(Number.isFinite(renderer.x) && Number.isFinite(renderer.y),
      'input sync sees a finite committed render position');
    assert.equal(renderer.width * renderer.scale_x,
      this._iconSizeScaledDown * this._scaleFactor * container._scale,
      'input sync sees the current rendered size rather than the target size');
    inputSyncs.push({container, x: renderer.x, y: renderer.y,
      translation_x: renderer.translation_x, translation_y: renderer.translation_y});
  },
  _syncPointerWatch(active) { pointerWatchStates.push(active); },
  _restoreIconInputs() {
    inputRestores++;
    assert.ok(!icon._renderer.destroyed, 'disable restores input before destroying renderer geometry');
  },
};
background._padding = 0;
const animator = new context.Animator();
animator.dock = dock; animator.extension = extension; animator.enable();
// No camelCase defaults: this catches NaN sizing caused by renderer.scaleX.
for (let i = 0; i < 20; i++) animator.animate(16);
assert.ok(animator._renderers[0].scale_x > 1);
assert.equal(icon.positionReads, 20, 'each frame reads an icon stage position once');
assert.equal(inputSyncs.length, 20, 'each animated frame synchronizes the native input target');
assert.equal(pointerWatchStates.at(-1), true, 'magnified rendered icons retain pointer recovery');
assert.equal(dock.renderArea.children.length, 1, 'unused indicator canvases are not allocated');
icon._label = new Actor({text: 'App', opacity: 0});
for (let i = 0; i < 250; i++) animator.animate(16);
assert.equal(icon._label.opacity, 255, 'hover remains active through tooltip dwell and fade');
const hoverRearms = endRearms;
const renderer = animator._renderers[0];
const setScale = renderer.set_scale.bind(renderer);
let scaleWrites = 0;
renderer.set_scale = (...args) => { scaleWrites++; setScale(...args); };
for (let i = 0; i < 100; i++) animator.animate(16);
assert.equal(endRearms, hoverRearms, 'stationary magnified icons stop rearming animation');
assert.equal(scaleWrites, 0, 'stationary renderer scale avoids native property writes');
renderer.set_scale = setScale;
assert.ok(settles > 0, 'settled hover suspends the timer while preserving magnification');
assert.equal(dock.inputArea.x, 7, 'input area uses transformed background, not monitor origin');
within = false;
animator.animate(16);
assert.equal(icon._targetScale, 1, 'leaving targets the resting scale');
assert.ok(icon._scale > 1, 'leaving interpolates the rendered icon back to rest');
assert.equal(pointerWatchStates.at(-1), true,
  'pointer recovery persists during return even after the target is unzoomed');
for (let i = 0; i < 250; i++) animator.animate(16);
assert.equal(animator._renderers[0].scale_x, 1, 'zoom fully settles to resting scale');
assert.equal(pointerWatchStates.at(-1), false, 'resting rendered icons release pointer recovery');
assert.ok(endRearms > 1, 'zoom keeps animation alive while settling');
const outsideRearms = endRearms;
for (let i = 0; i < 100; i++) animator.animate(16);
assert.equal(endRearms, outsideRearms, 'resting icons remain idle');

extension.animation_fps = 0;
within = true;
for (let i = 0; i < 250; i++) animator.animate(16);
const smoothRearms = endRearms;
for (let i = 0; i < 100; i++) animator.animate(16);
assert.equal(endRearms, smoothRearms, 'smoothed motion reaches an idle magnified pose');
within = false;
for (let i = 0; i < 250; i++) animator.animate(16);
extension.animation_fps = 60;
dock._hidden = true;
for (let i = 0; i < 100; i++) animator.animate(16);
assert.equal(dock.dash.translation_y, background.height, 'autohide slide reaches its final position');
const slideRearms = endRearms;
for (let i = 0; i < 30; i++) animator.animate(16);
assert.equal(endRearms, slideRearms, 'completed autohide slides remain idle');
dock._hidden = false;
for (let i = 0; i < 100; i++) animator.animate(16);
assert.equal(dock.dash.translation_y, 0);
let listMoving = true;
dock._list = {visible: true, _target: icon, animate: () => listMoving};
const beforeList = endRearms;
animator.animate(16);
assert.ok(endRearms > beforeList, 'a moving pullout keeps animation alive');
listMoving = false;
const settledList = endRearms;
animator.animate(16);
assert.equal(endRearms, settledList, 'a stationary visible pullout can suspend animation');
dock._list = null;

let windows = [{}];
icon._appwell = {app: {get_id: () => 'app', get_n_windows() {}}};
dock.getAppWindowsFiltered = () => windows;
extension.services._appNotices.app = {count: 1};
animator.animate(16);
const dots = animator._dots[0];
const badge = animator._badges[0];
assert.ok(dots && badge, 'visible content allocates indicator surfaces');
const allocations = Actor.allocations;
for (let i = 0; i < 30; i++) animator.animate(16);
assert.equal(Actor.allocations, allocations, 'stable indicators reuse their actors and canvases');
assert.equal(dots.hides ?? 0, 0, 'running indicators do not hide and show every frame');
assert.equal(badge.hides ?? 0, 0, 'notification badges do not hide and show every frame');
windows = [];
delete extension.services._appNotices.app;
animator.animate(16);
assert.ok(dots.destroyed && badge.destroyed, 'cleared indicators release their Cairo surfaces');
assert.equal(animator._dots[0], null);
assert.equal(animator._badges[0], null);
icon._appwell = null;
dock._monitor.inFullscreen = true;
extension._inOverview = true;
within = true;
for (let i = 0; i < 20; i++) animator.animate(16);
assert.ok(animator._renderers[0].scale_x > 1, 'overview supports zoom above a fullscreen window');
dock._monitor.inFullscreen = false;
extension._inOverview = false;
within = false;
animator.animate(NaN);
animator.animate(Infinity);
// Renderer pools shrink when icons disappear, and can be repopulated.
const oldRenderer = animator._renderers[0];
dock._icons = [];
animator.animate(16);
assert.ok(oldRenderer.destroyed);
assert.equal(animator._renderers.length, 0);
dock._icons = [icon];
animator.animate(16);
// Repeated clicks replace an actor's bounce instead of accumulating callbacks.
const appwell = new Actor();
appwell.parent = icon;
animator.bounceIcon(appwell);
animator.bounceIcon(appwell);
assert.equal(timer.sequences.size, 1);
const sequence = [...timer.sequences][0];
const beforeBounceInput = inputSyncs.length;
sequence.frames[0]._func({_time: 125, _duration: 250});
assert.notEqual(appwell.translation_y, 0);
assert.equal(inputSyncs.length, beforeBounceInput + 1,
  'a bounce frame synchronizes the native input target outside Animator.animate');
assert.equal(inputSyncs.at(-1).translation_y, appwell.translation_y,
  'bounce input sync follows the translated renderer');
appwell.destroy();
assert.equal(timer.sequences.size, 0, 'destroy cancels bounce callbacks');
const another = new Actor(); another.parent = icon;
animator.bounceIcon(another);
animator.cancelAnimations();
assert.equal(another._bounce, false);
assert.equal(timer.sequences.size, 0);
assert.equal(another.signals.size, 0);
animator.disable();
assert.equal(inputRestores, 1, 'disabling restores transformed native input targets');
dock.layout = () => { throw new Error('disabled animator touched dock'); };
animator.animate(16);
assert.equal(animator._target, null);
console.log('Animator regression tests passed');
