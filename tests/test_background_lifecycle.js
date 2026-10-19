// Run with: gjs -m tests/test_background_lifecycle.js
// Shell UI imports are replaced with small fakes; Gio I/O below is real.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function readSource(name) {
  const file = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child(name);
  const [, bytes] = file.load_contents(null);
  return new TextDecoder().decode(bytes).replace(/^import[\s\S]*?;\n/gm, '');
}

function loadClass(name, declaration, parameters) {
  const source = readSource(name).replace('export default class ', 'class ').replace('export const ', 'const ');
  return new Function(...Object.keys(parameters), `${source}\nreturn ${declaration};`)(...Object.values(parameters));
}

const Main = {
  layoutManager: { monitors: [{ index: 0, x: 0, y: 0 }, { index: 1, x: 100, y: 0 }], primaryIndex: 0 },
  sessionMode: { isLocked: false, isGreeter: false },
  messageTray: { getSources: () => [] },
};
const Services = loadClass('services.js', 'Services', { Gio, GLib, Main });

class SignalSource {
  constructor() { this.listeners = []; }
  connectObject(...args) {
    const owner = args.pop();
    for (let index = 0; index < args.length; index += 2)
      this.listeners.push({ name: args[index], callback: args[index + 1], owner });
  }
  disconnectObject(owner) {
    this.listeners = this.listeners.filter((listener) => listener.owner !== owner);
  }
  emit(name, ...args) {
    for (const listener of [...this.listeners])
      if (listener.name === name) listener.callback(this, ...args);
  }
}

const directoryPath = GLib.dir_make_tmp('d2da-background-tests-XXXXXX');
const directory = Gio.File.new_for_path(directoryPath);
try {
  for (let index = 0; index < 200; index++) {
    const file = directory.get_child(`file-${String(index).padStart(3, '0')}`);
    file.replace_contents('test', null, false, Gio.FileCreateFlags.NONE, null);
    file.set_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED, 1000 + index, Gio.FileQueryInfoFlags.NONE, null);
  }
  const services = new Services();
  services.extension = { max_recent_items: 0, lookup_icon_from_names: (names) => names[0] ?? null };
  let idleIterations = 0;
  const idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    idleIterations++;
    return GLib.SOURCE_CONTINUE;
  });
  let files, count;
  try {
    [files, count] = await services.checkRecentFilesInFolder(directoryPath);
  } finally {
    GLib.source_remove(idle);
  }
  assert(count === 200 && files.length === 5, 'listing must count every file while retaining only the requested newest files');
  assert(files[0].name === 'file-199' && files[4].name === 'file-195', 'newest files must be sorted correctly');
  assert(idleIterations > 1, 'directory enumeration must yield to the Shell main loop');
  const cancelled = new Gio.Cancellable();
  cancelled.cancel();
  let rejected = false;
  try { await services.checkRecentFilesInFolder(directoryPath, cancelled); }
  catch (error) { rejected = true; }
  assert(rejected, 'cancelled I/O must not return stale data');
  print('PASS real Gio directory scans yield, sort, bound memory, and cancel');

  let attributes;
  const queried = [];
  const MetadataServices = loadClass('services.js', 'Services', {
    Gio: {
      FileQueryInfoFlags: Gio.FileQueryInfoFlags,
      FILE_ATTRIBUTE_STANDARD_NAME: Gio.FILE_ATTRIBUTE_STANDARD_NAME,
      FILE_ATTRIBUTE_TIME_MODIFIED: Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
      FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE: Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
      FILE_ATTRIBUTE_STANDARD_ICON: Gio.FILE_ATTRIBUTE_STANDARD_ICON,
      File: { new_for_path: (path) => {
      const real = Gio.File.new_for_path(path);
      return {
        enumerate_children_async(requested, ...args) {
          attributes = requested;
          real.enumerate_children_async(requested, ...args);
        },
        get_child(name) {
          const child = real.get_child(name);
          return { query_info_async(...args) {
            queried.push(name);
            child.query_info_async(...args);
          } };
        },
      };
    } } }, GLib, Main,
  });
  const metadataServices = new MetadataServices();
  metadataServices.extension = services.extension;
  const [metadataFiles, metadataCount] = await metadataServices.checkRecentFilesInFolder(directoryPath);
  assert(metadataCount === 200 && metadataFiles.length === 5 && queried.length === 5 &&
    queried.every((name, index) => name === metadataFiles[index].name),
    'expensive metadata queries must be bounded by displayed rows, not folder size');
  assert(!attributes.includes(Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE) &&
    !attributes.includes(Gio.FILE_ATTRIBUTE_STANDARD_ICON),
    'full directory enumeration must only request cheap sorting metadata');
  print('PASS rich Downloads metadata is fetched only for the retained newest rows');
} finally {
  const enumerator = directory.enumerate_children(Gio.FILE_ATTRIBUTE_STANDARD_NAME, Gio.FileQueryInfoFlags.NONE, null);
  let info;
  while ((info = enumerator.next_file(null))) directory.get_child(info.get_name()).delete(null);
  enumerator.close(null);
  directory.delete(null);
}

