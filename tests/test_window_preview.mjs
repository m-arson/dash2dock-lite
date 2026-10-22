import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../windowPreviewMenu.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm, '')
  .replace(/^export /gm, '');

let nextSignal = 1;
class Signals {
  constructor() { this.signals = new Map(); }
  connect(name, callback) {
    const id = nextSignal++;
    this.signals.set(id, [name, callback]);
    return id;
  }
  disconnect(id) {
    assert.ok(this.signals.delete(id), 'each owned signal is disconnected exactly once');
  }
  emit(name, ...args) {
    for (const [id, [signal, callback]] of [...this.signals]) {
      if (signal === name && this.signals.has(id)) callback(this, ...args);
    }
  }
}

class Actor extends Signals {
  constructor(params = {}) {
    super();
    Object.assign(this, {children: [], parent: null, visible: true, width: 0, height: 0,
      allocation: {y1: 0}, destroyCount: 0}, params);
  }
  add_child(child) {
    assert.equal(child.parent, null, 'a preview/box is never parented twice');
    child.parent = this;
    this.children.push(child);
  }
  remove_child(child) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parent = null;
  }
  set_child(child) {
    for (const old of [...this.children]) this.remove_child(old);
    if (child) this.add_child(child);
  }
  add_actor(child) { this.add_child(child); }
  get_child() { return this.children[0] ?? null; }
  get_parent() { return this.parent; }
  get_allocation_box() { return this.allocation; }
  get_size() { return [this.width, this.height]; }
  get_children() { return this.children; }
  set_size(width, height) { this.width = width; this.height = height; }
  set_style(style) { this.style = style; }
  add_style_class_name() {}
  queue_relayout() { this.relayouts = (this.relayouts ?? 0) + 1; }
  hide() { this.visible = false; }
  destroy() {
    assert.equal(this.destroyCount++, 0, 'an actor is never destroyed twice');
    this.emit('destroy');
    for (const child of [...this.children]) child.destroy();
    this.parent?.remove_child(this);
    this.signals.clear();
  }
}

const clones = [];
class Clone extends Actor {
  constructor(params) { super(params); clones.push(this); }
}
class Popup extends Signals {
  constructor(sourceActor, alignment, side) {
    super();
    this.sourceActor = sourceActor;
    this._arrowSide = side;
    this.box = new Actor();
    this._boxPointer = this.actor = new Actor();
    this._boxPointer.bin = new Actor();
    this._boxPointer.add_child(this._boxPointer.bin);
    this._boxPointer.bin.set_child(this.box);
    this._boxPointer.updateArrowSide = arrow => { this._boxPointer.side = arrow; };
    this.isOpen = false;
    this.destroyCount = 0;
  }
  addMenuItem(item) {
    this.box.add_child(item);
    // Native's handler is connected after the component's activation handler.
    // It must not erase the component's selection callback before it runs.
    item.connect('activate', () => this.close());
  }
  moveMenuItem(item, index) {
    this.box.remove_child(item);
    this.box.children.splice(index, 0, item);
    item.parent = this.box;
  }
  open() {
    if (this.isOpen || !this.box.children.length) return;
    this.isOpen = true;
    this.actor.visible = true;
    this.emit('open-state-changed', true);
  }
  close() {
    this.actor.visible = false;
    if (!this.isOpen) return;
    this.isOpen = false;
    this.emit('open-state-changed', false);
  }
  destroy() {
    assert.equal(this.destroyCount++, 0);
    this.close();
    this.actor.destroy();
    this.emit('destroy');
  }
}
const managers = [];
class Manager {
  constructor(owner) { this.owner = owner; this.menus = []; managers.push(this); }
  addMenu(menu) { this.menus.push(menu); }
  removeMenu(menu) {
    assert.ok(this.menus.includes(menu));
    this.menus.splice(this.menus.indexOf(menu), 1);
  }
  ignoreRelease() {}
}
let monitor = {width: 1920, height: 1080};
let scale = 1;
class ScrollView extends Actor {
  constructor(params) {
    super(params);
    this.vadjustment = {value: 0, lower: 0, upper: 1200, page_size: 300};
  }
}
class Label extends Actor {
  constructor(params) { super(params); this.clutter_text = {}; }
}
const Main = {
  uiGroup: new Actor(),
  layoutManager: {
    primaryMonitor: monitor,
    findIndexForActor: () => 0,
    getWorkAreaForMonitor: () => monitor,
  },
};
const Clutter = {Clone, EVENT_PROPAGATE: 'propagate', ActorAlign: {CENTER: 'center'}};
const St = {
  BoxLayout: Actor, Bin: Actor, Label, Icon: Actor, ScrollView,
  Side: {TOP: 'top', BOTTOM: 'bottom', LEFT: 'left', RIGHT: 'right'},
  PolicyType: {NEVER: 'never', AUTOMATIC: 'automatic'},
  ThemeContext: {get_for_stage: () => ({scale_factor: scale})},
};
const Pango = {EllipsizeMode: {END: 'end'}};
const WindowPreviewMenu = new Function('Main', 'Clutter', 'St', 'PopupMenu', 'BoxPointer', 'global', 'Pango',
  `${source}\nreturn WindowPreviewMenu;`)(Main, Clutter, St,
  {PopupMenu: Popup, PopupBaseMenuItem: Actor, PopupMenuManager: Manager},
  {PopupAnimation: {FULL: 'full'}}, {stage: {}}, Pango);

