import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../dock.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm, '')
  .replace(/^export /gm, '');
const Shell = {AppState: {STOPPED: 0, STARTING: 1, RUNNING: 2}};
const Clutter = {
  BUTTON_PRIMARY: 1, BUTTON_MIDDLE: 2, BUTTON_SECONDARY: 3,
  ScrollDirection: {UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3},
  ModifierType: {CONTROL_MASK: 1 << 2, SHIFT_MASK: 1, BUTTON2_MASK: 1 << 9},
  get_current_event: () => currentEvent,
};
let currentEvent = null;
let pointer = [116, 116];
let activeWorkspace;
let overviewHides = 0;
const Main = {
  layoutManager: {monitors: [{index: 0}, {index: 1}]},
  overview: {visible: false, hide() { overviewHides++; this.visible = false; }},
};
// A small popup boundary fake keeps these tests focused on dock ownership and
// window selection. The actual thumbnail actors and popup lifecycle have their
// own component regression suite.
class WindowPreviewMenu {
  constructor(appIcon, options) {
    if (appIcon._previewOptions.previewThrows) throw new Error('Preview unavailable');
    this.appIcon = appIcon;
    this.options = options;
    this.side = options.side;
    this.isOpen = false;
    this.destroyed = false;
    this.rect = [150, 90, 240, 180];
    this.actor = {visible: true,
      get_transformed_position: () => this.rect.slice(0, 2),
      get_transformed_size: () => this.rect.slice(2)};
    appIcon._previewInstances.push(this);
  }
  popup(side) {
    this.appIcon._testCalls.push(['preview', side]);
    this.side = side;
    if (this.isOpen) {
      this.close();
      return false;
    }
    if (this.appIcon._previewOptions.previewOpens === false) return false;
    this.isOpen = true;
    this.options.onOpenStateChanged(true);
    return true;
  }
  setSide(side) { this.side = side; }
  containsPoint(x, y) {
    if (Array.isArray(x)) [x, y] = x;
    const [left, top, width, height] = this.rect;
    return this.isOpen && this.actor.visible !== false &&
      x >= left && x < left + width && y >= top && y < top + height;
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.options.onOpenStateChanged(false);
  }
  destroy() { this.close(); this.destroyed = true; }
  select(window) { this.close(); this.options.onActivate(window); }
}
const dependencies = {
  Main, Shell, Clutter, WindowPreviewMenu,
  isInRect: ([x, y, width, height], [px, py], margin = 0) =>
    px >= x - margin && px < x + width + margin &&
    py >= y - margin && py < y + height + margin,
  DashModule: {Dash: class {}},
  GObject: {registerClass: (...args) => args.at(-1)},
  St: {Widget: class {}, Side: {BOTTOM: 'bottom', TOP: 'top', LEFT: 'left', RIGHT: 'right'}},
  Config: {PACKAGE_VERSION: '48'},
  Graphene: {Point: class {}},
  global: {
    workspace_manager: {get_active_workspace: () => activeWorkspace},
    get_current_time: () => 1234,
    get_pointer: () => [...pointer],
  },
};
const Dock = new Function(...Object.keys(dependencies), `${source}\nreturn Dock;`)(
  ...Object.values(dependencies));