{
  const services = new Services();
  services._enabled = true;
  services._generation = 1;
  services._downloadsDir = { get_path: () => '/tmp' };
  let animations = 0;
  services.extension = { downloads_icon: true, animate: () => animations++ };
  const pending = [];
  let onScan;
  const nextScan = () => new Promise((resolve) => { onScan = resolve; });
  services.checkRecentFilesInFolder = (path, cancellable) => new Promise((resolve) => {
    const scan = { resolve, cancellable };
    pending.push(scan);
    onScan(scan);
  });
  let ready = nextScan();
  const first = services.checkDownloads();
  const original = await ready;
  for (let event = 0; event < 100; event++) services._debounceCheckDownloads();
  await services.checkDownloads();
  assert(pending.length === 1 && !original.cancellable.is_cancelled(),
    'file event storms must coalesce without cancelling or restarting the active scan');
  ready = nextScan();
  const old = { path: '/tmp/old', date: { tv_sec: 1 }, icon: 'file', type: 'text/plain' };
  const fresh = { path: '/tmp/new', date: { tv_sec: 2 }, icon: 'file', type: 'text/plain' };
  original.resolve([[old], 1]);
  const followup = await ready;
  followup.resolve([[fresh], 1]);
  await first;
  assert(services._downloadFiles[0] === fresh && pending.length === 2 && animations === 2,
    'one follow-up scan must publish the newest folder snapshot');
  ready = nextScan();
  const unchanged = services.checkDownloads();
  const repeat = await ready;
  repeat.resolve([[{ ...fresh, date: { tv_sec: 2 } }], 1]);
  await unchanged;
  assert(animations === 2, 'identical folder snapshots must not restart dock animations');
  ready = nextScan();
  const third = services.checkDownloads();
  const last = await ready;
  services._debounceCheckDownloads();
  services.disable();
  last.resolve([[old], 1]);
  await third;
  assert(last.cancellable.is_cancelled() && !services._downloadsCheckPending &&
    pending.length === 4 && services._downloadFiles.length === 0 && animations === 2,
    'disabled services must cancel active work and discard queued scans and in-flight replies');
  print('PASS Downloads events coalesce, unchanged snapshots stay idle, and shutdown cancels scans');
}

