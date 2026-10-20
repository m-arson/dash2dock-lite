#!/usr/bin/gjs -m
import Gio from 'gi://Gio';
import {getDropSlot, planFavoriteDrop, resolveFavoriteDrop} from '../dragOrder.js';

let assertions = 0;
const equal = (actual, expected, message) => {
  assertions++;
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
};

equal(getDropSlot(0, [10, 40, 100]), 0, 'before first');
equal(getDropSlot(20, [10, 40, 100]), 1, 'nonuniform icon spacing');
equal(getDropSlot(80, [10, 40, 100]), 2, 'between later icons');
equal(getDropSlot(200, [10, 40, 100]), 3, 'after last');
equal(getDropSlot(200, [100, 40, 10], true), 0, 'RTL leading edge');
equal(getDropSlot(20, [100, 40, 10], true), 2, 'RTL middle');
equal(getDropSlot(-1, [100, 40, 10], true), 3, 'RTL trailing edge');
equal(getDropSlot(NaN, []), null, 'reject invalid pointer');
equal(getDropSlot(0, [NaN]), null, 'wait for valid allocation');
equal(getDropSlot(0, []), 0, 'empty dock');

// Every existing source and every insertion gap must preserve exactly one
// copy of each favorite, including moves in either direction and both no-ops.
const ids = ['a', 'b', 'c', 'd', 'e'];
for (const source of [...ids, 'new']) {
  for (let slot = 0; slot <= ids.length; slot++) {
    const plan = planFavoriteDrop(ids, source, slot);
    const remaining = ids.filter(id => id !== source);
    const expected = [...ids.slice(0, slot).filter(id => id !== source),
      source, ...ids.slice(slot).filter(id => id !== source)];
    remaining.splice(resolveFavoriteDrop(ids, source, plan), 0, source);
    equal(remaining, expected, `${source} to gap ${slot}`);
    equal(plan.unchanged, JSON.stringify(ids) === JSON.stringify(expected), 'no-op');
  }
}
const racePlan = planFavoriteDrop(ids, 'a', 3);
equal(resolveFavoriteDrop(['new', ...ids], 'a', racePlan), 3, 'concurrent insertion');
equal(resolveFavoriteDrop(['a', 'b', 'c', 'e'], 'a', racePlan), 2, 'removed following anchor');
equal(resolveFavoriteDrop(['a', 'b', 'd', 'e'], 'a', racePlan), 1, 'removed preceding anchor');
equal(resolveFavoriteDrop([], 'a', racePlan), 0, 'both anchors removed');

