import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../dock.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm, '')
  .replace(/^export /gm, '');
const Shell = {AppState: {STOPPED: 0, STARTING: 1, RUNNING: 2}};
const Clutter = {
  BUTTON_PRIMARY: 1, BUTTON_MIDDLE: 2, BUTTON_SECONDARY: 3,
  ModifierType: {CONTROL_MASK: 1 << 2, SHIFT_MASK: 1, BUTTON2_MASK: 1 << 9},
  get_current_event: () => currentEvent,
};
let currentEvent = null;
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
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.options.onOpenStateChanged(false);
  }
  destroy() { this.close(); this.destroyed = true; }
  select(window) { this.close(); this.options.onActivate(window); }
}
const dependencies = {
  Main, Shell, Clutter, WindowPreviewMenu, DashModule: {Dash: class {}},
  GObject: {registerClass: (...args) => args.at(-1)},
  St: {Widget: class {}, Side: {BOTTOM: 'bottom', TOP: 'top', LEFT: 'left', RIGHT: 'right'}},
  Config: {PACKAGE_VERSION: '48'},
  Graphene: {Point: class {}},
  global: {
    workspace_manager: {get_active_workspace: () => activeWorkspace},
    get_current_time: () => 1234,
  },
};
const Dock = new Function(...Object.keys(dependencies), `${source}\nreturn Dock;`)(
  ...Object.values(dependencies));

// Exercise _findIcons' actual installed activate wrapper, not just selection.
// The native fallback deliberately has group effects, as Shell.App.activate()
// can: a regular click must never reach it after our single-window activation.
function fixture(specs, options = {}) {
  currentEvent = null;
  overviewHides = 0;
  Main.overview.visible = options.overviewVisible ?? false;
  const calls = [];
  const menuCallbacks = new Map();
  const autohideCalls = [];
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
    connectObject(signal, callback) { menuCallbacks.set(signal, callback); },
    popupMenu(side) {
      calls.push(['popup', side]);
      this._menu ??= {isOpen: false};
      this._menu.isOpen = options.menuOpens !== false;
      // This is Shell's real return contract, including a successful open.
      return false;
    },
    activate(button) {
      assert.equal(this, appwell, 'native activation retains the button receiver');
      calls.push(['native', button]);
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
  const icon = {_icon: {}, _appwell: appwell, child: appwell, custom_icon: options.custom};
  if (options.customMenu) {
    icon._menu = {isOpen: false,
      connectObject(signal, callback) { menuCallbacks.set(signal, callback); }};
  }
  const dock = Object.create(Dock.prototype);
  Object.assign(dock, {
    extension: {multi_monitor_filter: options.filter ?? 0, multi_monitor_preference: 1},
    _monitor: {index: 0},
    _position: options.position ?? 'bottom',
    _scrollCounter: 0,
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
    dock, windows, calls, appwell, workspaces, icon, menuCallbacks, autohideCalls,
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

console.log('Window activation regressions passed (toggle, thumbnail selection, popup ownership, autohide signals, overview, Show Desktop, MRU, filtered single-window cycling, teardown, native shortcuts)');