{
  const services = new Services();
  services._enabled = true;
  services._generation = 1;
  services.trashFull = false;
  let animations = 0;
  services.extension = { trash_icon: true, animate: () => animations++ };
  const scans = [];
  let onScan;
  const nextScan = () => new Promise((resolve) => { onScan = resolve; });
  services._trashDir = {
    enumerate_children_async(attributes, flags, priority, cancellable, callback) {
      const scan = { cancellable, closed: false };
      const enumerator = {
        next_files_async(count, priority, cancellable, callback) {
          scan.reply = (files) => callback(enumerator, files);
          onScan(scan);
        },
        next_files_finish: (files) => files,
        close_async(priority, cancellable, callback) {
          scan.closed = true;
          callback(enumerator, null);
        },
        close_finish() {},
      };
      scans.push(scan);
      callback(this, enumerator);
    },
    enumerate_children_finish: (enumerator) => enumerator,
  };

  let ready = nextScan();
  const checking = services.checkTrash();
  const first = await ready;
  for (let event = 0; event < 5; event++) await services.checkTrash();
  assert(scans.length === 1 && !first.cancellable.is_cancelled(),
    'monitor bursts must keep the current scan running');
  ready = nextScan();
  first.reply([]); // Empty snapshot taken before a file arrived.
  const second = await ready;
  assert(first.closed && scans.length === 2,
    'events during enumeration must trigger one fresh scan after closing the old one');
  second.reply([{}]);
  await checking;
  assert(services.trashFull && animations === 1 && second.closed && scans.length === 2,
    'the fresh snapshot must update the icon without redundant scans');

  ready = nextScan();
  const disabling = services.checkTrash();
  const last = await ready;
  await services.checkTrash();
  services.disable();
  last.reply([]);
  await disabling;
  assert(last.cancellable.is_cancelled() && last.closed && scans.length === 3 &&
    !services._trashCheckPending && animations === 1,
    'shutdown must cancel the active scan and discard its queued rescan and stale result');
  print('PASS Trash monitor events coalesce into a fresh scan and cannot outlive shutdown');
}