// Exercise _findIcons' actual installed activate wrapper, not just selection.
// The native fallback deliberately has group effects, as Shell.App.activate()
// can: a regular click must never reach it after our single-window activation.
function fixture(specs, options = {}) {
  currentEvent = null;
  pointer = [116, 116];
  overviewHides = 0;
  Main.overview.visible = options.overviewVisible ?? false;
  const calls = [];
  const menuCallbacks = new Map();
  const menuOpenSnapshots = [];
  const pointerUpdates = [];
  const createMenu = requestedSide => {
    // Native PopupMenu mirrors horizontal arrow sides in RTL at construction.
    // A dock edge is physical, so the menu must be corrected before opening.
    const physicalSide = options.rtl && ['left', 'right'].includes(requestedSide)
      ? ({left: 'right', right: 'left'})[requestedSide] : requestedSide;
    const menu = {
      isOpen: false, _arrowSide: physicalSide,
      _boxPointer: {
        _arrowSide: physicalSide, _userArrowSide: physicalSide,
        updateArrowSide(side) { this._arrowSide = side; pointerUpdates.push(['side', side]); },
        queue_relayout() { pointerUpdates.push(['layout']); },
      },
      open() {
        menuOpenSnapshots.push({menu: this._arrowSide, arrow: this._boxPointer._arrowSide,
          requested: this._boxPointer._userArrowSide});
        this.isOpen = options.menuOpens !== false;
      },
      connectObject(signal, callback) { menuCallbacks.set(signal, callback); },
    };
    return menu;
  };
  const autohideCalls = [];
  const animationWakes = [];
  const windows = [];
  let showingDesktop = options.showDesktop ?? false;
  const focus = window => windows.forEach(w => { w.focused = w === window; });
  const workspaces = [0, 1].map(id => ({
    id,
    activate_with_focus(window, time) {
      calls.push(['workspace', id, window.id, time]);
      activeWorkspace = this;
      focus(window);
    },
  }));
  activeWorkspace = workspaces[0];
  for (const [index, spec] of specs.entries()) {
    const window = {
      id: spec.id ?? index, minimized: false, focused: false, monitor: 0,
      workspace: 0, time: index, cycleId: index, ...spec,
      get_id() { return this.cycleId; },
      has_focus() { return this.focused; },
      get_monitor() { return this.monitor; },
      get_workspace() { return workspaces[this.workspace]; },
      get_user_time() { return this.time; },
      is_hidden() { return showingDesktop || this.minimized || this.get_workspace() !== activeWorkspace; },
      unminimize() { calls.push(['restore', this.id]); this.minimized = false; },
      minimize() { calls.push(['minimize', this.id]); this.minimized = true; this.focused = false; },
      maximize() { calls.push(['maximize', this.id]); },
      unmaximize() { calls.push(['unmaximize', this.id]); },
      raise() { calls.push(['raise', this.id]); },
      focus(time) { calls.push(['focus', this.id, time]); focus(this); },
      activate(time) {
        calls.push(['activate', this.id, time]);
        if (showingDesktop) {
          showingDesktop = false;
          // Mutter leaves Show Desktop through native activation and retains
          // other windows as minimized, rather than exposing the app group.
          windows.forEach(window => { if (window !== this) window.minimized = true; });
        }
        this.minimized = false;
        this.raise();
        this.focus(time);
      },
    };
    if (spec.noUserTime) delete window.get_user_time;
    windows.push(window);
  }
  const app = {
    state: options.state ?? Shell.AppState.RUNNING,
    get_windows: () => windows,
    can_open_new_window: () => options.canOpen !== false,
  };
  const appwell = {
    app,
    _previewOptions: options,
    _previewInstances: [],
    _testCalls: calls,
    visible: true,
    get_transformed_position: () => [100, 100],
    get_transformed_size: () => [32, 32],
    connectObject(signal, callback) { menuCallbacks.set(signal, callback); },
    popupMenu(side) {
      calls.push(['popup', side]);
      if (options.nativeMenu) {
        // Older DashIcons always construct BOTTOM; current AppIcons read a
        // side property. Neither implementation accepts a popupMenu argument.
        this._menu ??= createMenu(options.nativeMenu === 'property'
          ? this._popupMenuSide : 'bottom');
        menuCallbacks.get('menu-state-changed')?.(this, true);
        this._menu.open();
      } else {
        this._menu ??= {isOpen: false};
        this._menu.isOpen = options.menuOpens !== false;
      }
      // This is Shell's real return contract, including a successful open.
      return false;
    },
    activate(button) {
      assert.equal(this, appwell, 'native activation retains the button receiver');
      calls.push(['native', button]);
      if (options.nativeMenu && button === Clutter.BUTTON_SECONDARY) {
        this.popupMenu();
        return;
      }
      if (options.custom) {
        calls.push(['custom-launch']);
      } else if (app.state === Shell.AppState.RUNNING && app.can_open_new_window() &&
          (button === Clutter.BUTTON_MIDDLE ||
           (currentEvent?.get_state() & Clutter.ModifierType.CONTROL_MASK))) {
        calls.push(['new-window']);
      } else {
        windows.forEach(window => window.unminimize());
        calls.push(['native-activate-group']);
      }
      Main.overview.hide();
    },
  };
  if (options.menuMissing) delete appwell.popupMenu;
  const icon = {_icon: {}, _appwell: appwell, child: appwell, custom_icon: options.custom,
    visible: true, get_transformed_position: () => [100, 100],
    get_transformed_size: () => [32, 32]};
  if (options.customMenu) {
    icon._menu = createMenu('bottom');
  }
  const dock = Object.create(Dock.prototype);
  Object.assign(dock, {
    extension: {multi_monitor_filter: options.filter ?? 0, multi_monitor_preference: 1,
      animate_icons_unmute: true},
    _monitor: {index: 0},
    _position: options.position ?? 'bottom',
    _scrollCounter: 0,
    _beginAnimation() { animationWakes.push('begin'); },
    isVertical: () => ['left', 'right'].includes(options.position),
    autohider: {
      _enabled: true,
      show: () => autohideCalls.push('show'),
      _debounceCheckHide: () => autohideCalls.push('check'),
    },
    dash: {_box: {get_children: () => [icon]}},
    _inspectIcon(item) { this._icons.push(item); this._dashItems.push(item); },
    _maybeBounce() {},
    _runDeferredAction() { assert.fail('app click must not queue group mutations'); },
    _lockCycle() { calls.push(['lock']); this._lockedCycle = true; },
  });
  dock._findIcons();
  return {
    dock, windows, calls, appwell, workspaces, icon, menuCallbacks, autohideCalls, animationWakes,
    menuOpenSnapshots, pointerUpdates,
    isShowingDesktop: () => showingDesktop,
    click(button = Clutter.BUTTON_PRIMARY, modifiers = 0) {
      currentEvent = modifiers ? {get_state: () => modifiers} : null;
      appwell.activate(button);
    },
    scroll(amount = 2, modifiers = 0) {
      dock._scrollCounter = amount;
      return dock._cycleWindows(app, {get_state: () => modifiers});
    },
  };
}
function ids(fixture, action) {
  return fixture.calls.filter(call => call[0] === action).map(call => call[1]);
}
function assertSingleActivation(fixture, id, restored = []) {
  assert.deepEqual(ids(fixture, 'native'), [], 'normal click never activates the app group');
  assert.deepEqual(ids(fixture, 'activate'), [id], 'exactly the chosen window receives native activation');
  assert.deepEqual(ids(fixture, 'focus'), [id], 'exactly the chosen window gains focus');
  assert.deepEqual(ids(fixture, 'raise'), [id], 'exactly the chosen window is raised');
  assert.deepEqual(ids(fixture, 'restore'), restored, 'only the selected minimized window is restored');
  assert.deepEqual(ids(fixture, 'minimize'), [], 'dock activation never minimizes sibling windows');
  assert.equal(overviewHides, 1, 'handled activation closes the overview once');
}

const mixed = fixture([
  {id: 'visible', time: 10},
  {id: 'minimized-newer', time: 100, minimized: true},
]);
mixed.click();
assertSingleActivation(mixed, 'visible');
assert.equal(mixed.windows[1].minimized, true, 'minimized sibling stays minimized');

const minimized = fixture([
  {id: 'older', time: 5, minimized: true},
  {id: 'latest', time: 20, minimized: true},
]);
minimized.click();
assertSingleActivation(minimized, 'latest', ['latest']);
assert.equal(minimized.windows[0].minimized, true, 'restoring an app restores only its latest window');

const focused = fixture([
  {id: 'active', time: 5, focused: true},
  {id: 'other', time: 20, minimized: true},
]);
focused.click();
assert.deepEqual(focused.calls, [['preview', 'bottom']],
  'clicking an active app with multiple windows opens the thumbnail chooser');
assert.equal(focused.appwell._windowPreviewMenu.isOpen, true);
assert.equal(focused.appwell._menu, undefined, 'thumbnail selection does not create a native app menu');
assert.equal(overviewHides, 0, 'opening the chooser must not hide the overview and close it');
assert.equal(focused.windows[1].minimized, true, 'opening a chooser does not restore its rows');
assert.deepEqual(focused.appwell._windowPreviewMenu.options.getWindows(), focused.windows,
  'the component receives the live application window list');
