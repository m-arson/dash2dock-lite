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
  overview: {hide: () => overviewHides++},
};
const dependencies = {
  Main, Shell, Clutter, DashModule: {Dash: class {}},
  GObject: {registerClass: (...args) => args.at(-1)},
  St: {Widget: class {}}, Config: {PACKAGE_VERSION: '48'},
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
  const calls = [];
  const windows = [];
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
      workspace: 0, time: index, ...spec,
      has_focus() { return this.focused; },
      get_monitor() { return this.monitor; },
      get_workspace() { return workspaces[this.workspace]; },
      get_user_time() { return this.time; },
      is_hidden() { return this.minimized || this.get_workspace() !== activeWorkspace; },
      unminimize() { calls.push(['restore', this.id]); this.minimized = false; },
      minimize() { calls.push(['minimize', this.id]); this.minimized = true; },
      maximize() { calls.push(['maximize', this.id]); },
      unmaximize() { calls.push(['unmaximize', this.id]); },
      raise() { calls.push(['raise', this.id]); },
      focus(time) { calls.push(['focus', this.id, time]); focus(this); },
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
  const icon = {_icon: {}, _appwell: appwell, custom_icon: options.custom};
  const dock = Object.create(Dock.prototype);
  Object.assign(dock, {
    extension: {multi_monitor_filter: options.filter ?? 0, multi_monitor_preference: 1},
    _monitor: {index: 0},
    dash: {_box: {get_children: () => [icon]}},
    _inspectIcon(item) { this._icons.push(item); this._dashItems.push(item); },
    _maybeBounce() {},
    _runDeferredAction() { assert.fail('app click must not queue group mutations'); },
  });
  dock._findIcons();
  return {
    dock, windows, calls, appwell, workspaces,
    click(button = Clutter.BUTTON_PRIMARY, modifiers = 0) {
      currentEvent = modifiers ? {get_state: () => modifiers} : null;
      appwell.activate(button);
    },
  };
}
function ids(fixture, action) {
  return fixture.calls.filter(call => call[0] === action).map(call => call[1]);
}
function assertSingleActivation(fixture, id, restored = []) {
  assert.deepEqual(ids(fixture, 'native'), [], 'normal click never activates the app group');
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
focused.click(1, Clutter.ModifierType.SHIFT_MASK);
assert.deepEqual(focused.calls, [], 'repeated or Shift clicks neither minimize nor maximize an active app');
assert.equal(overviewHides, 2, 'already-focused activation still dismisses the overview');

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
const secondary = fixture([{id: 'window'}]);
secondary.click(Clutter.BUTTON_SECONDARY);
assert.equal(ids(secondary, 'native').length, 1, 'secondary button stays on the native menu path');
assert.deepEqual(ids(secondary, 'focus'), []);

const destroyed = fixture([{id: 'window'}]);
destroyed.dock._destroyed = true;
assert.equal(destroyed.dock._activateAppWindow(destroyed.appwell.app, 1), false,
  'destroyed docks cannot focus a window');
assert.deepEqual(destroyed.calls, []);

console.log('Window activation regressions passed (single-window focus/restore, MRU, filters, workspace, native shortcuts)');