{
  const tray = Main.messageTray;
  Main.messageTray = new SignalSource();
  Main.messageTray.getSources = () => [];
  const volumeMonitor = new SignalSource();
  volumeMonitor.get_mounts = () => [];
  let volumeRequests = 0;
  const FeatureServices = loadClass('services.js', 'Services', {
    Gio: { VolumeMonitor: { get: () => { volumeRequests++; return volumeMonitor; } },
      File: { new_for_uri: () => ({ get_uri: () => 'trash:///' }) } }, GLib, Main,
  });
  const services = new FeatureServices();
  const monitors = [];
  let scheduled = 0, trashScans = 0, clockRedraws = 0, calendarRedraws = 0, desktopWrites = 0;
  services.extension = {
    docks: [{ _onClock: () => clockRedraws++, _onCalendar: () => calendarRedraws++ }],
    downloads_path: '', animate() {},
    _loTimer: { cancel() {}, runDebounced: () => { scheduled++; return {}; } },
  };
  services.setupTrashIcon = () => desktopWrites++;
  services.setupFolderIcon = () => desktopWrites++;
  services.checkTrash = () => trashScans++;
  services._defaultDownloadsDir = () => ({ get_path: () => '/downloads' });
  services._monitorDirectory = () => {
    const monitor = new SignalSource();
    monitor.cancel = () => { monitor.cancelled = true; };
    monitors.push(monitor);
    return monitor;
  };
  services.setupFolderIcons();
  services.enable();
  services.update(24 * 60 * 60 * 1000);
  assert(monitors.length === 0 && volumeRequests === 0 && scheduled === 0 &&
    desktopWrites === 0 && trashScans === 0 && clockRedraws === 0 && calendarRedraws === 0 &&
    !services.needsUpdates() && services.nextUpdateDelay() === null,
    'disabled features must create no folder/volume watchers, scans, redraws, or periodic work');

  Object.assign(services.extension, { downloads_icon: true, trash_icon: true, mounted_icon: true });
  services.setupDownloads();
  services.setupTrash();
  services.checkMounts();
  assert(monitors.length === 2 && volumeRequests === 1 && scheduled === 1 && trashScans === 1 &&
    desktopWrites === 2 &&
    volumeMonitor.listeners.length === 2 && services.nextUpdateDelay() === null,
    'enabling folder features must install their watchers while monitored Trash needs no poll');
  const removedMount = { get_drive() { throw new Error('removed mount is already disposed'); } };
  services._mounts = { '/old-mount.desktop': removedMount };
  services.mounts = [removedMount];
  services._deferredMounts = [removedMount];
  services.last_mounted = removedMount;
  volumeMonitor.emit('mount-removed', removedMount);
  assert(Object.keys(services._mounts).length === 0 && services.mounts.length === 0 &&
    services._deferredMounts.length === 0 && !services.last_mounted,
    'unmounting must release every retained mount reference without querying disposed properties');
  Object.assign(services.extension, { downloads_icon: false, trash_icon: false, mounted_icon: false });
  services.setupDownloads();
  services.setupTrash();
  services.checkMounts();
  assert(monitors.every((monitor) => monitor.cancelled && monitor.listeners.length === 0) &&
    volumeMonitor.listeners.length === 0 && !services._downloadsDir && !services._trashDir,
    'turning features off must release every corresponding watcher and folder reference');

  services.extension.clock_icon = true;
  assert(services.nextUpdateDelay() === 1, 'newly enabled clock needs its initial redraw');
  services.update(1);
  assert(clockRedraws === 1 && services.nextUpdateDelay() === 59999,
    'clock scheduling must wait until its actual minute deadline');
  services.update(60 * 60 * 1000);
  assert(clockRedraws === 2 && services.nextUpdateDelay() === 59999,
    'resuming after a long sleep must redraw once without replaying missed intervals');
  services.extension.clock_icon = false;
  services.extension.calendar_icon = true;
  services.update(1);
  assert(calendarRedraws === 1 && services.nextUpdateDelay() === 899999,
    'calendar redraws must have their own slow deadline');
  services.extension.calendar_icon = false;
  services.extension.trash_icon = true;
  assert(services.nextUpdateDelay() === 15000, 'unmonitored Trash must keep a slow fallback poll');
  services.update(15000);
  assert(trashScans === 2 && services.nextUpdateDelay() === 15000,
    'failed Trash monitoring must still refresh on its fallback deadline');
  services.disable();
  assert(Main.messageTray.listeners.length === 0, 'service shutdown must detach notification tray listeners');
  Main.messageTray = tray;
  print('PASS disabled features have no watchers or polling and enabled services use actual deadlines');
}

{
  const services = new Services();
  services._enabled = true;
  let animations = 0;
  services.extension = { animate: () => animations++ };
  Main.messageTray.getSources = () => [{ _appId: 'test', count: 2 }, { _appId: 'test.desktop', count: 3 }];
  services.checkNotifications();
  services.checkNotifications();
  assert(services._appNotices['test.desktop'].count === 5 && animations === 1, 'multiple notification sources must sum without false repeated updates');
  Main.messageTray.getSources = () => [];
  services.checkNotifications();
  assert(Object.keys(services._appNotices).length === 0 && animations === 2, 'cleared sources must release references and redraw');
  print('PASS notification sources aggregate without permanent badge refreshes');
}

