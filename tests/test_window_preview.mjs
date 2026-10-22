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
    let result;
    for (const [id, [signal, callback]] of [...this.signals]) {
      if (signal === name && this.signals.has(id)) result = callback(this, ...args);
    }
    return result;
  }
}

class Actor extends Signals {
  constructor(params = {}) {
    super();
    Object.assign(this, {children: [], parent: null, visible: true, x: 0, y: 0, width: 0, height: 0,
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
  get_transformed_position() { return [this.x, this.y]; }
  get_transformed_size() { return this.get_size(); }
  contains(actor) {
    while (actor) {
      if (actor === this) return true;
      actor = actor.parent;
    }
    return false;
  }
  navigate_focus(...args) { this.navigation = args; stage.focus = this; return true; }
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
class Manager {
  constructor() { assert.fail('window previews never construct a modal menu manager'); }
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
    tracked: new Set(),
    trackChrome(actor, params) {
      assert.equal(this.tracked.has(actor), false, 'input region is tracked once per open');
      assert.deepEqual(params, {
        affectsInputRegion: true, affectsStruts: false, trackFullscreen: false,
      });
      this.tracked.add(actor);
    },
    untrackChrome(actor) {
      assert.equal(this.tracked.delete(actor), true, 'input region is released once per close');
    },
  },
  pushModal() { assert.fail('a preview never grabs stage input or forces keyboard focus'); },
};
const Clutter = {
  Clone, EVENT_PROPAGATE: 'propagate', EVENT_STOP: 'stop', ActorAlign: {CENTER: 'center'},
  EventType: {KEY_PRESS: 'key', BUTTON_PRESS: 'press', TOUCH_BEGIN: 'touch',
    MOTION: 'motion', ENTER: 'enter', LEAVE: 'leave'},
  ModifierType: {LOCK_MASK: 1, MOD2_MASK: 2, MODIFIER_MASK: 255},
  KEY_Escape: 'Escape', KEY_Down: 'Down', KEY_Up: 'Up', KEY_Left: 'Left', KEY_Right: 'Right',
};
const St = {
  BoxLayout: Actor, Bin: Actor, Label, Icon: Actor, ScrollView,
  Side: {TOP: 'top', BOTTOM: 'bottom', LEFT: 'left', RIGHT: 'right'},
  DirectionType: {TAB_FORWARD: 'tab-forward'},
  PolicyType: {NEVER: 'never', AUTOMATIC: 'automatic'},
  ThemeContext: {get_for_stage: () => ({scale_factor: scale})},
};
const Pango = {EllipsizeMode: {END: 'end'}};
const stage = new Signals();
stage.focus = null;
stage.get_key_focus = () => stage.focus;
stage.get_event_actor = event => event.target;
let wayland = false;
const loadMenu = version => new Function('Main', 'Clutter', 'St', 'PopupMenu', 'BoxPointer',
  'global', 'Pango', 'Config', 'Meta', `${source}\nreturn WindowPreviewMenu;`)(Main, Clutter, St,
  {PopupMenu: Popup, PopupBaseMenuItem: Actor, PopupMenuManager: Manager},
  {PopupAnimation: {FULL: 'full'}}, {stage}, Pango, {PACKAGE_VERSION: version},
  {is_wayland_compositor: () => wayland});
const WindowPreviewMenu = loadMenu('49.0');
const event = (type, target = null, key = null, coords = [0, 0], state = 0) => ({
  type: () => type, target, get_key_symbol: () => key, get_coords: () => coords,
  get_state: () => state,
});
const captured = (...args) => stage.emit('captured-event', event(...args));

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
function fixture(windows, Menu = WindowPreviewMenu) {
  const app = new Signals();
  app.get_windows = () => windows;
  app.get_name = () => 'Example';
  app.create_icon_texture = size => new Actor({icon_size: size});
  const icon = new Actor({app, reactive: true});
  const nativeMenu = {closeCount: 0, close() { this.closeCount++; }};
  icon._menu = nativeMenu;
  const selected = [];
  const states = [];
  const motions = [];
  const menu = new Menu(icon, {getWindows: () => windows,
    onActivate: window => selected.push(window), onOpenStateChanged: open => states.push(open),
    onPointerMotion: point => motions.push(point)});
  return {app, icon, windows, menu, selected, states, motions, nativeMenu};
}

const active = new Window('active');
const minimized = new Window('minimized', {minimized: true});
const missing = new Window('missing', {actor: null});
const skipped = new Window('skipped', {skip_taskbar: true});
const f = fixture([active, minimized, missing, skipped, active]);
assert.equal(f.app.signals.size, 0, 'closed menus have no app/window watchers');
assert.equal(stage.signals.size, 0, 'closed menus have no stage event listener');
const applicationFocus = new Actor();
stage.focus = applicationFocus;
assert.equal(f.menu.popup('left'), true);
assert.equal(stage.focus, applicationFocus, 'pointer opening never steals application keyboard focus');
assert.equal(stage.signals.size, 1, 'only an open menu listens for dismissal input');
assert.equal(Main.layoutManager.tracked.has(f.menu.actor), true,
  'older X11 sessions receive just the popup input rectangle');
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
Object.assign(f.menu.actor, {x: -400, y: 100, width: 300, height: 600});
assert.equal(f.menu.containsPoint(-300, 200), true, 'hover geometry includes negative monitor origins');
assert.equal(f.menu.containsPoint([-300, 200]), true, 'hover geometry accepts pointer coordinate arrays');
assert.equal(f.menu.containsPoint(-100, 200), false, 'popup bounds do not create a broad hover strip');
assert.equal(f.menu.containsPoint(NaN, 200), false);
assert.equal(captured(Clutter.EventType.BUTTON_PRESS, f.menu._rows.get(minimized).frame), 'propagate');
assert.equal(f.menu.isOpen, true, 'presses inside a preview remain available for row selection');
assert.equal(captured(Clutter.EventType.TOUCH_BEGIN, f.icon), 'propagate');
assert.equal(f.menu.isOpen, true, 'a source press reaches the app button to toggle the preview once');
assert.equal(captured(Clutter.EventType.MOTION, f.menu.actor, null, [-300, 200]), 'propagate');
assert.deepEqual(f.motions, [[-300, 200]], 'open-menu pointer motion can wake dock zoom without polling');
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
assert.equal(stage.signals.size, 0, 'selection releases the stage event listener');
assert.equal(Main.layoutManager.tracked.size, 0, 'selection removes the popup X11 input region');
assert.equal(stage.focus, applicationFocus, 'pointer selection/close does not force focus to the source button');
assert.equal(f.menu.containsPoint(-300, 200), false, 'a closed preview never retains hover geometry');
for (const window of [active, minimized, missing, added]) assert.equal(window.signals.size, 0);
for (const window of [active, missing, added]) if (window.actor) assert.equal(window.actor.signals.size, 0);
assert.equal(selectionItem.destroyCount, 1, 'native activation can safely destroy its own row');

for (const side of ['top', 'right', 'bottom', 'left']) {
  assert.equal(f.menu.popup(side), true);
  assert.equal(f.menu._boxPointer.side, side);
  assert.equal(f.menu.popup(side), false, 'clicking the source again dismisses the chooser');
  assert.equal(f.app.signals.size, 0, 'repeated opens do not retain app listeners');
  assert.equal(stage.signals.size, 0, 'repeated toggles release dismissal listeners');
}
f.menu.destroy();
f.menu.destroy();
assert.equal(f.menu.destroyCount, 1);
assert.equal(f.icon.signals.size, 0, 'destroy disconnects the source-actor lifetime hook');
assert.equal(f.menu.popup(), false, 'destroyed chooser cannot reopen');

for (const type of [Clutter.EventType.BUTTON_PRESS, Clutter.EventType.TOUCH_BEGIN]) {
  const outside = fixture([new Window(`outside-${type}`)]);
  outside.menu.popup();
  const otherIcon = new Actor();
  let activations = 0;
  otherIcon.connect('press', () => activations++);
  const result = captured(type, otherIcon);
  if (result !== Clutter.EVENT_STOP) otherIcon.emit('press');
  assert.equal(result, Clutter.EVENT_PROPAGATE, 'outside mouse/touch press propagates after dismissal');
  assert.equal(activations, 1, 'the first outside press reaches another app icon');
  assert.equal(outside.menu.isOpen, false, 'an outside click cancels without requiring a choice');
  assert.deepEqual(outside.selected, [], 'dismissing a preview never selects a window');
  assert.equal(stage.signals.size, 0);
  assert.equal(Main.layoutManager.tracked.size, 0);
  outside.menu.destroy();
}

const keyboard = fixture([new Window('keyboard')]);
keyboard.menu.popup();
stage.focus = applicationFocus;
assert.equal(captured(Clutter.EventType.KEY_PRESS, applicationFocus, Clutter.KEY_Escape),
  Clutter.EVENT_PROPAGATE, 'pointer-open Escape remains available to the previously focused app');
assert.equal(keyboard.menu.isOpen, false, 'Escape also cancels pointer previews without choosing a window');
assert.equal(stage.focus, applicationFocus, 'Escape never forces keyboard focus back to the dock');
assert.deepEqual(keyboard.selected, []);
keyboard.menu.popup('left');
stage.focus = keyboard.icon;
assert.equal(captured(Clutter.EventType.KEY_PRESS, keyboard.icon, Clutter.KEY_Right), Clutter.EVENT_STOP,
  'preview navigation wins before the source native context-menu arrow handler');
assert.deepEqual(keyboard.menu.actor.navigation, [null, St.DirectionType.TAB_FORWARD, false],
  'the arrow toward the preview explicitly enters native keyboard row navigation');
assert.equal(captured(Clutter.EventType.KEY_PRESS, keyboard.menu.actor, Clutter.KEY_Escape),
  Clutter.EVENT_STOP, 'Escape dismisses an explicitly keyboard-focused preview');
assert.equal(keyboard.menu.isOpen, false);
assert.deepEqual(keyboard.selected, [], 'Escape leaves every window unselected');
assert.equal(stage.signals.size, 0);
keyboard.menu.popup('bottom');
stage.focus = keyboard.icon;
assert.equal(captured(Clutter.EventType.KEY_PRESS, keyboard.icon, Clutter.KEY_Escape),
  Clutter.EVENT_STOP, 'Escape also cancels from the source button keyboard focus');
keyboard.menu.destroy();

for (const [version, isWayland] of [['50.0', false], ['51.0', true], ['49.0', true]]) {
  wayland = isWayland;
  const modern = fixture([new Window(`${version}-${isWayland}`)], loadMenu(version));
  modern.menu.popup();
  assert.equal(Main.layoutManager.tracked.size, 0,
    'GNOME 50+ and Wayland never receive removed X11 input-region options');
  assert.equal(stage.signals.size, 1, 'modern sessions retain nonmodal outside-click dismissal');
  modern.menu.destroy();
  assert.equal(stage.signals.size, 0);
}
wayland = false;

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
assert.equal(stage.signals.size, 0, 'source destruction releases the open stage listener');
assert.equal(Main.layoutManager.tracked.size, 0, 'source destruction removes the popup input region');

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
assert.equal(stage.signals.size, 0, 'no stage dismissal listener survives destruction');
assert.equal(Main.layoutManager.tracked.size, 0, 'no popup input rectangle survives destruction');
assert.equal(/(?:timeout_add|idle_add|setInterval|setTimeout)\s*\(/.test(source), false,
  'live previews use window/compositor signals without background polling');
console.log('window preview menu tests passed');
