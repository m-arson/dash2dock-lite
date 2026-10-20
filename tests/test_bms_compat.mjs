import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

function load(file, name, dependencies) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\n/gm, '')
    .replace(/^export default /gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(dependencies), `${source}\nreturn ${name};`)(
    ...Object.values(dependencies));
}

class Actor {
  constructor(properties = {}) {
    this.children = [];
    this.signals = new Map();
    this.nextSignal = 1;
    this.visible = true;
    this.opacity = 255;
    this.x = this.y = this.width = this.height = 0;
    this.translation_x = this.translation_y = 0;
    Object.assign(this, properties);
  }
  _init(properties) { Object.assign(this, properties); }
  get_name() { return this.name; }
  get_parent() { return this.parent ?? null; }
  get_children() { return [...this.children]; }
  get first_child() { return this.children[0] ?? null; }
  add_child(child) {
    this.children.push(child);
    child.parent = this;
    this.emit('child-added', child);
  }
  set_child_below_sibling(child, sibling) {
    this.restacks = (this.restacks ?? 0) + 1;
    this.children = this.children.filter(actor => actor !== child);
    this.children.splice(this.children.indexOf(sibling), 0, child);
  }
  connect(name, callback) {
    const id = this.nextSignal++;
    this.signals.set(id, {name, callback});
    return id;
  }
  connectObject() {}
  disconnect(id) { assert.equal(this.signals.delete(id), true); }
  emit(name, ...args) {
    for (const signal of [...this.signals.values()])
      if (signal.name === name) signal.callback(this, ...args);
  }
  has_allocation() { return this.allocated === true; }
  allocate() {
    this.allocated = this.visible && this.width > 0 && this.height > 0;
    this.emit('notify::allocation');
    for (const child of this.children) child.allocate();
  }
  get_transformed_position() {
    const [x, y] = this.parent?.get_transformed_position() ?? [0, 0];
    return [x + this.x + this.translation_x, y + this.y + this.translation_y];
  }
}

const GObject = {registerClass: (...args) => args.at(-1)};
const Main = {layoutManager: {primaryIndex: 0}, overview: {visible: false}};
const Background = load('dockItems.js', 'DockBackground', {
  GObject, Main, St: {Widget: Actor}, PopupMenu: {PopupMenu: class {}},
  DashIcon: class {}, DashItemContainer: class {},
});
class Animator { enable() {} }
class AutoHide {
  _onMotionEvent() {}
  _onEnterEvent() {}
  _onLeaveEvent() {}
}
const Dock = load('dock.js', 'Dock', {
  Main, GObject, St: {Widget: Actor}, DockBackground: Background,
  Animator, AutoHide, DashModule: {Dash: class {}},
  Config: {PACKAGE_VERSION: '50'}, Graphene: {Point: class {}},
  Clutter: {ActorAlign: {CENTER: 0}, TextDirection: {LTR: 0, RTL: 1},
    Orientation: {HORIZONTAL: 0, VERTICAL: 1}},
});

// Shell Dash is outside this test: retain the production dock constructor and
// layout while providing its existing native dash allocation/input contract.
Dock.prototype.createDash = function () {
  const dash = new Actor({name: 'dash', width: 400, height: 60});
  dash.last_child = {layout_manager: {}};
  dash._box = {layout_manager: {}};
  this.dash = dash;
  return dash;
};
const settings = {icon_size: 0.5, scale: 1, icon_spacing: 0.5,
  animation_spread: 0.5, animation_magnify: 0.5, edge_distance: 0,
  _config: {}, blur_background: true};
const dock = new Dock();
dock._init({extension: settings});
const uiGroup = new Actor({name: 'uiGroup'});
uiGroup.add_child(dock);

// This is the external Dash-to-Dock target contract used by both generations
// of Blur My Shell, including the newer allocation and slider signal watches.
function resolveTarget(container) {
  assert.equal(container.get_name(), 'dashtodockContainer');
  assert.equal(container.constructor.name, 'DashToDock');
  const slider = container._slider;
  const parent = slider.get_child();
  const content = parent.get_children().find(actor => actor.get_name() === 'dash');
  return {slider, parent, content, background: content._background};
}
function ready(container, target) {
  return [container, target.parent, target.content, target.background]
    .every(actor => actor.has_allocation() && actor.width > 0 && actor.height > 0);
}
const target = resolveTarget(dock);
assert.equal(target.slider, dock.renderArea, 'the slider must be a real signal-capable actor');
assert.equal(target.slider.get_parent(), dock, 'legacy slider parent lookup must retain the dock');
assert.equal(target.parent, dock);
assert.equal(target.content, dock._background, 'discover the painted background before the native dash');
assert.equal(target.background, dock._background, 'follow actual animated background bounds');
assert.equal(target.content.visible, true, 'target allocation cannot depend on a hidden dummy');
assert.equal(target.content.style_class, 'd2da-background');
assert.equal(ready(dock, target), false, 'discovery can precede the first allocation');
let retries = 0;
const watches = [];
function watch(actor, names) {
  for (const name of names)
    watches.push([actor, actor.connect(name, () => retries++)]);
}
watch(dock, ['notify::allocation', 'child-added', 'notify::mapped', 'destroy']);
watch(target.slider, ['notify::child', 'child-added', 'child-removed']);
watch(target.content, ['notify::allocation']);
watch(target.background, ['notify::allocation']);