{
  const tray = Main.messageTray;
  Main.messageTray = new SignalSource();
  const sources = [];
  Main.messageTray.getSources = () => sources;
  const services = new Services();
  services._enabled = true;
  let animations = 0;
  services.extension = { animate: () => animations++ };
  services._setupNotifications();
  assert(animations === 0, 'an idle notification tray must not animate');
  const source = new SignalSource();
  Object.assign(source, { _appId: 'test', count: 2 });
  sources.push(source);
  Main.messageTray.emit('source-added', source);
  Main.messageTray.emit('source-added', source);
  source.emit('notify::count');
  assert(source.listeners.length === 1 && animations === 1,
    'tracking the same source twice and unchanged counts must not add handlers or redraws');
  source.count = 3;
  source.emit('notify::count');
  assert(services._appNotices['test.desktop'].count === 3 && animations === 2,
    'count changes must update badges immediately without polling');
  sources.pop();
  Main.messageTray.emit('source-removed', source);
  assert(source.listeners.length === 0 && services._notificationSources.size === 0 && animations === 3,
    'removing a notification source must release its listeners and retained reference');
  sources.push(source);
  Main.messageTray.emit('source-added', source);
  services.disable();
  source.count++;
  source.emit('notify::count');
  assert(Main.messageTray.listeners.length === 0 && source.listeners.length === 0 && animations === 4,
    'shutdown must release every notification handler and prevent later redraws');
  Main.messageTray = tray;
  print('PASS notification badges react to source signals without periodic work or retained sources');
}

{
  class Widget {
    constructor() { this._canvas = { width: 120, set_scale() {} }; }
    connect(name, callback) { this.onDestroy = callback; }
    destroy() { this.destroyed = true; this.onDestroy(); }
    show() {}
    shouldHideIcon() { return true; }
  }
  const WidgetServices = loadClass('services.js', 'Services', { Gio, GLib, Main, Clock: Widget, Calendar: Widget });
  const services = new WidgetServices();
  services.extension = { clock_icon: true, calendar_icon: true };
  const dock = { extension: {}, renderArea: { add_child() {} } };
  for (const iconName of ['org.gnome.clocks', 'org.gnome.Calendar']) {
    const item = {
      _icon: { icon_name: iconName },
      _renderer: { width: 80, scale_x: 0.5, x: 1, y: 2, opacity: 255 },
    };
    services.updateIcon(item, { dock });
    assert(item._image.width === 40 && item._image.height === 40,
      'clock and calendar must read native Clutter scale_x and avoid NaN dimensions');
    const widget = item._image;
    services.extension.clock_icon = false;
    services.extension.calendar_icon = false;
    services.updateIcon(item, { dock });
    assert(widget.destroyed && !item._image && !item._clock && !item._calendar &&
      !dock._clock && !dock._calendar && item._renderer.opacity === 255,
      'turning a widget off must destroy its canvas and clear all retained references');
    services.extension.clock_icon = true;
    services.extension.calendar_icon = true;
  }
  print('PASS clock and calendar rendering uses finite native actor geometry');
}

{
  const ExtensionClass = loadClass('extension.js', 'Dash2DockLiteExt', { Main, Extension: class {} });
  const extension = new ExtensionClass();
  extension._enabled = true;
  extension._config = {};
  extension.docks = [];
  extension.multi_monitor_preference = 1;
  let creations = 0;
  extension.createDock = (index, config) => {
    creations++;
    extension.docks.push({ _monitorIndex: index, _config: config });
  };
  extension.destroyDocks = () => { extension.docks = []; };
  extension.createTheDocks();
  extension.createTheDocks();
  assert(creations === 2 && extension.docks.length === 2, 'repeated startup must not duplicate monitor docks');
  extension._config = { docks: [{ monitor: { x: 0, y: 0 } }, { monitor: { x: 999, y: 0 } }] };
  extension.createTheDocks();
  extension.createTheDocks();
  assert(creations === 3 && extension.docks.length === 1, 'missing configured monitors must not create repeated docks');
  Main.sessionMode.isLocked = true;
  extension.createTheDocks();
  assert(creations === 3, 'locked sessions must not create docks');
  Main.sessionMode.isLocked = false;
  print('PASS monitor and configured dock startup is idempotent and lock-aware');
}