focused.appwell._windowPreviewMenu.select(focused.windows[1]);
assertSingleActivation(focused, 'other', ['other']);
assert.equal(focused.appwell._windowPreviewMenu.isOpen, false);

const reusedPreview = fixture([{focused: true}, {}]);
assert.equal(reusedPreview.appwell._previewInstances.length, 0, 'previews are constructed lazily');
reusedPreview.click();
reusedPreview.click(1, Clutter.ModifierType.SHIFT_MASK);
assert.equal(reusedPreview.appwell._windowPreviewMenu.isOpen, false,
  'a second click dismisses the thumbnail chooser');
assert.deepEqual(ids(reusedPreview, 'popup'), [], 'dismissing previews does not open the native title list');
reusedPreview.click();
assert.equal(reusedPreview.appwell._previewInstances.length, 1, 'reopening reuses its owned popup');
assert.equal(reusedPreview.appwell._windowPreviewMenu.isOpen, true);

const single = fixture([{id: 'only', focused: true}]);
single.click();
assert.deepEqual(single.calls, [['minimize', 'only']], 'focused single-window click minimizes only it');
assert.equal(overviewHides, 1);
single.calls.length = 0;
overviewHides = 0;
single.click();
assertSingleActivation(single, 'only', ['only']);

const hiddenFocusedSingle = fixture([{id: 'only', focused: true, minimized: true}]);
hiddenFocusedSingle.click();
assertSingleActivation(hiddenFocusedSingle, 'only', ['only']);

const hiddenFocusedGroup = fixture([
  {id: 'previously-focused', focused: true, minimized: true, time: 5},
  {id: 'recent-hidden', minimized: true, time: 20},
]);
hiddenFocusedGroup.click();
assertSingleActivation(hiddenFocusedGroup, 'recent-hidden', ['recent-hidden']);
assert.deepEqual(ids(hiddenFocusedGroup, 'preview'), [],
  'a minimized window with stale focus never opens a chooser instead of restoring');
assert.equal(hiddenFocusedGroup.windows[0].minimized, true,
  'restoring after desktop hiding leaves other minimized windows alone');

const desktopSingle = fixture([{id: 'only', focused: true}], {showDesktop: true});
desktopSingle.click();
assertSingleActivation(desktopSingle, 'only');
assert.equal(desktopSingle.isShowingDesktop(), false,
  'native window activation exits Show Desktop even when the window is not minimized');

const desktopGroup = fixture([
  {id: 'stale-focused', focused: true, time: 5},
  {id: 'selected', time: 20},
], {showDesktop: true});
desktopGroup.click();
assertSingleActivation(desktopGroup, 'selected');
assert.deepEqual(ids(desktopGroup, 'preview'), [],
  'a window hidden by Show Desktop does not count as an active app chooser trigger');
assert.equal(desktopGroup.isShowingDesktop(), false);
assert.equal(desktopGroup.windows[0].minimized, true,
  'native activation preserves the other window as minimized after Show Desktop');

const overviewSingle = fixture([{id: 'only', focused: true}], {overviewVisible: true});
overviewSingle.click();
assertSingleActivation(overviewSingle, 'only');
assert.equal(Main.overview.visible, false, 'selecting the sole window exits the overview');

const overviewChooser = fixture([
  {id: 'active', focused: true}, {id: 'minimized', minimized: true},
], {overviewVisible: true});
overviewChooser.click();
assert.equal(overviewHides, 0);
assert.equal(Main.overview.visible, true, 'an overview chooser remains visible until selection');
assert.deepEqual(overviewChooser.calls, [['preview', 'bottom']]);
overviewChooser.appwell._windowPreviewMenu.select(overviewChooser.windows[1]);
assertSingleActivation(overviewChooser, 'minimized', ['minimized']);
assert.equal(Main.overview.visible, false, 'choosing a preview exits the overview');

for (const position of ['bottom', 'top', 'left', 'right']) {
  const positioned = fixture([{focused: true}, {}], {position});
  positioned.click();
  assert.deepEqual(positioned.calls, [['preview', position]], 'thumbnail popup uses the dock edge');
  assert.equal(positioned.appwell._windowPreviewMenu.side, position);

  const fallback = fixture([{focused: true}, {}], {position, previewOpens: false});
  const pointerCalls = [];
  fallback.appwell._menu = {isOpen: false, _boxPointer: {
    updateArrowSide: side => pointerCalls.push(['side', side]),
    queue_relayout: () => pointerCalls.push(['layout']),
  }};
  fallback.click();
  assert.deepEqual(ids(fallback, 'popup'), [position], 'native fallback also uses the dock edge');
  assert.equal(fallback.appwell._popupMenuSide, position, 'Shell 50 receives the fallback side property');
  assert.equal(fallback.appwell._menu._boxPointer._userArrowSide, position,
    'an existing native pointer retains its requested side after allocation flips');
  assert.deepEqual(pointerCalls, [['side', position], ['layout']]);
}

// The right-click path bypasses our primary-button chooser. Exercise the
// native lazy menu sequence: construct, emit menu-state-changed, then open.
// Its first visible allocation must face away from the selected dock edge.
for (const position of ['bottom', 'top', 'left', 'right']) {
  for (const nativeMenu of ['legacy', 'property']) {
    const contextMenu = fixture([{id: 'window'}], {position, nativeMenu});
    assert.equal(contextMenu.appwell._menu, undefined, 'side setup keeps native menus lazy');
    assert.equal(contextMenu.appwell._popupMenuSide, position,
      'native AppIcons receive their side before they can create a menu');
    contextMenu.click(Clutter.BUTTON_SECONDARY);
    assert.deepEqual(contextMenu.menuOpenSnapshots, [
      {menu: position, arrow: position, requested: position},
    ], `${nativeMenu}, ${position}: right-click opens on the dock-facing physical side immediately`);
    assert.deepEqual(ids(contextMenu, 'native'), [Clutter.BUTTON_SECONDARY],
      'context-menu clicks retain native activation handling');
    assert.deepEqual(ids(contextMenu, 'focus'), [], 'opening a context menu never focuses a window');
    assert.deepEqual(ids(contextMenu, 'restore'), [], 'opening a context menu never restores a window');
    assert.equal(contextMenu.appwell._previewInstances.length, 0,
      'right-click never substitutes a thumbnail chooser');
  }
}

