import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

function load(path, name, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?;\s*$/gm, '')
    .replace(/^export default /gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(dependencies), `${source}\nreturn ${name};`)(
    ...Object.values(dependencies));
}

const PrefKeys = load('preferences/prefKeys.js', 'PrefKeys', {Gdk: {}, GLib: {}});
const SettingsKeys = load('preferences/keys.js', 'SettingsKeys', {PrefKeys});
class Settings {
  constructor() {
    this.values = Object.fromEntries(Object.entries(SettingsKeys()._keys)
      .map(([key, value]) => [key, value.default_value]));
    this.listeners = new Map();
  }
  connect(signal, callback) {
    const id = this.listeners.size + 1;
    this.listeners.set(id, {signal, callback});
    return id;
  }
  connectObject() {}
  get_boolean(key) { return this.values[key]; }
  get_int(key) { return this.values[key]; }
  get_double(key) { return this.values[key]; }
  get_string(key) { return this.values[key]; }
  get_value(key) { return {deepUnpack: () => this.values[key]}; }
  change(key, value) {
    this.values[key] = value;
    for (const listener of this.listeners.values()) {
      if (listener.signal === `changed::${key}`) listener.callback();
    }
  }
}

const dependencies = {
  Extension: class {}, SettingsKeys, schemaId: 'test', Gio: {Settings},
  Main: {sessionMode: {isLocked: false, isGreeter: false}},
};
const Extension = load('extension.js', 'Dash2DockLiteExt', dependencies);
const extension = new Extension();
const settings = new Settings();
const events = [];
let wakes = 0;
let layouts = 0;
let labelVisible = true;
let cancelledLabelTransitions = 0;
const icon = {
  _label: {
    hide() { labelVisible = false; },
    remove_all_transitions() { cancelledLabelTransitions++; },
  },
  showLabel() { labelVisible = true; },
};
const dock = {
  _icons: [icon], _nearestIcon: icon,
  layout() { layouts++; this._icons = [icon]; },
  _beginAnimation() { wakes++; events.push('wake'); },
  cancelAnimations() { events.push('cancel'); },
};
Object.assign(extension, {
  _enabled: true, docks: [dock], getSettings: () => settings,
  _hiTimer: {
    shutdown() { events.push('shutdown'); },
    initialize(interval) { events.push(['initialize', interval]); },
  },
});
extension._enableSettings();

for (const [key, value] of [
  ['animate-icons-unmute', false],
  ['overview-transparent-background', true],
  ['overview-transparent-topbar-background', true],
  ['multi-monitor-filter', 1],
  ['downloads-icon-rotate-labels', true],
]) {
  const previous = wakes;
  settings.change(key, value);
  assert.equal(wakes, previous + 1, `${key} wakes a settled dock exactly once`);
}
assert.equal(layouts, 1, 'muting animation refreshes cached button interactivity');
let previous = wakes;
settings.change('hide-labels', true);
assert.equal(labelVisible, false, 'hiding a visible tooltip takes effect without pointer motion');
assert.equal(cancelledLabelTransitions, 1, 'a pending tooltip fade cannot undo hidden labels');
assert.equal(wakes, previous + 1);
previous = wakes;
settings.change('hide-labels', false);
assert.equal(labelVisible, true, 'unhiding the hovered tooltip takes effect without a new enter event');
assert.equal(wakes, previous + 1);

let clockRepaints = 0;
let calendarRepaints = 0;
dock._clock = {redraw() { clockRepaints++; }};
dock._calendar = {redraw() { calendarRepaints++; }};
for (const [key, field] of [
  ['drawing-dark-color', 'dark_color'], ['drawing-light-color', 'light_color'],
  ['drawing-accent-color', 'accent_color'], ['drawing-secondary-color', 'secondary_color'],
  ['drawing-dark-foreground', 'dark_foreground'],
  ['drawing-light-foreground', 'light_foreground'],
]) {
  const color = [0.1, 0.2, 0.3, 0.4];
  previous = wakes;
  settings.change(key, color);
  assert.deepEqual(dock._clock.settings[field], color);
  assert.equal(dock._calendar.settings, dock._clock.settings);
  assert.equal(wakes, previous + 1, 'widget style refresh wakes the dock only once');
}
assert.equal(clockRepaints, 6);
assert.equal(calendarRepaints, 6);