{
  let resolveConfig;
  const ExtensionClass = loadClass('extension.js', 'Dash2DockLiteExt', {
    Main, Extension: class {},
    configFile: (name) => ({ query_exists: () => name === 'config.json' }),
    loadFile: () => new Promise((resolve) => { resolveConfig = resolve; }),
  });
  const extension = new ExtensionClass();
  extension._enabled = true;
  extension._lifecycleId = 1;
  const loading = extension._loadConfig();
  extension._enabled = false;
  extension._lifecycleId++;
  resolveConfig('{"speed-up": 2}');
  await loading;
  assert(Object.keys(extension._config).length === 0, 'configuration loaded after disable must be ignored');
  print('PASS asynchronous config loading cannot revive a disabled extension');
}

{
  const ExtensionClass = loadClass('extension.js', 'Dash2DockLiteExt', {
    Main, Extension: class {},
    configFile: (name) => ({ query_exists: () => name === 'config.json' }),
    loadFile: () => Promise.resolve('{"file-explorer":"custom-browser --new-window"}'),
    firstInstalledCommand: (commands) => commands[0],
  });
  const extension = new ExtensionClass();
  Object.assign(extension, { _enabled: true, _lifecycleId: 1, trash_icon: true, downloads_icon: true });
  const services = new Services();
  extension.services = services;
  services.extension = extension;
  const downloads = services._downloadsDir = { get_path: () => '/custom/Downloads' };
  const trash = services._trashDir = {};
  const cancellable = services._downloadsCancellable = new Gio.Cancellable();
  const monitor = services._downloadsMonitor = {};
  const files = services._downloadFiles = [{ path: '/custom/Downloads/current' }];
  const launchers = [];
  services.setupTrashIcon = () => launchers.push(['trash', extension.file_explorer()]);
  services.setupFolderIcon = (name, title, icon, path) =>
    launchers.push([name, extension.file_explorer(), path]);
  await extension._loadConfig();
  assert(launchers.length === 2 && launchers.every((launcher) => launcher[1] === 'custom-browser --new-window') &&
    launchers[1][2] === '/custom/Downloads',
    'late configuration must refresh enabled folder launchers using the configured opener and active folder');
  assert(services._downloadsDir === downloads && services._trashDir === trash &&
    services._downloadsMonitor === monitor && services._downloadsCancellable === cancellable &&
    !cancellable.is_cancelled() && services._downloadFiles === files,
    'refreshing launch commands must preserve watchers, active scans, and cached file rows');
  extension.trash_icon = false;
  extension.downloads_icon = false;
  services.setupFolderIcons();
  assert(launchers.length === 2, 'disabled folder features must not rewrite launcher files');
  print('PASS late opener configuration refreshes enabled launchers without restarting background work');
}

{
  for (const [json, iconSize, speed] of [
    ['{"icon-size":1e400,"speed-up":{}}', null, 1],
    ['{"icon-size":-4,"speed-up":"bad"}', null, 1],
    ['{"icon-size":"48","speed-up":"10"}', 48, 4],
    ['{"icon-size":64,"speed-up":0.1}', 64, 0.5],
  ]) {
    const ExtensionClass = loadClass('extension.js', 'Dash2DockLiteExt', {
      Main, Extension: class {},
      configFile: (name) => ({ query_exists: () => name === 'config.json' }),
      loadFile: () => Promise.resolve(json),
    });
    const extension = new ExtensionClass();
    extension._enabled = true;
    extension._lifecycleId = 1;
    await extension._loadConfig();
    assert(extension._config.icon_size === iconSize && extension._config.speed_up === speed,
      'config must normalize non-finite and malformed geometry while accepting numeric strings');
  }
  print('PASS invalid configuration cannot produce non-finite icon size or animation speed');
}