for (const position of ['left', 'right']) {
  const rtlMenu = fixture([{id: 'window'}], {position, nativeMenu: 'property', rtl: true});
  rtlMenu.click(Clutter.BUTTON_SECONDARY);
  assert.deepEqual(rtlMenu.menuOpenSnapshots, [
    {menu: position, arrow: position, requested: position},
  ], `${position}: RTL construction cannot reverse the physical dock side`);
}

for (const nativeMenu of ['legacy', 'property']) {
  const directMenu = fixture([{id: 'window'}], {position: 'bottom', nativeMenu});
  const cachedIcons = directMenu.dock._icons;
  directMenu.dock._position = 'left';
  // Keyboard popup keys and long presses call popupMenu() directly, without
  // going through activate() or a dock redisplay first.
  directMenu.appwell.popupMenu();
  const popup = directMenu.appwell._menu;
  assert.equal(directMenu.dock._icons, cachedIcons, 'direct menu opening uses the existing icon cache');
  assert.deepEqual(directMenu.menuOpenSnapshots, [
    {menu: 'left', arrow: 'left', requested: 'left'},
  ], `${nativeMenu}: pre-open state handles a dock move before lazy menu creation`);
  popup.isOpen = false;
  directMenu.menuCallbacks.get('menu-state-changed')(directMenu.appwell, false);
  directMenu.dock._position = 'right';
  directMenu.appwell.popupMenu();
  assert.equal(directMenu.appwell._menu, popup, 'direct menu opening reuses the lazy popup');
  assert.deepEqual(directMenu.menuOpenSnapshots.at(-1),
    {menu: 'right', arrow: 'right', requested: 'right'},
    `${nativeMenu}: pre-open state handles a dock move without redisplay for an existing menu`);
  assert.deepEqual(ids(directMenu, 'native'), [], 'keyboard/long-press popup never invokes activation');
  assert.deepEqual(ids(directMenu, 'focus'), [], 'direct popup leaves the application window focus alone');
}

const movedMenu = fixture([{id: 'window'}], {position: 'left', nativeMenu: 'legacy'});
movedMenu.click(Clutter.BUTTON_SECONDARY);
const reusedNativeMenu = movedMenu.appwell._menu;
for (const position of ['top', 'right', 'bottom', 'left']) {
  reusedNativeMenu.isOpen = false;
  movedMenu.menuCallbacks.get('menu-state-changed')(movedMenu.appwell, false);
  movedMenu.dock._position = position;
  movedMenu.dock._icons = null;
  movedMenu.dock._findIcons();
  assert.equal(reusedNativeMenu.isOpen, false, 'redisplay does not open a closed native menu');
  assert.equal(movedMenu.appwell._menu, reusedNativeMenu, 'dock moves reuse the owned native menu');
  movedMenu.click(Clutter.BUTTON_SECONDARY);
  assert.deepEqual(movedMenu.menuOpenSnapshots.at(-1),
    {menu: position, arrow: position, requested: position},
    `${position}: a reused menu follows the new dock edge`);
}
reusedNativeMenu.isOpen = false;
const openedBeforeClosingSignal = movedMenu.menuOpenSnapshots.length;
movedMenu.menuCallbacks.get('menu-state-changed')(movedMenu.appwell, false);
assert.equal(reusedNativeMenu.isOpen, false, 'closing notifications never reopen a native menu');
assert.equal(movedMenu.menuOpenSnapshots.length, openedBeforeClosingSignal,
  'closing notifications do not call the native menu open method');

for (const position of ['bottom', 'top', 'left', 'right']) {
  const eagerMenu = fixture([], {custom: true, customMenu: true, position});
  const popup = eagerMenu.icon._menu;
  assert.equal(popup.isOpen, false, 'eager custom menu orientation keeps the popup closed');
  assert.deepEqual([popup._arrowSide, popup._boxPointer._arrowSide,
    popup._boxPointer._userArrowSide], [position, position, position],
  `${position}: eager custom menus are oriented during icon setup`);
  // Custom launchers emit PopupMenu's own state signal, rather than AppIcon's.
  eagerMenu.dock._position = position === 'left' ? 'right' : 'left';
  popup.isOpen = true;
  eagerMenu.menuCallbacks.get('open-state-changed')(popup, true);
  const expectedSide = eagerMenu.dock._position;
  assert.deepEqual([popup._arrowSide, popup._boxPointer._arrowSide,
    popup._boxPointer._userArrowSide], [expectedSide, expectedSide, expectedSide],
  'an already-created custom menu follows the current dock edge on opening');
  popup.isOpen = false;
  eagerMenu.menuCallbacks.get('open-state-changed')(popup, false);
  assert.equal(popup.isOpen, false, 'custom menu closing remains a dismissal');
  assert.deepEqual(eagerMenu.menuOpenSnapshots, [], 'state notifications do not activate or open menus');
  assert.deepEqual(eagerMenu.calls, [], 'orienting custom menus never launches their backing app');
}

for (const options of [{menuMissing: true}, {menuOpens: false}]) {
  const independentPreview = fixture([{focused: true}, {minimized: true}], options);
  independentPreview.click();
  assert.equal(independentPreview.appwell._windowPreviewMenu.isOpen, true,
    'thumbnails do not depend on the native menu opening');
  assert.deepEqual(ids(independentPreview, 'popup'), []);
}
for (const options of [{previewOpens: false}, {previewThrows: true}]) {
  const nativeFallback = fixture([{focused: true}, {minimized: true}], options);
  nativeFallback.click();
  assert.equal(nativeFallback.appwell._menu.isOpen, true,
    'unavailable thumbnails retain the native title-list fallback');
  assert.deepEqual(ids(nativeFallback, 'popup'), ['bottom']);
  assert.deepEqual(ids(nativeFallback, 'native'), [], 'fallback never activates the app group');
  assert.deepEqual(ids(nativeFallback, 'restore'), [], 'fallback does not restore siblings');
  assert.equal(overviewHides, 0, 'an open native fallback also preserves the overview');
}
for (const options of [{menuMissing: true}, {menuOpens: false}]) {
  options.previewOpens = false;
  const unavailableChooser = fixture([{focused: true}, {minimized: true}], options);
  unavailableChooser.click();
  assert.deepEqual(ids(unavailableChooser, 'native'), [], 'unavailable chooser never activates the group');
  assert.deepEqual(ids(unavailableChooser, 'restore'), [], 'unavailable chooser keeps siblings minimized');
  assert.equal(overviewHides, 1, 'without an open chooser ordinary handled activation closes overview');
}