class Window extends Signals {
  constructor(id, params = {}) {
    super();
    Object.assign(this, {id, title: `Window ${id}`, minimized: false, skip_taskbar: false,
      actor: new Actor({width: 1600, height: 900})}, params);
  }
  get_title() { return this.title; }
  get_compositor_private() { return this.actor; }
  unminimize() { assert.fail('opening a thumbnail must never restore its window'); }
  show() { assert.fail('a thumbnail must never show the compositor source'); }
}
function fixture(windows) {
  const app = new Signals();
  app.get_windows = () => windows;
  app.get_name = () => 'Example';
  app.create_icon_texture = size => new Actor({icon_size: size});
  const icon = new Actor({app});
  const nativeMenu = {closeCount: 0, close() { this.closeCount++; }};
  icon._menu = nativeMenu;
  const selected = [];
  const states = [];
  const menu = new WindowPreviewMenu(icon, {getWindows: () => windows,
    onActivate: window => selected.push(window), onOpenStateChanged: open => states.push(open)});
  return {app, icon, windows, menu, selected, states, nativeMenu};
}

const active = new Window('active');
const minimized = new Window('minimized', {minimized: true});
const missing = new Window('missing', {actor: null});
const skipped = new Window('skipped', {skip_taskbar: true});
const f = fixture([active, minimized, missing, skipped, active]);
assert.equal(f.app.signals.size, 0, 'closed menus have no app/window watchers');
assert.equal(f.menu.popup('left'), true);
assert.deepEqual(f.states, [true]);
assert.equal(f.nativeMenu.closeCount, 1, 'opening previews closes a native app menu');
assert.equal(f.menu._rows.size, 3, 'taskbar-hidden windows and duplicate window entries are omitted');
assert.deepEqual(f.menu.box.children, [...f.menu._rows.values()].map(row => row.item));
assert.equal(f.menu._boxPointer.side, 'left');
assert.equal(f.menu._boxPointer._userArrowSide, 'left');
assert.equal(f.menu._scrollView.get_child(), f.menu.box, 'native item box remains intact inside scroll view');
assert.equal(f.menu._rows.get(minimized).clone.source, minimized.actor);
assert.equal(minimized.minimized, true);
assert.equal(f.menu._rows.get(missing).clone, null);
assert.ok(f.menu._rows.get(missing).preview, 'unavailable surfaces retain an app-icon preview');
for (const row of f.menu._rows.values()) {
  assert.equal(row.frame.reactive, false);
  assert.equal(row.preview.reactive, false, 'the native row receives mouse/touch activation');
  assert.equal(row.item.label_actor, row.label, 'each selectable row has a native accessibility label');
  assert.equal(row.label.clutter_text.ellipsize, Pango.EllipsizeMode.END,
    'long window titles ellipsize inside the fixed thumbnail width');
  assert.equal(row.label.clutter_text.single_line_mode, true,
    'titles cannot expand rows with multiple lines');
  if (row.clone) {
    assert.equal(row.clone.width, 192);
    assert.equal(row.clone.height, 108, 'clones fit without distorting the source aspect ratio');
  }
}