const monitor = {x: -1920, y: -100, width: 1920, height: 1080, geometry_scale: 2};
dock.getMonitor = () => monitor;
dock._updateExtraIcons = () => {};
dock._findIcons = () => [];
dock._preferredIconSize = () => 48;
dock.layout();
const first = {_icon: {}};
const last = {_icon: {}};
function updateBackground() {
  dock._background.update({first, last, iconSize: 48, scaleFactor: 2, dock,
    vertical: dock.isVertical(), position: dock._position, panel_mode: false});
}
updateBackground();
dock.allocate();
assert.ok(retries > 0, 'pending discovery receives real actor allocation signals');
assert.equal(ready(dock, target), true, 'the target becomes ready after normal dock layout: ' +
  [dock, target.parent, target.content, target.background]
    .map(actor => `${actor.name}:${actor.width}x${actor.height}:${actor.allocated}`).join(', '));
assert.equal(target.content.width, dock.dash.width);
assert.equal(target.content.height, dock.dash.height);

// The target background must include the native dash's autohide translation
// exactly once, including negative origins and vertical docks at scale 2.
for (const location of [0, 1, 2, 3]) {
  settings.dock_location = location;
  dock._layoutState = null;
  dock.layout();
  dock.dash.translation_x = 0;
  dock.dash.translation_y = 0;
  updateBackground();
  const before = target.background.get_transformed_position();
  const dx = dock.isVertical() ? -90 : 0;
  const dy = dock.isVertical() ? 0 : 90;
  dock.dash.translation_x = dx;
  dock.dash.translation_y = dy;
  updateBackground();
  const after = target.background.get_transformed_position();
  assert.deepEqual(after, [before[0] + dx, before[1] + dy],
    `background tracks one autohide translation at dock edge ${location}`);
  assert.equal(target.content.get_parent(), dock);
}
for (const [actor, id] of watches) actor.disconnect(id);
assert.equal(target.slider.signals.size, 0, 'pending watches disconnect from the real actor');

const modern = {pending_docks: new Map(), queue_discovery() {}, update_size() {}};
let manager = modern;
Main.extensionManager = {lookup: () => ({metadata: {version: 76},
  stateObj: {_dash_to_dock_blur: manager}})};
const Integrations = load('integrations.js', 'Integrations', {Main});
const integrations = new Integrations();
integrations.extension = {docks: [dock], blur_background: true};
const originalSize = modern.update_size;
integrations.hookBms();
assert.equal(modern.update_size, originalSize, 'modern update-size signals must stay enabled');

const blur = new Actor({name: 'bms-dash-backgroundgroup'});
const surface = new Actor({x: 37, y: 49, width: 400, height: 60});
surface.set_clip = () => assert.fail('modern surfaces must keep ownership of clipping');
blur.add_child(surface);
dock.add_child(blur);
dock.set_child_below_sibling(blur, target.content);
const animator = dock.animator;
for (let frame = 0; frame < 100; frame++) integrations.bms_update_size(animator);
assert.equal(animator._bms, blur);
assert.deepEqual([surface.x, surface.y, surface.width, surface.height], [37, 49, 400, 60]);
assert.equal(dock.restacks, 1, 'only discovery places the blur, stable frames retain its order');
assert.ok(dock.children.indexOf(blur) < dock.children.indexOf(dock._background),
  'blur paints behind configured tint and borders');
assert.ok(dock.children.indexOf(dock._background) < dock.children.indexOf(dock.renderArea),
  'the configured background stays behind rendered icons');
settings.blur_background = false;
integrations.bms_update_size(animator);
assert.equal(surface.visible, false, 'our blur setting controls the painted surface');
assert.equal(blur.visible, true, 'modern parent visibility remains owned by Blur My Shell');
settings.blur_background = true;
dock._background.opacity = 0;
integrations.bms_update_size(animator);
assert.equal(surface.visible, false, 'overview transparency hides the modern blur');
dock._background.opacity = 255;
integrations.bms_update_size(animator);
assert.equal(surface.visible, true);

// Capability detection also supports older manager implementations that carry
// a newer package version; they retain the original clipping integration.
manager = {update_size() {}};
const legacySize = manager.update_size;
integrations.hookBms();
assert.notEqual(manager.update_size, legacySize, 'legacy size hooks are retained');
integrations.releaseBms();
assert.equal(manager.update_size, legacySize, 'legacy hooks restore on disable');
assert.equal(integrations._bmsUsesDockSurfaces, false);
assert.equal(animator._bms, null);
assert.equal(animator._bmsLayout, null);

// Renaming the painted actor to the compatibility dash must retain its
// configured fill/border and cancel theme padding meant for the native dash.
const Extension = load('extension.js', 'Dash2DockLiteExt', {Main, Extension: class {}});
const extension = new Extension();
let generatedStyles;
Object.assign(extension, {
  docks: [], border_radius: 2, background_color: [0.1, 0.2, 0.3, 0.6],
  border_thickness: 2, border_color: [0.8, 0.7, 0.6, 1],
  _style: {
    rgba: value => value?.join(', ') ?? '',
    build(name, styles) { generatedStyles = styles.join('\n'); },
  },
});
extension._updateStyle();
assert.match(generatedStyles, /#dash\.d2da-background \{ padding: 0; border-radius: 16px;/);
assert.match(generatedStyles, /background: rgba\(0.1, 0.2, 0.3, 0.6\)/);
assert.match(extension._backgroundStyle, /border: 2px solid rgba\(0.8, 0.7, 0.6, 1\)/);
console.log('Blur My Shell compatibility regressions passed (allocation, signals, all edges and legacy ownership)');