const recent = fixture([
  {id: 'older', time: 10}, {id: 'latest', time: 50}, {id: 'middle', time: 30},
]);
recent.click(0);
assertSingleActivation(recent, 'latest');
assert.deepEqual(recent.windows.map(window => window.id), ['older', 'latest', 'middle'],
  'sorting selection does not mutate the app window list');

const fallbackOrder = fixture([
  {id: 'app-mru', time: 1, noUserTime: true}, {id: 'other', time: 50},
]);
fallbackOrder.appwell.activate();
assertSingleActivation(fallbackOrder, 'app-mru');
const tied = fixture([{id: 'first', time: 10}, {id: 'second', time: 10}]);
tied.click();
assertSingleActivation(tied, 'first');

const filtered = fixture([
  {id: 'other-monitor-active', time: 100, monitor: 1, focused: true},
  {id: 'local', time: 5},
], {filter: 1});
filtered.click();
assertSingleActivation(filtered, 'local');
const filteredSingle = fixture([
  {id: 'other-monitor', time: 100, monitor: 1},
  {id: 'local-active', time: 5, focused: true},
], {filter: 1});
filteredSingle.click();
assert.deepEqual(filteredSingle.calls, [['minimize', 'local-active']],
  'toggle counts windows eligible for this monitor and leaves remote siblings untouched');
const filteredEmpty = fixture([
  {id: 'remote-visible', time: 5, monitor: 1},
  {id: 'remote-minimized', time: 100, monitor: 1, minimized: true},
], {filter: 1});
filteredEmpty.click();
assertSingleActivation(filteredEmpty, 'remote-visible');
assert.equal(filteredEmpty.windows[1].minimized, true,
  'an empty monitor filter never falls through to native group activation');

const workspace = fixture([
  {id: 'remote-workspace', time: 100, workspace: 1},
  {id: 'minimized-local', time: 200, minimized: true},
]);
workspace.click();
assert.deepEqual(workspace.calls, [['workspace', 1, 'remote-workspace', 1234]],
  'a nonminimized window on another workspace is focused without restoring siblings');
assert.equal(activeWorkspace, workspace.workspaces[1]);
assert.equal(overviewHides, 1);

for (const [button, modifiers] of [
  [2, 0], [1, Clutter.ModifierType.CONTROL_MASK],
]) {
  const shortcut = fixture([{id: 'running'}]);
  shortcut.click(button, modifiers);
  assert.equal(ids(shortcut, 'native').length, 1, 'new-window shortcuts retain native handling');
  assert.equal(ids(shortcut, 'new-window').length, 1, 'shortcut opens one new window');
  assert.deepEqual(ids(shortcut, 'focus'), []);
}
for (const [specs, options] of [
  [[], {}], [[{id: 'stopped'}], {state: Shell.AppState.STOPPED}],
  [[{id: 'starting'}], {state: Shell.AppState.STARTING}],
]) {
  const launcher = fixture(specs, options);
  launcher.click();
  assert.equal(ids(launcher, 'native').length, 1, 'stopped and windowless apps retain native launch');
}
const custom = fixture([{id: 'browser', focused: true}], {custom: true});
custom.click();
assert.deepEqual(custom.calls, [['native', 1], ['custom-launch']],
  'a folder/custom launcher runs its action even if its backing app already has windows');
assert.equal(custom.appwell._previewInstances.length, 0, 'custom launchers never construct window previews');
const secondary = fixture([{id: 'window'}]);
secondary.click(Clutter.BUTTON_SECONDARY);
assert.equal(ids(secondary, 'native').length, 1, 'secondary button stays on the native menu path');
assert.deepEqual(ids(secondary, 'focus'), []);
assert.equal(secondary.appwell._previewInstances.length, 0, 'right click preserves the native app menu');

const destroyed = fixture([{id: 'window'}]);
destroyed.dock._destroyed = true;
assert.equal(destroyed.dock._activateAppWindow(destroyed.appwell.app, 1), false,
  'destroyed docks cannot focus a window');
assert.deepEqual(destroyed.calls, []);
destroyed.click();
assert.deepEqual(destroyed.calls, [], 'the actual wrapper ignores activation after dock destruction');
for (const destroyTarget of ['dash', 'icon', 'appwell']) {
  const tearingDown = fixture([{id: 'window'}]);
  (destroyTarget === 'dash' ? tearingDown.dock.dash : tearingDown[destroyTarget])._d2dlDestroying = true;
  tearingDown.click();
  assert.deepEqual(tearingDown.calls, [], `${destroyTarget} teardown cannot activate native or dock windows`);
}

const previewState = fixture([{focused: true}, {minimized: true}]);
previewState.click();
const ownedPreview = previewState.appwell._windowPreviewMenu;
assert.deepEqual(previewState.autohideCalls, ['show', 'check'],
  'opening previews shows the source dock and defers autohide');
assert.equal(previewState.dock._hasOpenMenu(), true);
previewState.dock._icons = null;
assert.equal(previewState.dock._hasOpenMenu(), true,
  'thumbnail menus still protect autohide while the icon list is invalidated');
ownedPreview.close();
assert.deepEqual(previewState.autohideCalls, ['show', 'check', 'check']);
assert.equal(previewState.dock._hasOpenMenu(), false);
previewState.click();
const previewNativeStateChanged = previewState.menuCallbacks.get('menu-state-changed');
previewNativeStateChanged(previewState.appwell, true);
assert.equal(ownedPreview.isOpen, false, 'opening the native context menu dismisses thumbnails');