active.title = 'A renamed window';
active.emit('notify::title');
assert.equal(f.menu._rows.get(active).label.text, 'A renamed window');
const activeClone = f.menu._rows.get(active).clone;
active.actor.width = 400;
active.actor.height = 1000;
active.actor.emit('notify::height');
assert.equal(f.menu._rows.get(active).clone, activeClone, 'resizing reuses its clone');
assert.equal(activeClone.height, 112);
assert.equal(activeClone.width, 44.800000000000004);

const sourceDestroyed = minimized.actor;
const destroyedClone = f.menu._rows.get(minimized).clone;
sourceDestroyed.destroy();
assert.equal(destroyedClone.destroyCount, 1);
assert.equal(f.menu._rows.get(minimized).clone, null, 'destroyed source is detached immediately');
assert.ok(f.menu._rows.get(minimized).preview, 'destroyed surfaces switch to an icon');
minimized.emit('notify::minimized');
assert.equal(f.menu._rows.get(minimized).clone, null, 'a disposed actor cannot be cloned again');

const added = new Window('new');
f.windows.unshift(added);
f.app.emit('windows-changed');
assert.equal(f.menu.box.children[0], f.menu._rows.get(added).item, 'new windows join the live chooser');
active.emit('unmanaged');
assert.equal(f.menu._rows.has(active), false, 'unmanaged windows disappear even before the app list updates');
f.app.emit('windows-changed');
assert.equal(f.menu._rows.has(active), false, 'stale app membership cannot recreate an unmanaged row');

const focusedRow = f.menu._rows.get(added);
focusedRow.item.allocation.y1 = 500;
focusedRow.item.height = 130;
focusedRow.item.emit('key-focus-in');
assert.equal(f.menu._scrollView.vadjustment.value, 330, 'keyboard focus scrolls an offscreen row into view');
delete f.menu._scrollView.vadjustment;
f.menu._scrollView.vscroll = {adjustment: {value: 500, lower: 0, upper: 1000, page_size: 300}};
focusedRow.item.allocation.y1 = 200;
focusedRow.item.emit('key-focus-in');
assert.equal(f.menu._scrollView.vscroll.adjustment.value, 200, 'legacy scroll adjustments remain supported');

const selectionItem = f.menu._rows.get(minimized).item;
selectionItem.emit('activate');
assert.deepEqual(f.selected, [minimized], 'native activation selects exactly one captured window');
assert.deepEqual(f.states, [true, false]);
assert.equal(f.menu._rows.size, 0, 'close releases every cloned actor and row immediately');
assert.equal(f.app.signals.size, 0);
for (const window of [active, minimized, missing, added]) assert.equal(window.signals.size, 0);
for (const window of [active, missing, added]) if (window.actor) assert.equal(window.actor.signals.size, 0);
assert.equal(selectionItem.destroyCount, 1, 'native activation can safely destroy its own row');

for (const side of ['top', 'right', 'bottom', 'left']) {
  assert.equal(f.menu.popup(side), true);
  assert.equal(f.menu._boxPointer.side, side);
  assert.equal(f.menu.popup(side), false, 'clicking the source again dismisses the chooser');
  assert.equal(f.app.signals.size, 0, 'repeated opens do not retain app listeners');
}
f.menu.destroy();
f.menu.destroy();
assert.equal(f.menu.destroyCount, 1);
assert.equal(f.icon.signals.size, 0, 'destroy disconnects the source-actor lifetime hook');
assert.equal(managers.at(-1).menus.length, 0, 'destroy removes modal menu manager ownership');
assert.equal(f.menu.popup(), false, 'destroyed chooser cannot reopen');