// Load the production Dock class with small GI stand-ins. This exercises the
// actual drop and redisplay methods without requiring a running GNOME session.
class Actor {
  constructor(params = {}) {
    Object.assign(this, {visible: true, width: 40, height: 40, x: 0, y: 0,
      text_direction: 1, children: [], destroyed: false}, params);
  }
  get_children() { return [...this.children]; }
  get_n_children() { return this.children.length; }
  get_parent() { return this.parent ?? null; }
  get_transformed_position() { return [this.x, this.y]; }
  get_transformed_size() { return [this.width, this.height]; }
  add_child(actor) { this.children.push(actor); actor.parent = this; }
  insert_child_at_index(actor, index) {
    if (actor.parent) actor.parent.children = actor.parent.children.filter(c => c !== actor);
    this.children.splice(index, 0, actor);
    actor.parent = this;
  }
  set_child_at_index(actor, index) { this.insert_child_at_index(actor, index); }
  set_child_below_sibling(actor, anchor) {
    const children = this.children.filter(c => c !== actor);
    this.insert_child_at_index(actor, anchor ? children.indexOf(anchor) : 0);
  }
  set_child_above_sibling(actor, anchor) {
    const children = this.children.filter(c => c !== actor);
    this.insert_child_at_index(actor, anchor ? children.indexOf(anchor) + 1 : children.length);
  }
  set_size(width, height) { this.width = width; this.height = height; }
  show() { this.visible = true; }
  destroy() {
    if (this.destroyed) throw new Error('actor destroyed twice');
    this.destroyed = true;
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
}
const app = id => ({get_id: () => id, is_window_backed: () => false});
const item = (id, x, y) => {
  const actor = new Actor({x, y});
  actor.child = {_delegate: {app: app(id)}};
  return actor;
};
let favoriteIds;
let moves;
let writable = true;
const pending = new Map();
let nextLater = 1;
const favorites = {
  getFavorites: () => favoriteIds.map(app),
  moveFavoriteToPos: (id, position) => {
    moves.push([id, position]);
    favoriteIds = favoriteIds.filter(other => other !== id);
    favoriteIds.splice(position, 0, id);
  },
  addFavoriteAtPos: (id, position) => {
    moves.push([id, position]);
    favoriteIds.splice(position, 0, id);
  },
};
const laters = {
  add: (_type, callback) => { const id = nextLater++; pending.set(id, callback); return id; },
  remove: id => pending.delete(id),
};
const dragMonitors = new Set();
let nativeEmptyTargets = 0;
class NativeDash {
  _onItemDragBegin() {
    this._dragCancelled = false;
    this._dragMonitor = {};
    dragMonitors.add(this._dragMonitor);
    // GNOME 48's native contract counts every child, including hidden boxes.
    if (this._box.get_n_children() === 0) {
      nativeEmptyTargets++;
      this._emptyDropTarget = new Actor({width: this.iconSize, height: this.iconSize});
      this._box.insert_child_at_index(this._emptyDropTarget, 0);
    }
  }
  _onItemDragCancelled() {
    this._dragCancelled = true;
    this._endItemDrag();
  }
  _onItemDragEnd() {
    if (!this._dragCancelled) this._endItemDrag();
  }
}
const mocks = {
  DashModule: {Dash: NativeDash},
  DND: {DragMotionResult: {NO_DROP: 0, MOVE_DROP: 2, CONTINUE: 3},
    removeDragMonitor: monitor => dragMonitors.delete(monitor)},
  GObject: {registerClass: (...args) => args.at(-1)},
  St: {Widget: Actor, Bin: Actor},
  Clutter: {TextDirection: {LTR: 1, RTL: 2}, EVENT_STOP: true},
  Graphene: {Point: class {}},
  Config: {PACKAGE_VERSION: '48'},
  Fav: {getAppFavorites: () => favorites},
  global: {settings: {is_writable: () => writable}, compositor: {get_laters: () => laters}},
  Meta: {LaterType: {BEFORE_REDRAW: 1}},
  GLib: {SOURCE_REMOVE: false},
  Main: {overview: {dash: {showAppsButton: {checked: false}}},
    ctrlAltTabManager: {removeGroup() {}}},
  getDropSlot, planFavoriteDrop, resolveFavoriteDrop,
};
const [, bytes] = Gio.File.new_for_uri(import.meta.url).get_parent()
  .resolve_relative_path('../dock.js').load_contents(null);
const source = new TextDecoder().decode(bytes)
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm, '')
  .replace(/^export /gm, '');
const {Dock, DockDash, guardBaseIcon} = new Function(...Object.keys(mocks),
  `${source}\nreturn {Dock, DockDash, guardBaseIcon};`)(...Object.values(mocks));