// Pointer movement through a preview must never select a window. Keep the
// source visually hovered while crossing the small gap, and release the
// chooser immediately when the user returns to another app or leaves.
for (const [position, panelRect, transit, panelPoint, outsideTransit] of [
  ['left', [150, 40, 240, 260], [140, 116], [350, 270], [140, 270]],
  ['right', [-160, 40, 240, 260], [90, 116], [-140, 270], [90, 270]],
  ['top', [40, 150, 260, 240], [116, 140], [270, 350], [270, 140]],
  ['bottom', [40, -160, 260, 240], [116, 90], [270, -140], [270, 90]],
]) {
  const freelyHovered = fixture([{focused: true}, {minimized: true}], {position});
  freelyHovered.click();
  const popup = freelyHovered.appwell._windowPreviewMenu;
  popup.rect = panelRect;
  assert.equal(freelyHovered.dock._getWindowPreviewIcon([116, 116]), freelyHovered.icon,
    `${position}: the source icon remains active while its preview is open`);
  assert.equal(freelyHovered.dock._getWindowPreviewIcon(transit), freelyHovered.icon,
    `${position}: crossing the narrow source-to-preview gap retains zoom`);
  assert.equal(freelyHovered.dock._getWindowPreviewIcon(panelPoint), freelyHovered.icon,
    `${position}: the whole preview keeps its source active, including its distant end`);
  assert.equal(popup.isOpen, true);
  assert.equal(freelyHovered.dock._getWindowPreviewIcon(outsideTransit), null,
    `${position}: a tall or wide preview does not create a broad invisible hover area`);
  assert.equal(popup.isOpen, false, `${position}: leaving dismisses the preview without a choice`);
  assert.equal(freelyHovered.dock._activeWindowPreview == null, true,
    `${position}: dismissal releases preview ownership`);
  assert.deepEqual(freelyHovered.calls, [['preview', position]],
    `${position}: checking and dismissing previews never activates or minimizes a window`);
}

const switchApp = fixture([{focused: true}, {minimized: true}], {position: 'left'});
switchApp.click();
const sourcePopup = switchApp.appwell._windowPreviewMenu;
const otherAppIcon = {visible: true, _icon: {},
  _inputRect: [100, 164, 32, 32],
  get_transformed_position: () => [100, 164], get_transformed_size: () => [32, 32]};
switchApp.dock._icons.push(otherAppIcon);
// Deliberately overlap the panel rectangle to ensure the real icon wins.
sourcePopup.rect = [100, 90, 260, 180];
assert.equal(switchApp.dock._getWindowPreviewIcon([116, 180]), null,
  'hovering another app dismisses previews even when their rectangles overlap');
assert.equal(sourcePopup.isOpen, false, 'another app is accessible without choosing a window');
assert.deepEqual(switchApp.calls, [['preview', 'left']], 'switching icons does not activate a preview');

for (const direction of Object.values(Clutter.ScrollDirection)) {
  const immediateScroll = fixture([{focused: true}, {minimized: true}], {position: 'left'});
  immediateScroll.click();
  const oldPreview = immediateScroll.appwell._windowPreviewMenu;
  const nextApp = {get_windows: () => []};
  const nextIcon = {_icon: {}, _appwell: {app: nextApp}, _inputRect: [100, 164, 32, 32]};
  immediateScroll.dock._icons.push(nextIcon);
  // No animation or motion frame has updated the retained preview hover yet.
  immediateScroll.dock._nearestIcon = immediateScroll.icon;
  pointer = [116, 180];
  const cycles = [];
  immediateScroll.dock._cycleWindows = (app, event) => cycles.push({app, event});
  const event = {get_scroll_direction: () => direction};
  immediateScroll.dock._onScrollEvent(null, event);
  assert.deepEqual(cycles, [{app: nextApp, event}],
    'the first wheel event over another icon cycles the actual app under the pointer');
  assert.equal(immediateScroll.dock._lastScrollObject, nextIcon,
    'wheel ownership immediately follows the real pointer before an animation frame');
  assert.equal(oldPreview.isOpen, false, 'scrolling another app dismisses the previous preview');
  assert.equal(immediateScroll.dock._activeWindowPreview == null, true,
    'scrolling another app releases retained preview ownership');
  assert.deepEqual(immediateScroll.calls, [['preview', 'left']],
    'switching the wheel target does not select or restore a previous preview window');
}

const keyboardPreview = fixture([{focused: true}, {minimized: true}]);
pointer = [-200, -200];
keyboardPreview.click(0);
assert.equal(keyboardPreview.dock._getWindowPreviewIcon(pointer), keyboardPreview.icon,
  'keyboard opening retains source hover until the real pointer moves');
assert.equal(keyboardPreview.dock._getWindowPreviewIcon([-250, -200]), null,
  'actual pointer departure can dismiss a keyboard-opened preview without selection');
assert.deepEqual(keyboardPreview.calls, [['preview', 'bottom']]);

for (const unavailable of ['hidden', 'fullscreen', 'dragging', 'disabled', 'destroyed', 'source-destroying']) {
  const pending = fixture([{focused: true}, {minimized: true}]);
  pending.click();
  const popup = pending.appwell._windowPreviewMenu;
  if (unavailable === 'hidden') pending.dock._hidden = true;
  if (unavailable === 'fullscreen') pending.dock._monitor.inFullscreen = true;
  if (unavailable === 'dragging') pending.dock._dragging = true;
  if (unavailable === 'disabled') pending.dock.extension.animate_icons_unmute = false;
  if (unavailable === 'destroyed') pending.dock._destroyed = true;
  if (unavailable === 'source-destroying') pending.icon._d2dlDestroying = true;
  assert.equal(pending.dock._getWindowPreviewIcon([116, 116]), null,
    `${unavailable}: preview ownership cannot keep an unavailable source active`);
  if (unavailable === 'disabled') {
    assert.equal(popup.isOpen, true, 'disabling zoom keeps the nonmodal chooser usable');
    popup.close();
  }
  assert.equal(pending.dock._activeWindowPreview == null, true,
    `${unavailable}: dismissed preview ownership is released`);
  assert.equal(popup.isOpen, false, `${unavailable}: preview closes without a selection`);
  assert.deepEqual(pending.calls, [['preview', 'bottom']]);
}