{
  const ExtensionClass = loadClass('extension.js', 'Dash2DockLiteExt', { Main, Extension: class {} });
  const extension = new ExtensionClass();
  extension._enabled = true;
  const cancelled = [];
  extension._loTimer = { cancel: (subscription) => cancelled.push(subscription) };
  extension._startupSeq = 'startup';
  extension._startupRefreshSeq = 'refresh';
  let destroyed = 0;
  let started = 0;
  extension.destroyDocks = () => destroyed++;
  extension.startUp = () => started++;
  extension.animate = () => {};
  Main.sessionMode.isLocked = true;
  extension._onSessionUpdated();
  assert(destroyed === 1 && cancelled.join(',') === 'startup,refresh', 'locking must tear down docks and pending startup callbacks');
  Main.sessionMode.isLocked = false;
  extension._onSessionUpdated();
  assert(started === 1, 'unlocking must restore docks');
  print('PASS lock and unlock tear down and restore dock lifecycles');
}

{
  const ExtensionClass = loadClass('extension.js', 'Dash2DockLiteExt', { Main, Extension: class {} });
  const extension = new ExtensionClass();
  Main.panel = { style: 'color: red;' };
  extension._updatePanelTransparency(true);
  const applied = Main.panel.style;
  extension._updatePanelTransparency(true);
  assert(Main.panel.style === applied && applied.includes('color: red;'), 'successive animation frames must keep panel transparency stable and preserve existing CSS');
  extension._updatePanelTransparency(false);
  assert(Main.panel.style === 'color: red;', 'leaving the overview must restore the original panel style');
  extension._updatePanelTransparency(true);
  Object.assign(extension, {
    _removeEvents() {}, _disableSettings() {}, _updateShrink() {},
    _unloadConfig() {}, _showMainOverviewDash() {}, destroyDocks() {},
  });
  Main.overview = {};
  extension.disable();
  assert(Main.panel.style === 'color: red;', 'disable cleanup must restore an owned style');
  extension._updatePanelTransparency(true);
  Main.panel.style = 'color: blue;';
  extension._restorePanelStyle();
  assert(Main.panel.style === 'color: blue;', 'cleanup must preserve a later style set by another extension');
  print('PASS panel transparency remains stable and restores only styles it owns');
}

{
  const ExtensionClass = loadClass('extension.js', 'Dash2DockLiteExt', { Main, Extension: class {} });
  const extension = new ExtensionClass();
  let forcedTextures = 0;
  let adjustments = 0;
  const icon = {
    icon: null,
    _iconBin: { child: null },
    _createIconTexture() { forcedTextures++; },
  };
  const firstItem = { child: { _delegate: { icon } } };
  const showAppsIcon = { icon: { icon: null, _createIconTexture() { forcedTextures++; } } };
  const adjustIconSize = () => ++adjustments;
  const dash = {
    _box: { get_children: () => [firstItem] },
    _showAppsIcon: showAppsIcon,
    _adjustIconSize: adjustIconSize,
  };
  Main.overview = { dash };
  extension._patchMainOverviewDash();
  dash._adjustIconSize();
  assert(adjustments === 0 && forcedTextures === 0, 'overview sizing must never force texture creation before styling');
  icon.icon = {};
  dash._adjustIconSize();
  assert(adjustments === 0, 'a texture detached from its bin must not be sized during teardown');
  icon._iconBin.child = icon.icon;
  assert(dash._adjustIconSize() === 1, 'healthy styled icons must reach the original sizing implementation');
  icon._d2dlDestroying = true;
  dash._adjustIconSize();
  assert(adjustments === 1, 'destroying icons must not enter native sizing');
  firstItem.animatingOut = true;
  dash._adjustIconSize();
  assert(adjustments === 1 && forcedTextures === 0, 'empty dash must also wait for the Show Apps texture');
  showAppsIcon.icon.icon = {};
  assert(dash._adjustIconSize() === 2, 'healthy Show Apps texture must allow native sizing');
  Object.assign(extension, {
    _removeEvents() {}, _disableSettings() {}, _updateShrink() {},
    _unloadConfig() {}, _showMainOverviewDash() {}, destroyDocks() {},
  });
  extension.disable();
  assert(dash._adjustIconSize === adjustIconSize, 'disable must restore the original overview sizing method');
  print('PASS overview sizing waits for native style initialization without creating textures');
}