function fixture(vertical = true) {
  favoriteIds = ['a', 'b', 'c'];
  moves = [];
  pending.clear();
  writable = true;
  const dock = Object.create(Dock.prototype);
  dock.isVertical = () => vertical;
  dock._beginAnimation = () => {};
  const box = new Actor({x: -500, y: 120, width: vertical ? 40 : 200,
    height: vertical ? 200 : 40});
  for (let i = 0; i < 3; i++) box.add_child(item(favoriteIds[i],
    box.x + (vertical ? 0 : 40 * i), box.y + (vertical ? 40 * i : 0)));
  const running = item('running', box.x + 140, box.y + 140);
  box.add_child(running);
  const separator = new Actor();
  box.insert_child_at_index(separator, 3);
  const extras = new Actor();
  box.add_child(extras);
  const dash = {_box: box, _separator: separator, iconSize: 40,
    _appSystem: {get_running: () => [app('running')]}};
  dock.dash = dash;
  dock._extraIcons = extras;
  dash._createAppItem = sourceApp => item(sourceApp.get_id(), 0, 0);
  return {dock, dash, box, running, extras};
}

function nativeDragFixture(favoritesOnly = false, keepRunning = false) {
  const fixtureParts = fixture();
  const {dock, box, extras, running} = fixtureParts;
  favoriteIds = [];
  for (const actor of box.get_children()) {
    if (actor !== extras && !(keepRunning && actor === running)) actor.destroy();
  }
  extras.visible = false;
  dock.extension = {favorites_only: favoritesOnly};
  const dash = Object.assign(new DockDash(), fixtureParts.dash, {
    _d2dlOwner: dock, _separator: null, _showAppsIcon: {setDragApp() {}},
  });
  dash._clearDragPlaceholder = () => dock._clearDashPlaceholder(dash);
  dash._clearEmptyDropTarget = () => dock._clearEmptyDashDropTarget(dash);
  dock.dash = dash;
  return {...fixtureParts, dash};
}
for (const [favoritesOnly, keepRunning] of [[false, false], [true, true]]) {
  const {dock, dash, box} = nativeDragFixture(favoritesOnly, keepRunning);
  const initialNativeTargets = nativeEmptyTargets;
  dash._onItemDragBegin();
  const emptyTarget = dash._emptyDropTarget;
  equal(nativeEmptyTargets, initialNativeTargets, 'native child-count check misses empty custom dock');
  equal(!!emptyTarget && emptyTarget.visible && emptyTarget.width > 0 && emptyTarget.height > 0,
    true, 'custom empty drop target has visible, nonzero geometry');
  equal(box.children.includes(emptyTarget), true, 'empty target participates in native box layout');
  equal(dragMonitors.size, 1, 'empty dock retains one native drag monitor');
  equal(dock._handleDashDragOver(dash, {app: app('new')}, 20, 20), 2,
    'empty drop target supports pinning a new app');
  const placeholder = dash._dragPlaceholder;
  dash._onItemDragCancelled();
  equal(emptyTarget.destroyed && placeholder.destroyed && !dash._emptyDropTarget,
    true, 'cancel destroys empty target and placeholder synchronously');
  equal(dragMonitors.size, 0, 'cancel removes the native drag monitor');

  dash._onItemDragBegin();
  const acceptedTarget = dash._emptyDropTarget;
  equal(dock._acceptDashDrop(dash, {app: app('new')}, 20, 20), true, 'empty dock accepts app drop');
  dash._onItemDragEnd();
  for (const callback of [...pending.values()]) callback();
  equal(favoriteIds, ['new'], 'drop into empty dock pins exactly one favorite');
  equal(acceptedTarget.destroyed && dragMonitors.size === 0, true,
    'successful drop releases empty target and monitor');
}
{
  const {dock, dash} = nativeDragFixture();
  dock.cancelAnimations = () => {};
  dash._onItemDragBegin();
  const target = dash._emptyDropTarget;
  dock._prepareDashDestroy(dash);
  equal(target.destroyed && !dash._emptyDropTarget && dragMonitors.size === 0, true,
    'dock teardown releases an active empty drop target and drag monitor');
}
{
  const {dock, dash: fields} = fixture();
  dock.extension = {favorites_only: false};
  const dash = Object.assign(new DockDash(), fields, {
    _d2dlOwner: dock, _showAppsIcon: {setDragApp() {}},
  });
  dock.dash = dash;
  dash._clearDragPlaceholder = () => dock._clearDashPlaceholder(dash);
  dash._clearEmptyDropTarget = () => dock._clearEmptyDashDropTarget(dash);
  dash._onItemDragBegin();
  equal(dash._emptyDropTarget ?? null, null, 'populated dock does not gain an empty drop zone');
  dash._onItemDragEnd();
}