const finalWindow = new Window('last');
const last = fixture([finalWindow]);
last.menu.popup();
finalWindow.emit('unmanaged');
assert.equal(last.menu.isOpen, false, 'removing the final window dismisses the menu');
assert.deepEqual(last.states, [true, false]);
last.menu.destroy();

const lifetime = fixture([new Window('lifetime')]);
lifetime.menu.popup();
const lifetimeClones = [...lifetime.menu._rows.values()].map(row => row.clone);
lifetime.icon.destroy();
assert.equal(lifetime.menu.destroyCount, 1, 'source destruction disposes the open chooser');
assert.equal(lifetime.app.signals.size, 0);
assert.ok(lifetimeClones.every(clone => clone.destroyCount === 1));

const empty = fixture([]);
assert.equal(empty.menu.popup(), false);
assert.equal(empty.app.signals.size, 0, 'empty menus cannot leave a window watcher running');
assert.deepEqual(empty.states, []);
empty.menu.destroy();

scale = 2;
monitor = {width: 640, height: 480};
const narrow = fixture([new Window('small')]);
narrow.menu.popup();
assert.equal(narrow.menu._thumbnailWidth, 352, 'preview width respects a narrow monitor');
assert.equal(narrow.menu._thumbnailHeight, 144);
assert.equal(narrow.menu._scrollView.style, 'max-height: 180px;', 'CSS bounds account for theme scaling');
narrow.menu.destroy();

for (const failingMethod of ['get_compositor_private', 'get_size', 'connect']) {
  const unavailable = new Window(`unavailable-${failingMethod}`);
  const healthy = new Window('healthy');
  const failingObject = failingMethod === 'get_compositor_private' ? unavailable : unavailable.actor;
  const originalMethod = failingObject[failingMethod];
  let connectCalls = 0;
  const failSource = (...args) => {
    if (failingMethod === 'connect' && ++connectCalls === 1) {
      return originalMethod.apply(failingObject, args);
    }
    throw new Error('compositor source already disposed');
  };
  failingObject[failingMethod] = failSource;
  const degraded = fixture([unavailable, healthy]);
  assert.equal(degraded.menu.popup(), true, `${failingMethod} failure keeps the chooser available`);
  assert.equal(degraded.menu._rows.size, 2, 'a failed surface does not discard selectable windows');
  assert.equal(degraded.menu._rows.get(unavailable).clone, null);
  assert.ok(degraded.menu._rows.get(unavailable).preview, 'bad sources degrade to an app icon');
  assert.ok(degraded.menu._rows.get(healthy).clone, 'other windows retain their visual previews');
  assert.equal(unavailable.actor.signals.size, 0, 'partial source connections are released on failure');
  failingObject[failingMethod] = originalMethod;
  unavailable.emit('size-changed');
  assert.ok(degraded.menu._rows.get(unavailable).clone, 'a newly available surface can recover');
  if (failingMethod === 'get_size') {
    const previousClone = degraded.menu._rows.get(unavailable).clone;
    failingObject[failingMethod] = failSource;
    unavailable.actor.emit('notify::width');
    assert.equal(previousClone.destroyCount, 1, 'a later source failure releases the existing clone');
    assert.equal(degraded.menu._rows.get(unavailable).clone, null);
    assert.ok(degraded.menu._rows.get(healthy).clone, 'one disposed source keeps sibling previews alive');
  }
  degraded.menu._rows.get(unavailable).item.emit('activate');
  assert.deepEqual(degraded.selected, [unavailable], 'a recovered/fallback row selects only its window');
  assert.equal(unavailable.signals.size, 0);
  assert.equal(unavailable.actor.signals.size, 0);
  assert.equal(healthy.actor.signals.size, 0);
  degraded.menu.destroy();
}

assert.ok(clones.every(clone => clone.destroyCount === 1), 'all compositor clones are released');
assert.equal(Main.uiGroup.children.length, 0, 'no menu actor survives destruction');
assert.equal(/(?:timeout_add|idle_add|setInterval|setTimeout)\s*\(/.test(source), false,
  'live previews use window/compositor signals without background polling');
console.log('window preview menu tests passed');