const previewWake = fixture([{focused: true}, {minimized: true}]);
previewWake.click();
assert.equal(previewWake.animationWakes.length, 1, 'opening previews wakes the source zoom');
previewWake.appwell._windowPreviewMenu.close();
assert.equal(previewWake.animationWakes.length, 2, 'closing previews wakes normal hover settling');
assert.equal(previewWake.dock._activeWindowPreview == null, true,
  'ordinary dismissal clears the active preview owner');

const idlePreview = fixture([{focused: true}, {minimized: true}]);
idlePreview.click();
idlePreview.icon._scale = 2;
idlePreview.icon._targetScale = 2;
const idleWatchStates = [];
let idleSettles = 0;
idlePreview.dock._syncPointerWatch = active => idleWatchStates.push(active);
idlePreview.dock._settleAnimation = () => idleSettles++;
idlePreview.dock._endAnimation();
assert.equal(idleSettles, 1, 'animation timeout suspends a held preview without leaving frame work running');
assert.equal(idlePreview.icon._scale, 2, 'animation timeout does not shrink the preview source');
assert.equal(idlePreview.icon._targetScale, 2, 'animation timeout keeps the preview hover target');
assert.deepEqual(idleWatchStates, [], 'preview timeout retains pointer recovery for its next movement');
assert.equal(idlePreview.dock._icons.includes(idlePreview.icon), true,
  'preview timeout keeps the active icon cache available for direct switching');

const detachedWindow = fixture([{id: 'active', focused: true}, {id: 'gone', minimized: true}]);
detachedWindow.click();
const gone = detachedWindow.windows.pop();
detachedWindow.appwell._windowPreviewMenu.select(gone);
assert.deepEqual(ids(detachedWindow, 'restore'), [], 'a window removed after preview opening is not restored');
assert.deepEqual(ids(detachedWindow, 'focus'), [], 'a stale preview cannot focus a departed window');
assert.equal(overviewHides, 0, 'a stale preview leaves the current overview alone');

for (const destroyTarget of ['dock', 'dash', 'appwell']) {
  const stalePreview = fixture([{focused: true}, {minimized: true}]);
  stalePreview.click();
  const popup = stalePreview.appwell._windowPreviewMenu;
  if (destroyTarget === 'dock') stalePreview.dock._destroyed = true;
  else (destroyTarget === 'dash' ? stalePreview.dock.dash : stalePreview.appwell)._d2dlDestroying = true;
  popup.options.onActivate(stalePreview.windows[1]);
  assert.deepEqual(ids(stalePreview, 'restore'), [], `${destroyTarget} teardown ignores pending preview selection`);
  assert.deepEqual(ids(stalePreview, 'focus'), []);
  const previousAutohide = [...stalePreview.autohideCalls];
  popup.options.onOpenStateChanged(true);
  assert.deepEqual(stalePreview.autohideCalls, previousAutohide,
    `${destroyTarget} teardown ignores pending preview state changes`);
}

const cleanupPreview = fixture([{focused: true}, {minimized: true}]);
cleanupPreview.click();
const removedPopup = cleanupPreview.appwell._windowPreviewMenu;
cleanupPreview.dock._cleanupIcon(cleanupPreview.icon);
assert.equal(removedPopup.destroyed, true, 'icon cleanup destroys its owned thumbnail popup');
assert.equal(cleanupPreview.appwell._windowPreviewMenu, null, 'icon cleanup clears popup ownership');
assert.equal(cleanupPreview.dock._hasOpenMenu(), false);
assert.equal(cleanupPreview.dock._activeWindowPreview == null, true,
  'icon cleanup releases the active preview owner even after removing its menu reference');
const cleanupAutohide = [...cleanupPreview.autohideCalls];
removedPopup.options.onActivate(cleanupPreview.windows[1]);
removedPopup.options.onOpenStateChanged(true);
assert.deepEqual(ids(cleanupPreview, 'restore'), [], 'destroyed popup callbacks cannot restore a window');
assert.deepEqual(ids(cleanupPreview, 'focus'), []);
assert.deepEqual(cleanupPreview.autohideCalls, cleanupAutohide,
  'destroyed popup callbacks cannot revive dock autohide activity');

const menuState = fixture([{focused: true}, {}]);
const nativeStateChanged = menuState.menuCallbacks.get('menu-state-changed');
assert.equal(typeof nativeStateChanged, 'function', 'native lazy menus have one state listener');
nativeStateChanged(menuState.appwell, true);
assert.deepEqual(menuState.autohideCalls, ['show', 'check'], 'menu opening shows the source immediately');
menuState.appwell._menu = {isOpen: true};
assert.equal(menuState.dock._hasOpenMenu(), true);
menuState.dock._icons = null;
assert.equal(menuState.dock._hasOpenMenu(), true, 'redisplay invalidation retains native menu protection');
menuState.appwell._menu.isOpen = false;
nativeStateChanged(menuState.appwell, false);
assert.deepEqual(menuState.autohideCalls, ['show', 'check', 'check'], 'menu closing schedules normal autohide');
assert.equal(menuState.dock._hasOpenMenu(), false);
menuState.dock._destroyed = true;
nativeStateChanged(menuState.appwell, true);
assert.deepEqual(menuState.autohideCalls, ['show', 'check', 'check'], 'stale menu signals cannot wake a destroyed dock');
assert.equal(menuState.dock._hasOpenMenu(), false);

const customMenu = fixture([], {custom: true, customMenu: true});
const customStateChanged = customMenu.menuCallbacks.get('open-state-changed');
assert.equal(typeof customStateChanged, 'function', 'custom menus use their own popup state signal');
customMenu.icon._menu.isOpen = true;
assert.equal(customMenu.dock._hasOpenMenu(), true);
customStateChanged(customMenu.icon._menu, true);
assert.deepEqual(customMenu.autohideCalls, ['show', 'check']);
customMenu.dock._icons = null;
customMenu.dock.dash._box.get_children = () => [];
customMenu.dock._extraIcons = {get_children: () => [customMenu.icon]};
assert.equal(customMenu.dock._hasOpenMenu(), true, 'custom extra menus survive icon list invalidation');
customMenu.icon._d2dlDestroying = true;
assert.equal(customMenu.dock._hasOpenMenu(), false, 'destroying items no longer pin autohide');

