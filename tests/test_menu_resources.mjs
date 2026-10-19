import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

function loadClass(file, name, dependencies) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(dependencies), `${source}\nreturn ${name};`)(
    ...Object.values(dependencies));
}

const activity = {enumerations: 0, labelMeasurements: 0, positionWrites: 0, icons: 0};
class Widget {
  constructor(properties = {}) {
    this.children = [];
    this.signals = new Map();
    this.nextSignal = 1;
    this._x = 0;
    this._y = 0;
    this.rotation_angle_z = 0;
    this.translation_x = 0;
    this.translation_y = 0;
    this.visible = true;
    Object.assign(this, properties);
  }
  _init(properties) { Object.assign(this, properties); }
  get x() { return this._x; }
  set x(value) { activity.positionWrites++; this._x = value; }
  get y() { return this._y; }
  set y(value) { activity.positionWrites++; this._y = value; }
  get first_child() { return this.children[0] ?? null; }
  add_child(child) { this.children.push(child); child.parent = this; }
  get_children() { activity.enumerations++; return [...this.children]; }
  get_transformed_position() { return [this.x, this.y]; }
  set_size(width, height) { this.width = width; this.height = height; }
  connect(name, callback) {
    const id = this.nextSignal++;
    this.signals.set(id, {name, callback});
    return id;
  }
  disconnect(id) { assert.equal(this.signals.delete(id), true); }
  emit(name) {
    for (const signal of [...this.signals.values()]) {
      if (signal.name === name) signal.callback();
    }
  }
  hide() { this.visible = false; }
  destroy() {
    assert.equal(this.destroyed, undefined, 'actors are destroyed once');
    this.destroyed = true;
    this.emit('destroy');
    this.signals.clear();
    for (const child of [...this.children]) child.destroy();
    this.children = [];
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
}
class Label extends Widget {
  get_transformed_size() { activity.labelMeasurements++; return [80, 20]; }
}
class Icon extends Widget {
  constructor(properties) { super(properties); activity.icons++; }
}
const DockPosition = {LEFT: 'left', RIGHT: 'right', TOP: 'top', BOTTOM: 'bottom'};
const commands = [];
const DockItemList = loadClass('dockItemMenu.js', 'DockItemList', {
  GObject: {registerClass(metadata, Class) {
    return class extends Class {
      constructor(...args) { super(); this._init(...args); }
    };
  }},
  St: {Widget, Label, Icon}, Graphene: {Point: class {}}, DockPosition,
  Clutter: {EVENT_PROPAGATE: 0, EVENT_STOP: 1},
  GLib: {shell_quote: value => `'${value}'`},
  trySpawnCommandLine: command => { commands.push(command); return Promise.resolve(); },
});

const dock = {
  _monitor: {x: 0, y: 0, width: 1920, height: 1080, geometry_scale: 1},
  _position: 'bottom', _iconSizeScaledDown: 48, starts: 0, launches: 0,
  extension: {
    file_explorer: () => 'files', file_opener: () => 'open', items_pullout_angle: 1,
    downloads_icon_rotate_labels: true,
  },
  isVertical: () => false,
  _beginAnimation() { this.starts++; },
  _updateIconEffect() {},
  _maybeBounce() { this.launches++; },
  _destroyList() {
    const list = this._list;
    this._list = null;
    list?.destroy();
  },
};
const files = Array.from({length: 40}, (_, index) => ({
  name: `file-${index}`, path: `/downloads/file-${index}`, icon: 'text-x-generic',
}));
function openList() {
  const target = new Widget();
  target._icon = new Widget();
  target._label = new Widget();
  const list = new DockItemList();
  list.dock = dock;
  dock._list = list;
  list.slideIn(target, files);
  return {target, list};
}

{
  const {target, list} = openList();
  const positions = new Set(list._items.flatMap(item => [
    ...item._waypointsIn, ...item._waypointsOut,
  ]));
  assert.ok(positions.size <= 3 * files.length,
    'position object allocation must stay linear when opening a forty-item pullout');
  activity.enumerations = activity.labelMeasurements = activity.positionWrites = 0;
  assert.equal(list.animate(15), true);
  assert.equal(activity.enumerations, 0, 'each frame reuses the existing child list');
  assert.equal(activity.icons, files.length, 'each entry creates one icon texture');
  assert.ok(activity.labelMeasurements <= files.length,
    'labels are measured once per frame, rather than once per numerical substep');
  assert.ok(activity.positionWrites <= 6 * files.length,
    'numerical substeps do not repeatedly invalidate actor positions');

  let moving = true;
  for (let frame = 0; frame < 1000 && moving; frame++) moving = list.animate(15);
  assert.equal(moving, false, 'an open pullout must stop requesting animation after settling');
  const measurements = activity.labelMeasurements;
  assert.equal(list.animate(15), false);
  assert.equal(activity.labelMeasurements, measurements, 'settled labels need no new measurement');
  const starts = dock.starts;
  list.slideOut();
  assert.equal(dock.starts, starts + 1, 'closing a settled pullout wakes its animation');
  for (let frame = 0; frame < 1000 && dock._list; frame++) list.animate(15);
  assert.equal(dock._list, null, 'a closed pullout releases its actor tree');
  assert.equal(list._items, null);
  assert.equal(target.signals.size, 0, 'closing releases the target destroy listener');
}

{
  const {target, list} = openList();
  list.animate(15);
  list._items[0]._icon.emit('button-press-event');
  assert.equal(commands.length, 1);
  assert.equal(dock.launches, 1);
  assert.equal(dock._list, null, 'launching releases invisible textures and file callbacks immediately');
  assert.equal(list._items, null);
  assert.equal(target.signals.size, 0);
}

{
  const {target, list} = openList();
  target.destroy();
  assert.equal(dock._list, null, 'destroying the target also releases its pullout');
  assert.equal(list.dock, null);
}

{
  const original = function () { return this.value; };
  const target = {getIcon: original, value: 'native geometry'};
  const Main = {extensionManager: {lookup: uuid =>
    uuid.startsWith('compiz-') ? {stateObj: target} : null}};
  const Integrations = loadClass('integrations.js', 'Integrations', {Main});
  const integrations = new Integrations();
  integrations.extension = {docks: [], lamp_app_animation: true};
  integrations.enable();
  const wrapper = target.getIcon;
  target.getIcon = function (...args) { return wrapper.apply(this, args); };
  integrations.disable();
  assert.equal(target.getIcon(), 'native geometry',
    'a wrapper retained by another extension must release its owner and delegate after shutdown');
}

{
  const Main = {extensionManager: {lookup: () => null}};
  const Integrations = loadClass('integrations.js', 'Integrations', {Main});
  const integrations = new Integrations();
  integrations.extension = {docks: [], blur_background: true};
  integrations.enable();
  integrations.bms_update_size({dock: {get_children() {
    throw new Error('an absent blur extension must cost no per-frame child enumeration');
  }}});

  let clips = 0;
  let effectReads = 0;
  class CornerEffect {}
  const effect = new CornerEffect();
  const background = {width: 1920, height: 1080};
  const container = {
    first_child: background,
    set_clip() { clips++; },
    get_effects() { effectReads++; return [effect]; },
  };
  const group = {visible: true, first_child: container,
    get_name: () => 'bms-dash-backgroundgroup'};
  const blurDock = {
    extension: {integrations, blur_background: true, background_color: [0, 0, 0, 0.5],
      computed_border_radius: 12},
    _background: {x: 20, y: 30, width: 400, height: 60},
    _position: 'bottom', renderArea: {width: 500, height: 80},
    get_children: () => [group],
  };
  const animator = {dock: blurDock};
  blurDock.animator = animator;
  integrations.extension.docks = [blurDock];
  integrations._bms = {metadata: {version: 70}};
  for (let frame = 0; frame < 100; frame++) integrations.bms_update_size(animator);
  assert.equal(clips, 1, 'stable blur geometry must not continually invalidate its clip');
  assert.equal(effectReads, 1, 'stable blur geometry reuses its effect objects');
  assert.equal(effect.radius, 12);
  blurDock._background.width += 10;
  integrations.bms_update_size(animator);
  assert.equal(clips, 2, 'geometry changes still update the clip');
  blurDock.extension.computed_border_radius = 20;
  integrations.bms_update_size(animator);
  assert.equal(effect.radius, 20, 'style changes still update corner effects');
  blurDock.get_children = () => [];
  integrations.bms_update_size(animator);
  assert.equal(animator._blur_effects, null, 'removed blur actors release their cached effects');
  assert.equal(animator._bmsLayout, null);
  integrations.releaseBms();
  assert.equal(animator._bms, null);
}

console.log('Pullout and integration resource regression tests passed');