events.length = 0;
settings.change('animation-fps', 2);
assert.deepEqual(events, ['cancel', 'shutdown', ['initialize', 45], 'wake'],
  'FPS changes restart animation after replacing the timer');
let downloadsSetups = 0;
let schedulerUpdates = 0;
extension.services = {setupDownloads() { downloadsSetups++; }};
extension._syncServiceTimer = () => schedulerUpdates++;
settings.change('downloads-path', '/new/downloads');
assert.equal(downloadsSetups, 1);
assert.equal(schedulerUpdates, 1, 'folder changes refresh polling fallback deadlines');

const early = new Extension();
early._enabled = true;
assert.doesNotThrow(() => {
  early.animate();
  early._updateWidgetStyle();
  early._updateAnimationFPS();
}, 'startup before dock creation can refresh visual settings safely');

let resolveConfig;
let iconsConfig = null;
const ConfigExtension = load('extension.js', 'Dash2DockLiteExt', {
  ...dependencies,
  configFile: name => ({name,
    query_exists: () => name === 'config.json' || (name === 'icons.json' && iconsConfig !== null)}),
  loadFile: file => file.name === 'icons.json'
    ? Promise.resolve(iconsConfig)
    : new Promise(resolve => { resolveConfig = resolve; }),
});
const configured = new ConfigExtension();
let configWakes = 0;
let configLayouts = 0;
Object.assign(configured, {
  _enabled: true, _lifecycleId: 1,
  docks: [{layout() { configLayouts++; }, _beginAnimation() { configWakes++; }}],
});
const loading = configured._loadConfig();
resolveConfig('{"icon-size":48}');
await loading;
assert.equal(configured._config.icon_size, 48);
assert.equal(configLayouts, 1);
assert.equal(configWakes, 1, 'late configuration wakes and refreshes an already-settled dock');

let recreations = 0;
const configuredDock = configured.docks[0];
const oldLauncher = configuredDock.launcher = {opener: 'files-old'};
configuredDock.recreateDash = function () {
  recreations++;
  this.launcher = {opener: configured._config['file-explorer']};
};
configuredDock._debounceEndAnimation = () => {};
configured._config = {'file-explorer': 'files-old'};
const changedOpener = configured._loadConfig();
resolveConfig('{"file-explorer":"files-new"}');
await changedOpener;
assert.equal(recreations, 1);
assert.notEqual(configuredDock.launcher, oldLauncher,
  'late opener changes replace actors holding obsolete DesktopAppInfo objects');
assert.equal(configuredDock.launcher.opener, 'files-new');

const currentLauncher = configuredDock.launcher;
iconsConfig = '{"icons":{"app":"new-app-icon"}}';
const changedIcons = configured._loadConfig();
resolveConfig('{"file-explorer":"files-new"}');
await changedIcons;
assert.equal(configured.icon_map.app, 'new-app-icon');
assert.equal(recreations, 1, 'icon mapping changes do not recreate launcher actors');
assert.equal(configuredDock.launcher, currentLauncher);

const malformedOpener = configured._loadConfig();
resolveConfig('{"file-explorer":{"invalid":"command"}}');
await malformedOpener;
assert.equal(configured._config['file-explorer'], undefined,
  'invalid command types cannot reach native launcher setup');
assert.equal(recreations, 1, 'malformed opener configuration does not recreate dashes');
const malformedConfig = configured._loadConfig();
resolveConfig('[]');
await malformedConfig;
assert.equal(recreations, 1, 'invalid top-level configuration does not recreate dashes');

const wakesBeforeLock = configWakes;
const lockedLoading = configured._loadConfig();
dependencies.Main.sessionMode.isLocked = true;
resolveConfig('{"file-explorer":"files-locked"}');
await lockedLoading;
assert.equal(configWakes, wakesBeforeLock, 'configuration completion cannot wake a locked session');
assert.equal(recreations, 1, 'configuration completion cannot recreate dashes while locked');
dependencies.Main.sessionMode.isLocked = false;

const wakesBeforeDisable = configWakes;
const obsolete = configured._loadConfig();
configured._enabled = false;
configured._lifecycleId++;
resolveConfig('{"file-explorer":"files-obsolete"}');
await obsolete;
assert.equal(configWakes, wakesBeforeDisable, 'obsolete configuration completion cannot restart animation');
assert.equal(recreations, 1, 'obsolete configuration completion cannot recreate launcher actors');

console.log('Live settings regressions passed');