const cycle = fixture([
  {id: 'last', cycleId: 1, minimized: true},
  {id: 'next', cycleId: 2, minimized: true},
  {id: 'active', cycleId: 3, focused: true},
]);
assert.equal(cycle.scroll(), true);
assert.deepEqual(ids(cycle, 'restore'), ['next'], 'scroll restores only the selected next window');
assert.deepEqual(ids(cycle, 'raise'), ['next']);
assert.deepEqual(ids(cycle, 'focus'), ['next']);
assert.deepEqual(ids(cycle, 'activate'), ['next'], 'scroll selects through native window activation');
assert.deepEqual(ids(cycle, 'native'), []);
assert.deepEqual(cycle.windows.map(window => window.id), ['last', 'next', 'active'],
  'cycle sorting never changes the application window array');
assert.equal(cycle.windows[0].minimized, true);
assert.equal(cycle.dock._scrollCounter, 0);
const cycleCalls = [...cycle.calls];
assert.equal(cycle.scroll(-2), false, 'cooldown suppresses another selection');
assert.equal(cycle.dock._scrollCounter, 0, 'cooldown discards accumulated steps');
assert.deepEqual(cycle.calls, cycleCalls, 'cooldown has no window side effects');
cycle.dock._lockedCycle = false;
cycle.calls.length = 0;
assert.equal(cycle.scroll(-2), true);
assert.deepEqual(ids(cycle, 'focus'), ['active'], 'negative scrolling moves in the opposite direction');
assert.deepEqual(ids(cycle, 'restore'), []);

const desktopCycle = fixture([
  {id: 'stale-focus', cycleId: 2, focused: true},
  {id: 'older', cycleId: 1},
], {showDesktop: true});
desktopCycle.scroll();
assert.deepEqual(ids(desktopCycle, 'activate'), ['stale-focus'],
  'scrolling from Show Desktop selects as an inactive app instead of cycling from stale focus');
assert.equal(desktopCycle.isShowingDesktop(), false);
assert.equal(desktopCycle.windows[1].minimized, true);

const wrappingCycle = fixture([
  {id: 'start', cycleId: 1, focused: true},
  {id: 'end', cycleId: 2, minimized: true},
]);
wrappingCycle.scroll();
assert.deepEqual(ids(wrappingCycle, 'focus'), ['end'], 'cycling wraps at the last window');
assert.deepEqual(ids(wrappingCycle, 'restore'), ['end']);

for (const [amount, target] of [[2, 'newest-id'], [-2, 'oldest-id']]) {
  const unfocusedCycle = fixture([
    {id: 'oldest-id', cycleId: 1, minimized: true},
    {id: 'newest-id', cycleId: 2, minimized: true},
  ]);
  unfocusedCycle.scroll(amount);
  assert.deepEqual(ids(unfocusedCycle, 'restore'), [target], 'scrolling an inactive app restores one window');
  assert.deepEqual(ids(unfocusedCycle, 'focus'), [target]);
}
for (const specs of [[{minimized: true}], [{minimized: true}, {minimized: true}]]) {
  const smallScroll = fixture(specs);
  assert.equal(smallScroll.scroll(0.5), false);
  assert.equal(smallScroll.scroll(-1), false);
  assert.deepEqual(smallScroll.calls, [], 'subthreshold scroll never restores hidden siblings or grabs focus');
}
const singleScroll = fixture([{id: 'single', minimized: true}]);
singleScroll.scroll();
assert.deepEqual(ids(singleScroll, 'restore'), ['single']);
assert.deepEqual(ids(singleScroll, 'raise'), ['single'], 'single-window scroll raises once');

const workspaceCycle = fixture([
  {id: 'other-workspace', cycleId: 2, workspace: 1},
  {id: 'minimized-local', cycleId: 1, minimized: true},
]);
workspaceCycle.scroll();
assert.deepEqual(ids(workspaceCycle, 'restore'), [], 'workspace-hidden window is not treated as minimized');
assert.deepEqual(workspaceCycle.calls, [['lock'], ['workspace', 1, 'other-workspace', 1234]]);
assert.equal(workspaceCycle.windows[1].minimized, true);

const ctrlCycle = fixture([
  {id: 'remote', cycleId: 3, workspace: 1, minimized: true},
  {id: 'local-target', cycleId: 2, minimized: true},
  {id: 'local-active', cycleId: 1, focused: true},
]);
ctrlCycle.scroll(2, Clutter.ModifierType.CONTROL_MASK);
assert.deepEqual(ids(ctrlCycle, 'restore'), ['local-target'], 'Ctrl-scroll cycles only the active workspace');
assert.equal(ctrlCycle.windows[0].minimized, true);

const monitorCycle = fixture([
  {id: 'remote', cycleId: 3, monitor: 1, minimized: true},
  {id: 'local', cycleId: 2, minimized: true},
], {filter: 1});
monitorCycle.scroll();
assert.deepEqual(ids(monitorCycle, 'restore'), ['local'], 'scroll respects monitor filtering');
const emptyCycle = fixture([{monitor: 1, minimized: true}], {filter: 1});
assert.equal(emptyCycle.scroll(), false);
assert.deepEqual(emptyCycle.calls, [], 'empty monitor selection does not fall through to another monitor');
assert.equal(emptyCycle.dock._scrollCounter, 0);

const destroyedCycle = fixture([{minimized: true}]);
destroyedCycle.dock._destroyed = true;
assert.equal(destroyedCycle.scroll(), false);
assert.deepEqual(destroyedCycle.calls, [], 'destroyed docks cannot cycle or restore windows');
const destroyingCycle = fixture([{minimized: true}]);
destroyingCycle.dock.dash._d2dlDestroying = true;
assert.equal(destroyingCycle.scroll(), false);
assert.deepEqual(destroyingCycle.calls, [], 'dash teardown cannot cycle or restore windows');

console.log('Window activation regressions passed (toggle, thumbnail selection, native context-menu edges, popup ownership, autohide signals, overview, Show Desktop, MRU, filtered single-window cycling, teardown, native shortcuts)');