for (const vertical of [true, false]) {
  for (const [pointer, expected] of [[0, 0], [45, 1], [85, 2], [180, 3]]) {
    const {dock, dash} = fixture(vertical);
    const drop = dock._getDashDrop(dash, {app: app('new')}, vertical ? 20 : pointer,
      vertical ? pointer : 20);
    equal(drop.slot, expected, `${vertical ? 'vertical' : 'horizontal'} slot ${expected}`);
  }
}
{
  const {dock, dash, box} = fixture();
  equal(dock._handleDashDragOver(dash, {app: app('c')}, 20, 0), 2, 'move upwards');
  const placeholder = dash._dragPlaceholder;
  equal(box.children[0] === placeholder, true, 'placeholder at beginning');
  equal(dock._handleDashDragOver(dash, {app: app('c')}, 20, 45), 2, 'move to middle');
  equal(dash._dragPlaceholder === placeholder, true, 'placeholder reused');
  equal(placeholder.height < placeholder.width, true, 'vertical placeholder orientation');
  dock._acceptDashDrop(dash, {app: app('c')}, 20, 45);
  equal(moves, [], 'favorites mutation deferred until after drag event');
  dock._clearDashPlaceholder(dash);
  for (const callback of [...pending.values()]) callback();
  equal(favoriteIds, ['a', 'c', 'b'], 'drop in middle keeps all icons');
}
{
  const {dock, dash} = fixture();
  dock._handleDashDragOver(dash, {app: app('a')}, 20, 180);
  const children = dash._box.children;
  equal(children.indexOf(dash._dragPlaceholder) + 1, children.indexOf(dash._separator),
    'last favorite placeholder stays before running app separator');
  dock._acceptDashDrop(dash, {app: app('a')}, 20, 180);
  dock._cancelFavoriteDrop(dash);
  equal(pending.size, 0, 'teardown cancels queued favorites write');
}
{
  const {dock, dash} = fixture();
  dock._acceptDashDrop(dash, {app: app('a')}, 20, 180);
  dash._d2dlDestroying = true;
  for (const callback of [...pending.values()]) callback();
  equal(moves, [], 'stale deferred callback does not change favorites');
}
{
  const {dock, dash} = fixture();
  writable = false;
  equal(dock._acceptDashDrop(dash, {app: app('a')}, 20, 180), false, 'read-only favorites');
  equal(dock._handleDashDragOver(dash, {app: app('a')}, 20, 180), 0, 'read-only drag');
}
{
  const {dock, dash, box, extras} = fixture();
  const original = new Map(box.children.filter(c => c.child).map(c => [c.child._delegate.app.get_id(), c]));
  favoriteIds = ['c', 'a', 'b'];
  dock._redisplayDash(dash);
  equal(box.children.filter(c => c.child).map(c => c.child._delegate.app.get_id()),
    ['c', 'a', 'b', 'running'], 'redisplay reordered actors');
  for (const [id, actor] of original)
    equal(box.children.includes(actor) && !actor.destroyed, true, `${id} actor survives reorder`);
  equal(box.children.at(-1) === extras, true, 'extras remain after application section');
}
{
  const {dock, dash, box} = fixture(false);
  box.text_direction = 2;
  box.children.filter(c => c.child).slice(0, 3).forEach((c, i) => {
    c.x = box.x + 100 - 40 * i;
  });
  equal(dock._getDashDrop(dash, {app: app('new')}, 180, 20).slot, 0, 'RTL stage geometry first gap');
  equal(dock._getDashDrop(dash, {app: app('new')}, 70, 20).slot, 2, 'RTL stage geometry middle gap');
  equal(dock._getDashDrop(dash, {app: app('new')}, 0, 20).slot, 3, 'RTL stage geometry last gap');
}
{
  const {dock, dash, box} = fixture();
  favoriteIds = [];
  box.children = box.children.filter(c => !c.child);
  equal(dock._getDashDrop(dash, {app: app('new')}, 20, 20).slot, 0, 'first favorite in empty application section');
  equal(dock._handleDashDragOver(dash, {app: app('new')}, 20, 20), 2, 'empty dock offers insertion');
  equal(dock._acceptDashDrop(dash, {app: app('new')}, 20, 20), true, 'empty dock accepts insertion');
  for (const callback of [...pending.values()]) callback();
  equal(favoriteIds, ['new'], 'empty dock pins first favorite');
}
{
  const {dock, dash} = fixture();
  dock._acceptDashDrop(dash, {app: app('a')}, 20, 180);
  favoriteIds = ['b', 'c'];
  for (const callback of [...pending.values()]) callback();
  equal(favoriteIds, ['b', 'c'], 'concurrent unpin stays removed');
}
{
  const {dock, dash} = fixture();
  dock._acceptDashDrop(dash, {app: app('a')}, 20, 180);
  writable = false;
  for (const callback of [...pending.values()]) callback();
  equal(moves, [], 'writeability rechecked before deferred commit');
}
{
  const {dock, dash} = fixture();
  const before = favoriteIds.join(',');
  dash._box.children[0].y = NaN;
  equal(dock._acceptDashDrop(dash, {app: app('a')}, 20, 180), false, 'unallocated geometry rejects drop');
  equal(favoriteIds.join(','), before, 'invalid geometry preserves favorites');
}
{
  let creates = 0;
  const callbacks = {};
  const icon = {
    connect: (signal, callback) => { callbacks[signal] = callback; },
    _createIconTexture() {
      creates++;
      this._createIconTexture(48); // style change reenters during old texture destruction
    },
  };
  guardBaseIcon(icon);
  icon._createIconTexture(48);
  equal(creates, 1, 'texture recreation cannot reenter itself');
  callbacks.destroy();
  icon._createIconTexture(48);
  equal(creates, 1, 'destroying BaseIcon cannot create new texture');
}
{
  const {dock} = fixture();
  const calls = [];
  const menu = {close: () => calls.push('close'), destroy: () => calls.push('destroy')};
  const actor = {_menu: menu, _menuManager: {removeMenu: () => calls.push('container detach')},
    child: {_menu: menu, _menuManager: {removeMenu: () => calls.push('icon detach')}}};
  dock._cleanupIcon(actor);
  dock._cleanupIcon(actor);
  equal(calls, ['close', 'container detach', 'icon detach', 'destroy'], 'shared menu releases both managers and destroys once');
  equal(actor.child._menu, null, 'child cannot retain destroyed popup');
}
{
  const {dock} = fixture();
  const actions = new Map();
  let id = 0;
  dock.extension = {_hiTimer: {
    runOnce: callback => { const sequence = ++id; actions.set(sequence, callback); return sequence; },
    cancel: sequence => actions.delete(sequence),
  }};
  let calls = 0;
  dock._runDeferredAction(() => calls++, 50);
  equal(actions.size, 1, 'window action is tracked');
  dock.cancelAnimations();
  equal(actions.size, 0, 'dock teardown cancels delayed window action');
  dock._runDeferredAction(() => calls++, 50);
  dock.dash = {};
  for (const callback of actions.values()) callback();
  equal(calls, 0, 'old dash callback cannot act after replacement');
}
{
  const dock = Object.create(Dock.prototype);
  const handlers = new Map();
  let connections = 0;
  let labelVisible = false;
  const appsIcon = new Actor({child: {}, _icon: {}, _button: {}, _label: {}});
  appsIcon.showLabel = () => { labelVisible = true; };
  appsIcon.hideLabel = () => { labelVisible = false; };
  appsIcon.connectObject = (...args) => {
    connections++;
    for (let index = 0; index < args.length - 1; index += 2)
      handlers.set(args[index], args[index + 1]);
  };
  dock.extension = {apps_icon: true, animate_icons_unmute: true};
  dock.dash = {_box: new Actor(), _showAppsIcon: appsIcon,
    showAppsButton: {checked: false}};
  dock._inspectIcon = function (icon) {
    this._icons.push(icon);
    this._dashItems.push(icon);
    return true;
  };
  dock._findIcons();
  equal([appsIcon.reactive, appsIcon._button.reactive], [true, false],
    'animated Show Apps receives events on its container');
  handlers.get('enter-event')();
  equal(labelVisible, true, 'container hover shows Show Apps label');
  handlers.get('leave-event')();
  equal(labelVisible, false, 'container leave hides Show Apps label');
  dock.extension.hide_labels = true;
  handlers.get('enter-event')();
  equal(labelVisible, false, 'Show Apps respects hidden labels');
  appsIcon._icon = {};
  dock._icons = null;
  dock._findIcons();
  equal(connections, 1, 'cache rebuild and texture replacement keep one event connection');

  let shown = 0;
  let hidden = 0;
  const overview = mocks.Main.overview;
  overview.showApps = () => shown++;
  overview.hide = () => hidden++;
  overview.visible = false;
  equal(handlers.get('button-press-event')(), true, 'Show Apps consumes its button press');
  overview.visible = true;
  overview.dash.showAppsButton.checked = false;
  handlers.get('button-press-event')();
  equal([shown, hidden], [2, 0], 'desktop and window overview open the app grid');
  overview.dash.showAppsButton.checked = true;
  handlers.get('button-press-event')();
  equal([shown, hidden], [2, 1], 'app grid closes using the overview button state');
}