{
  const ExtensionClass = loadClass('extension.js', 'Dash2DockLiteExt', { Main, Extension: class {} });
  const extension = new ExtensionClass();
  const calls = [];
  const createDock = (index) => ({
    undock() { assert(this._destroyed, 'dock must be marked before cleanup'); calls.push(`${index}:undock`); if (index === 0) throw new Error('disposed actor (expected test error)'); },
    cancelAnimations() { calls.push(`${index}:cancel`); },
    destroyDash() { calls.push(`${index}:dash`); },
    destroy() { calls.push(`${index}:destroy`); },
  });
  extension.docks = [createDock(0), createDock(1)];
  extension.services = {};
  extension.destroyDocks();
  assert(calls.length === 8 && calls[7] === '1:destroy' && extension.docks.length === 0,
    'one failed native cleanup must not leave other actors or timer subscriptions alive');
  print('PASS partial native teardown errors cannot skip remaining dock cleanup');
}

{
  const replies = [];
  class Proxy {
    connectSignal() { return 1; }
    disconnectSignal() { this.disconnected = true; }
    GetCurrentStateRemote(callback) { replies.push(callback); }
  }
  const GObject = { registerClass: (metadata, cls) => cls, Object: class { emit() {} } };
  const MonitorsConfig = loadClass('monitors.js', 'MonitorsConfig', {
    GObject, Gio: { DBus: { session: {} }, DBusProxy: { makeProxyWrapper: () => Proxy } },
  });
  const monitors = new MonitorsConfig();
  monitors._updateResources();
  const state = (connector) => [1, [[[connector, 'vendor', 'product', 'serial'], [], {}]],
    [[0, 0, 1, 0, true, [[connector, 'vendor', 'product', 'serial']]]]];
  replies[1](state('new'), null);
  replies[0](state('old'), null);
  assert(monitors.monitors[0].connector === 'new', 'out-of-order D-Bus replies must not restore stale monitor topology');
  monitors._updateResources();
  monitors.destroy();
  replies[2](state('destroyed'), null);
  assert(monitors.monitors.length === 0, 'monitor replies after destruction must be ignored');
  print('PASS monitor D-Bus replies cannot race topology changes or destruction');
}

{
  const extensions = new Map();
  Main.extensionManager = { lookup: (uuid) => extensions.get(uuid) };
  const Integrations = loadClass('integrations.js', 'Integrations', { Main });
  const integrations = new Integrations();
  integrations.extension = { docks: [], lamp_app_animation: true, blur_background: true };
  integrations.enable(); // other extensions may not be installed
  const original = () => 'original';
  const target = { getIcon: original };
  extensions.set('compiz-alike-magic-lamp-effect@hermes83.github.com', { stateObj: target });
  integrations.hookCompiz();
  assert(target.getIcon !== original, 'enabled integration must install its wrapper');
  integrations.extension.lamp_app_animation = false;
  integrations.hookCompiz();
  assert(target.getIcon === original, 'turning off the setting must restore the original method');
  integrations.extension.lamp_app_animation = true;
  integrations.hookCompiz();
  const laterWrapper = () => 'other extension';
  target.getIcon = laterWrapper;
  integrations.disable();
  assert(target.getIcon === laterWrapper, 'cleanup must preserve a wrapper subsequently installed by another extension');
  const originalSize = () => {};
  const blur = { update_size: originalSize };
  extensions.set('blur-my-shell@aunetx', { metadata: { version: 70 }, stateObj: { _dash_to_dock_blur: blur } });
  integrations.hookBms();
  assert(blur.update_size !== originalSize, 'enabled blur integration must install its wrapper');
  integrations.extension.blur_background = false;
  integrations.hookBms();
  assert(blur.update_size === originalSize, 'disabling blur must restore the original size callback');
  print('PASS integrations handle absent extensions, setting toggles, and owned restoration');
}