const [, itemBytes] = Gio.File.new_for_uri(import.meta.url).get_parent()
  .resolve_relative_path('../dockItems.js').load_contents(null);
const itemSource = new TextDecoder().decode(itemBytes)
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm, '')
  .replace(/^export /gm, '');
const itemMocks = {
  ...mocks, DashIcon: Actor, DashItemContainer: Actor,
  Clutter: {...mocks.Clutter, BUTTON_SECONDARY: 3, EVENT_STOP: true},
  St: {...mocks.St, Side: {TOP: 0}}, PopupMenu: {PopupMenu: class {}},
};
const {DockIcon, DockBackground} = new Function(...Object.keys(itemMocks),
  `${itemSource}\nreturn {DockIcon, DockBackground};`)(...Object.values(itemMocks));
{
  const icon = Object.create(DockIcon.prototype);
  let clicks = 0;
  let timeouts = 0;
  let popups = 0;
  icon.parent = {_onClick: () => clicks++, _menu: {popup: () => popups++}};
  icon._removeMenuTimeout = () => timeouts++;
  icon.fake_release = () => {};
  icon.vfunc_clicked(1);
  equal([clicks, timeouts, popups], [1, 1, 0], 'regular click launches once and cancels long-press menu');
  icon.popupMenu();
  equal([clicks, timeouts, popups], [1, 2, 1], 'custom menu cancels outstanding long press');
}
{
  const background = new DockBackground();
  const icon = {_icon: {translation_x: 0, translation_y: 0}};
  const dock = {x: -400, y: 200, width: 100, height: 500,
    extension: {dock_padding: 0}, isVertical: () => true,
    dash: {get_transformed_position: () => [-400, 200], width: 40, height: 40}};
  background.update({first: icon, last: icon, iconSize: 40, scaleFactor: 1,
    vertical: true, panel_mode: true, dock});
  equal([background.opacity, background.y, background.height], [255, 0, 500],
    'single-icon panel uses local monitor coordinates');
}
print(`PASS ${assertions} drag ordering assertions`);
