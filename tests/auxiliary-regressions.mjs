// Run with: node --test tests/auxiliary-regressions.mjs
// GI-independent checks for async completion, repaint, and signal lifetimes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function loadModule(path, names, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+default\s+(?=class)/gm, '')
    .replace(/^export\s+(?=const|let|class)/gm, '');
  return new Function(...Object.keys(dependencies), `${source}\nreturn {${names}};`)(
    ...Object.values(dependencies)
  );
}

class Signals {
  listeners = new Map();
  nextId = 1;
  connect(name, callback) {
    const id = this.nextId++;
    this.listeners.set(id, { name, callback });
    return id;
  }
  disconnect(id) {
    assert.equal(this.listeners.delete(id), true, 'Signal disconnected once');
  }
  emit(name, ...args) {
    for (const listener of [...this.listeners.values()]) {
      if (listener.name === name) listener.callback(this, ...args);
    }
  }
}

class Settings extends Signals {
  constructor(values) {
    super();
    this.values = { ...values };
    this.writes = [];
  }
  get_boolean(name) { return this.values[name]; }
  get_int(name) { return this.values[name]; }
  get_double(name) { return this.values[name]; }
  set_boolean(name, value) { this.write(name, value); }
  set_int(name, value) { this.write(name, value); }
  set_double(name, value) { this.write(name, value); }
  write(name, value) {
    this.values[name] = value;
    this.writes.push([name, value]);
    this.emit(`changed::${name}`);
  }
}

class Widget extends Signals {
  set_active(value) {
    this.active = value;
    this.emit('notify::active');
  }
  get_active() { return this.active; }
  set_selected(value) {
    this.selected = value;
    this.emit('notify::selected-item');
  }
  get_selected() { return this.selected; }
  set_value(value) {
    this.value = value;
    this.emit('value-changed');
  }
  get_value() { return this.value; }
}

test('settings reconnects and widget refreshes have no duplicate listeners or feedback', () => {
  const { PrefKeys } = loadModule('preferences/prefKeys.js', 'PrefKeys', {
    Gdk: {}, GLib: {},
  });
  const bindings = new PrefKeys();
  bindings.setKeys({
    enabled: { default_value: false, widget_type: 'switch' },
    monitor: { default_value: 0, widget_type: 'dropdown' },
    scale: { default_value: 0.5, widget_type: 'scale' },
  });
  const settings = new Settings({ enabled: true, monitor: 2, scale: 0.8 });
  const widgets = { enabled: new Widget(), monitor: new Widget(), scale: new Widget() };
  const builder = { get_object: name => widgets[name] };
  let changes = 0;
  bindings.connectSettings(settings, () => changes++);
  bindings.connectBuilder(builder);
  bindings.connectSettings(settings, () => changes++);
  bindings.connectBuilder(builder);
  assert.equal(settings.listeners.size, 3);
  assert.equal(widgets.enabled.listeners.size, 1);
  assert.deepEqual(settings.writes, []);
  widgets.enabled.set_active(false);
  assert.deepEqual(settings.writes, [['enabled', false]]);
  assert.equal(changes, 1);
  settings.write('scale', 0.3);
  assert.equal(widgets.scale.value, 0.3);
  assert.equal(settings.writes.length, 2);
  bindings.updateWidget('monitor', widget => {
    widget.set_selected(0xffffffff);
    widget.set_selected(0);
    widget.set_selected(2);
  });
  assert.equal(settings.values.monitor, 2);
  assert.equal(settings.writes.length, 2);
  widgets.monitor.set_selected(0xffffffff);
  assert.equal(settings.writes.length, 2);
  bindings.destroy();
  bindings.destroy();
  assert.equal(settings.listeners.size, 0);
  for (const widget of Object.values(widgets)) assert.equal(widget.listeners.size, 0);
});

test('rejected GSettings writes preserve cached values and restore the widget', () => {
  const { PrefKeys } = loadModule('preferences/prefKeys.js', 'PrefKeys', {
    Gdk: {}, GLib: { Variant: class {} },
  });
  let callbacks = 0;
  for (const [type, current, rejected] of [
    ['switch', false, true], ['dropdown', 2, 99], ['scale', 0.5, 4],
    ['color', [0, 0, 0, 1], [1, 1, 1, 1]],
    ['string', 'original', 'rejected'], ['json_array', [], [1]],
  ]) {
    const bindings = new PrefKeys();
    bindings.setKey('value', current, type, null, null, () => callbacks++);
    bindings._settings = {
      set_boolean: () => false, set_int: () => false,
      set_double: () => false, set_value: () => false, set_string: () => false,
    };
    assert.equal(bindings.setValue('value', rejected), false);
    assert.equal(bindings.getValue('value'), current);
  }
  assert.equal(callbacks, 0);
  const bindings = new PrefKeys();
  bindings.setKey('monitor', 0, 'dropdown');
  const settings = new Settings({ monitor: 2 });
  settings.set_int = () => false;
  const widget = new Widget();
  bindings.connectSettings(settings);
  bindings.connectBuilder({ get_object: () => widget });
  widget.set_selected(99);
  assert.equal(widget.selected, 2);
  assert.equal(bindings.getValue('monitor'), 2);
  bindings.destroy();
});

test('native folder selection reuses its dialog and ignores obsolete responses', async () => {
  const choosers = [];
  class File {
    get_path() { return '/selected'; }
  }
  class NativeChooser extends Signals {
    constructor() {
      super();
      this.shows = 0;
      this.destroys = 0;
      choosers.push(this);
    }
    show() { this.shows++; }
    destroy() { this.destroys++; }
    get_file() { return new File(); }
  }
  const { Preferences } = loadModule('prefs.js', 'Preferences', {
    Gdk: {}, Gtk: { FileChooserNative: NativeChooser,
      FileChooserAction: { SELECT_FOLDER: 1 }, ResponseType: { ACCEPT: 1 } },
    Gio: { File }, Adw: {}, ExtensionPreferences: class {}, console: { log() {} },
  });
  const preferences = Object.create(Preferences.prototype);
  const window = {};
  preferences.window = window;
  let changes = 0;
  preferences.updateFolders = () => changes++;
  const settings = { set_string: () => changes++ };
  await preferences.selectFolder(window, {}, settings, 'downloads-path');
  await preferences.selectFolder(window, {}, settings, 'downloads-path');
  assert.equal(choosers.length, 1);
  assert.equal(choosers[0].shows, 2);
  choosers[0].emit('response', 0);
  assert.equal(choosers[0].destroys, 1);
  await preferences.selectFolder(window, {}, settings, 'downloads-path');
  choosers[0].emit('response', 1);
  assert.equal(preferences._folderChooser, choosers[1]);
  assert.equal(changes, 0);
  choosers[1].emit('response', 1);
  assert.equal(changes, 2);
  assert.equal(choosers[1].destroys, 1);
  assert.equal(preferences._folderChooser, null);
});

test('blur preserves constant texture channels instead of amplifying alpha', () => {
  const shader = readFileSync(new URL('../effects/blur_effect.glsl', import.meta.url), 'utf8');
  const body = shader.match(/vec4 blur\([^)]*\)\s*{([\s\S]*?)\n}/)[1]
    .replace(/\b(?:vec4|float)\s+(\w+)\s*=/g, 'let $1 =');
  // Evaluate each channel for a constant texture; vector coordinate offsets
  // are immaterial in this case. An averaging kernel must preserve its input.
  const blurChannel = new Function('texture2D', 'vec4', 'vec2', 'texture', 'texCoord', body);
  for (const channel of [0, 0.15, 0.6, 1]) {
    const result = blurChannel(() => channel, value => value, () => 0, null, 0);
    assert.ok(Math.abs(result - channel) < 1e-12);
    assert.ok(result >= 0 && result <= 1);
  }
});

test('tint opacity preserves premultiplied color channels on transparent textures', () => {
  const shader = readFileSync(new URL('../effects/tint_effect.glsl', import.meta.url), 'utf8');
  const body = shader.match(/vec4 d2da_effect\([^)]*\)\s*{([\s\S]*?)\n}/)[1]
    .replace(/\bvec3\s+(\w+)\s*=/g, 'let $1 =');
  // Evaluate a constant grayscale texture, where vector arithmetic reduces
  // to scalar arithmetic. Every premultiplied RGB channel must remain <= alpha.
  const tint = new Function('c', 'red', 'green', 'blue', 'blend', 'vec3', 'vec4', 'mix', body);
  for (const alpha of [0, 0.1, 0.5, 1]) {
    for (const channel of [0, alpha / 2, alpha]) {
      for (const blend of [0, 0.25, 0.75, 1]) {
        const result = tint({rgb: channel, a: alpha}, 1, 1, 1, blend,
          value => value, (rgb, a) => ({rgb, a}), (a, b, amount) => a * (1 - amount) + b * amount);
        assert.ok(result.rgb >= 0 && result.rgb <= result.a + 1e-12,
          `tint produced RGB ${result.rgb} above alpha ${result.a}`);
        if (blend === 0) assert.equal(result.rgb, channel * 0.85);
      }
    }
  }
});

test('modern folder selection ignores late completion from a cancelled request', async () => {
  const dialogs = [];
  class File {
    get_path() { return '/selected'; }
  }
  class FileDialog {
    constructor() { dialogs.push(this); }
    select_folder(window, cancellable, callback) {
      this.callback = callback;
      this.cancellable = cancellable;
    }
    select_folder_finish() { return new File(); }
  }
  const { Preferences } = loadModule('prefs.js', 'Preferences', {
    Gdk: {}, Gtk: { FileDialog },
    Gio: { File, Cancellable: class { cancel() { this.cancelled = true; } } },
    Adw: {}, ExtensionPreferences: class {}, console: { log() {} },
  });
  const preferences = Object.create(Preferences.prototype);
  const window = {};
  preferences.window = window;
  preferences.updateFolders = () => {};
  let changes = 0;
  const settings = { set_string: () => changes++ };
  await preferences.selectFolder(window, {}, settings, 'downloads-path');
  await preferences.selectFolder(window, {}, settings, 'downloads-path');
  assert.equal(dialogs.length, 1);
  const cancelled = preferences._folderDialog;
  preferences._folderDialog = null;
  cancelled.cancellable.cancel();
  await preferences.selectFolder(window, {}, settings, 'downloads-path');
  const current = preferences._folderDialog;
  dialogs[0].callback(dialogs[0], {});
  assert.equal(changes, 0);
  assert.equal(preferences._folderDialog, current);
  dialogs[1].callback(dialogs[1], {});
  assert.equal(changes, 1);
  assert.equal(preferences._folderDialog, null);
});

test('file loader rejects asynchronous failures and supports cancellation', async () => {
  const { loadFile } = loadModule('utils.js', 'loadFile', { Gio: {}, GLib: {} });
  const cancellable = {};
  const failure = new Error('File removed before async read completed');
  const file = {
    load_contents_async(received, callback) {
      assert.equal(received, cancellable);
      queueMicrotask(() => callback(this, {}));
    },
    load_contents_finish() { throw failure; },
  };
  await assert.rejects(loadFile(file, cancellable), error => error === failure);
  file.load_contents_finish = () => [false, null];
  await assert.rejects(loadFile(file, cancellable), /Unable to load file/);
  file.load_contents_finish = () => [true, new TextEncoder().encode('loaded')];
  assert.equal(await loadFile(file, cancellable), 'loaded');
});

test('rectangle containment works without explicit padding', () => {
  const { isInRect } = loadModule('utils.js', 'isInRect', { Gio: {}, GLib: {} });
  assert.equal(isInRect([10, 20, 30, 40], [15, 25]), true);
  assert.equal(isInRect([10, 20, 30, 40], [40, 25]), false);
  assert.equal(isInRect([10, 20, 30, 40], [5, 25], 5), true);
});

const registerClass = (...args) => args.at(-1);
const actorDependencies = {
  GObject: { registerClass },
  Clutter: { Actor: class {}, Canvas: class {} },
  Cairo: { Operator: { CLEAR: 0, SOURCE: 1 }, LineCap: { ROUND: 1 } },
  St: { Widget: class {}, DrawingArea: class {} },
  Drawing: {},
};

class Actor extends Signals {
  constructor(...args) {
    super();
    this._init(...args);
  }
  _init() {}
  set_size() {}
  set_content(content) { this.content = content; }
  destroy() {
    this.emit('destroy');
    this.destroyed = true;
  }
}

test('debug overlays release their canvas and use the actor destruction lifecycle', () => {
  class Canvas extends Signals {
    invalidate() {}
    set_size() {}
  }
  const { DebugOverlay } = loadModule('apps/overlay.js', 'DebugOverlay', {
    ...actorDependencies, Clutter: { Actor, Canvas },
  });
  const overlay = new DebugOverlay(100, 100);
  const canvas = overlay._canvas;
  assert.equal(canvas.listeners.size, 1);
  overlay.destroy();
  assert.equal(overlay.destroyed, true);
  assert.equal(canvas.listeners.size, 0);
  assert.equal(overlay.content, null);
  assert.equal(overlay._canvas, null);
});

test('pullout animation stops safely when its target or list is destroyed', () => {
  const { DockItemList } = loadModule('dockItemMenu.js', 'DockItemList', {
    Main: {}, BoxPointer: {}, PopupMenu: {}, trySpawnCommandLine() {},
    Gio: {}, GLib: {}, GObject: { registerClass },
    Clutter: {}, St: { Widget: Actor }, Graphene: {}, DockPosition: {},
  });
  const list = new DockItemList();
  const dock = {
    _list: list,
    _destroyList() {
      this._list.destroy();
      this._list = null;
    },
  };
  list.dock = dock;
  list.animate(16);
  assert.equal(list.destroyed, true);
  assert.equal(dock._list, null);
  assert.doesNotThrow(() => list.animate(16));
});

test('empty indicators clear their surface and dispose contexts even after repaint errors', () => {
  const { DotCanvas } = loadModule('apps/dot.js', 'DotCanvas', actorDependencies);
  const canvas = Object.create(DotCanvas.prototype);
  let paints = 0;
  let disposed = 0;
  const context = { setOperator() {}, paint() { paints++; }, $dispose() { disposed++; } };
  canvas.state = { count: 0, color: [1, 1, 1, 1] };
  canvas.get_context = () => context;
  canvas.get_surface_size = () => [64, 64];
  canvas.vfunc_repaint();
  assert.equal(paints, 1);
  assert.equal(disposed, 1);
  canvas._paint = () => { throw new Error('Draw failed'); };
  assert.throws(() => canvas.vfunc_repaint(), /Draw failed/);
  assert.equal(disposed, 2);
});

test('indicator snapshots detect in-place changes and avoid equal-array repaint loops', () => {
  const { DotCanvas } = loadModule('apps/dot.js', 'DotCanvas', actorDependencies);
  const canvas = Object.create(DotCanvas.prototype);
  canvas.state = {};
  let repaints = 0;
  canvas.queue_repaint = () => repaints++;
  const color = [1, 0, 0, 1];
  const state = { count: 1, color, style: 'dot', translate: [0, 0] };
  canvas.set_state(state);
  canvas.set_state({ ...state, color: [...color], translate: [0, 0] });
  assert.equal(repaints, 1);
  color[0] = 0.5;
  canvas.set_state(state);
  assert.equal(repaints, 2);
  canvas.set_state({ count: 0 });
  canvas.set_state({ count: 0 });
  assert.equal(repaints, 3);
});

function indicatorFixture(OverlayName, options = {}) {
  const {DotCanvas} = loadModule('apps/dot.js', 'DotCanvas', actorDependencies);
  const overlays = loadModule(
    'dockItems.js', 'DockItemDotsOverlay, DockItemBadgeOverlay', {
      ...actorDependencies, PopupMenu: {PopupMenu: class {}},
      DashIcon: class {}, DashItemContainer: class {},
      DockPosition: {BOTTOM: 'bottom', TOP: 'top', LEFT: 'left', RIGHT: 'right'},
    });
  const canvas = Object.create(DotCanvas.prototype);
  Object.assign(canvas, {_padding: 8, _barHeight: 6, width: 96, state: {}, repaints: 0});
  canvas.set_scale = (x, y) => { canvas.scale_x = x; canvas.scale_y = y; };
  canvas.queue_repaint = () => canvas.repaints++;
  canvas.get_surface_size = () => [96, 96];
  const renderer = {_canvas: canvas, set_state: state => canvas.set_state(state)};
  const extension = {
    running_indicator_style_options: ['default', 'dots', 'dot', 'dashes', 'dash'],
    running_indicator_style: options.runningStyle ?? 0,
    running_indicator_size: options.runningSize ?? 0,
    notification_badge_style_options: ['none', 'dot'],
    notification_badge_style: options.badgeStyle ?? 0,
  };
  const icon = {_icon: {width: 48, height: 48}};
  const dock = {_iconSizeScaledDown: 48,
    _monitor: {geometry_scale: options.monitorScale ?? 1}};
  const position = options.position ?? 'bottom';
  const overlay = {renderer};
  const data = {
    appCount: options.windows ?? 3, noticesCount: 3, position,
    vertical: position === 'left' || position === 'right', extension, dock,
  };
  const update = () => overlays[OverlayName].prototype.update.call(overlay, icon, data);
  update();
  return {canvas, renderer, extension, update};
}

function paintIndicator(canvas) {
  let matrix = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  let rectanglePaths = [];
  const stack = [];
  const painted = {arcs: [], rectangles: 0, strokedRectangles: [], fills: 0, clears: 0};
  const methods = {
    save() { stack.push({matrix: [...matrix], lineWidth}); },
    restore() { ({matrix, lineWidth} = stack.pop()); },
    setLineWidth(width) { lineWidth = width; },
    translate(x, y) {
      const [a, b, c, d, e, f] = matrix;
      matrix = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
    },
    rotate(angle) {
      const [a, b, c, d, e, f] = matrix;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      matrix = [a * cosine + c * sine, b * cosine + d * sine,
        c * cosine - a * sine, d * cosine - b * sine, e, f];
    },
    arc(x, y, radius) {
      const [a, b, c, d, e, f] = matrix;
      painted.arcs.push({x: a * x + c * y + e, y: b * x + d * y + f, radius});
    },
    rectangle(x, y, width, height) {
      painted.rectangles++;
      const [a, b, c, d, e, f] = matrix;
      rectanglePaths.push([[x, y], [x + width, y], [x, y + height], [x + width, y + height]]
        .map(([px, py]) => [a * px + c * py + e, b * px + d * py + f]));
    },
    strokePreserve() {
      // Cairo strokes straddle the rectangle path. Include both half-strokes
      // so the test measures visible thickness rather than only fill height.
      for (const corners of rectanglePaths) {
        painted.strokedRectangles.push({
          left: Math.min(...corners.map(point => point[0])) - lineWidth / 2,
          right: Math.max(...corners.map(point => point[0])) + lineWidth / 2,
          top: Math.min(...corners.map(point => point[1])) - lineWidth / 2,
          bottom: Math.max(...corners.map(point => point[1])) + lineWidth / 2,
        });
      }
    },
    fill() { painted.fills++; rectanglePaths = []; },
    paint() { painted.clears++; },
  };
  const context = new Proxy(methods, {get: (target, property) => target[property] ?? (() => {})});
  const originalSetColor = actorDependencies.Drawing.set_color;
  actorDependencies.Drawing.set_color = () => {};
  try {
    canvas._paint(context);
  } finally {
    actorDependencies.Drawing.set_color = originalSetColor;
  }
  return painted;
}

test('default running indicators retain window counts and notification None draws no badge', () => {
  const running = paintIndicator(indicatorFixture('DockItemDotsOverlay').canvas);
  assert.equal(running.arcs.length, 3, 'default running style retains its window-count display');
  assert.equal(running.fills, 1);
  const none = indicatorFixture('DockItemBadgeOverlay');
  assert.equal(none.canvas.state.style, 'none');
  const hidden = paintIndicator(none.canvas);
  assert.equal(hidden.clears, 1, 'a reused None surface clears old contents');
  assert.equal(hidden.arcs.length, 0, 'None does not draw the old fallback notification dot');
  assert.equal(hidden.rectangles, 0);
  assert.equal(hidden.fills, 0, 'None does not fill any badge shape');
  const invalid = indicatorFixture('DockItemBadgeOverlay', {badgeStyle: 99});
  assert.equal(invalid.canvas.state.style, 'none', 'unknown badge styles fall back to None');
  assert.equal(paintIndicator(invalid.canvas).fills, 0);
  const enabled = paintIndicator(indicatorFixture('DockItemBadgeOverlay', {badgeStyle: 1}).canvas);
  assert.equal(enabled.arcs.length, 1, 'enabling the notification dot still draws it');
  assert.equal(enabled.fills, 1);
});

test('single-dot running style paints one circular marker at each outer dock edge', () => {
  for (const [position, rotation] of [['bottom', 0], ['top', 180], ['left', 90], ['right', -90]]) {
    for (const monitorScale of [1, 2]) {
      for (const windows of [1, 3, 9]) {
        const {canvas, renderer} = indicatorFixture('DockItemDotsOverlay',
          {runningStyle: 2, position, monitorScale, windows});
        assert.equal(canvas.state.rotate, rotation);
        const painted = paintIndicator(canvas);
        assert.equal(painted.arcs.length, 1,
          `${position}: single-dot style draws one circle for ${windows} windows`);
        assert.equal(painted.rectangles, 0, 'single-dot style cannot paint a square');
        assert.equal(painted.fills, 1);
        const circle = painted.arcs[0];
        const x = circle.x * canvas.scale_x + (renderer.translation_x ?? 0);
        const y = circle.y * canvas.scale_y + (renderer.translation_y ?? 0);
        const size = 48 * monitorScale;
        const horizontal = position === 'left' || position === 'right';
        const normal = horizontal ? x : y;
        const tangent = horizontal ? y : x;
        const edge = position === 'left' || position === 'top' ? 0 : size;
        assert.ok(Math.abs(normal - edge) <= circle.radius * canvas.scale_x,
          `${position}: the marker touches the physical outer edge at scale ${monitorScale}`);
        assert.ok(Math.abs(tangent - size / 2) < monitorScale,
          `${position}: the marker stays centered along its icon edge`);
      }
    }
  }
});

test('Small single-dash markers halve visible thickness while preserving their length at every dock edge', () => {
  for (const position of ['bottom', 'top', 'left', 'right']) {
    for (const monitorScale of [1, 2]) {
      for (const windows of [1, 3, 9]) {
        const dimensions = [];
        for (const runningSize of [0, 1]) {
          const {canvas, renderer} = indicatorFixture('DockItemDotsOverlay',
            {runningStyle: 4, runningSize, position, monitorScale, windows});
          assert.equal(canvas.state.style, 'dash');
          assert.equal(canvas.state.size, runningSize);
          const painted = paintIndicator(canvas);
          assert.equal(painted.rectangles, 1,
            `${position}: single Dash retains one marker for ${windows} windows`);
          assert.equal(painted.strokedRectangles.length, 1);
          assert.equal(painted.arcs.length, 0);
          assert.equal(painted.fills, 1);
          const bounds = painted.strokedRectangles[0];
          const left = bounds.left * canvas.scale_x + (renderer.translation_x ?? 0);
          const right = bounds.right * canvas.scale_x + (renderer.translation_x ?? 0);
          const top = bounds.top * canvas.scale_y + (renderer.translation_y ?? 0);
          const bottom = bounds.bottom * canvas.scale_y + (renderer.translation_y ?? 0);
          const vertical = position === 'left' || position === 'right';
          dimensions.push({thickness: vertical ? right - left : bottom - top,
            length: vertical ? bottom - top : right - left});
        }
        const [normal, small] = dimensions;
        assert.ok(Math.abs(small.thickness - normal.thickness / 2) < 1e-8,
          `${position} scale ${monitorScale}: Small halves the full visible thickness, including its stroke`);
        assert.ok(Math.abs(small.length - normal.length) < 1e-8,
          `${position} scale ${monitorScale}: Small preserves the marker's length`);
        assert.ok(small.length > small.thickness, 'the thinner marker remains a line');
      }
    }
  }
});

test('Small Dashes show one marker per window, up to four, at every dock edge', () => {
  for (const position of ['bottom', 'top', 'left', 'right']) {
    for (const monitorScale of [1, 2]) {
      for (const windows of [1, 2, 3, 4, 7]) {
        const {canvas} = indicatorFixture('DockItemDotsOverlay',
          {runningStyle: 3, runningSize: 1, position, monitorScale, windows});
        assert.equal(canvas.state.style, 'dashes');
        assert.equal(canvas.state.count, windows);
        const painted = paintIndicator(canvas);
        assert.equal(painted.rectangles, Math.min(windows, 4),
          `${position} scale ${monitorScale}: distinguish ${windows} windows`);
      }
    }
  }
});

test('stable Small single-dash markers do not queue idle repaint work', () => {
  const marker = indicatorFixture('DockItemDotsOverlay', {runningStyle: 4, windows: 3});
  assert.equal(marker.canvas.repaints, 1);
  marker.extension.running_indicator_size = 1;
  marker.update();
  assert.equal(marker.canvas.repaints, 2, 'changing thickness repaints the marker once');
  for (let frame = 0; frame < 100; frame++) marker.update();
  assert.equal(marker.canvas.repaints, 2, 'unchanged thin markers schedule no further Cairo repaints');
});

test('effect construction preserves shared parameters and supports both shader APIs', () => {
  for (const [path, name] of [
    ['color', 'ColorEffect'], ['tint', 'TintEffect'],
    ['monochrome', 'MonochromeEffect'], ['blur', 'BlurEffect'],
  ]) {
    for (const legacy of [false, true]) {
      const uniformWrites = [];
      let shaderReads = 0;
      class ShaderEffect {
        _init(params) { this.params = params; }
        set_uniform_value(...args) { uniformWrites.push(args); }
        set_enabled() {}
        vfunc_paint_target() {}
      }
      if (legacy) ShaderEffect.prototype.set_shader_source = function (source) {
        this.source = source;
      };
      const { [name]: Effect } = loadModule(`effects/${path}_effect.js`, name, {
        GObject: { registerClass },
        Clutter: { ShaderEffect },
        GLib: { build_filenamev: parts => parts.join('/') },
        Shell: { get_file_contents_utf8_sync: filename => {
          shaderReads++;
          return readFileSync(filename, 'utf8');
        } },
        Cogl: { SnippetHook: { FRAGMENT: 1 }, Snippet: { new: (...args) => args } },
      });
      const parameters = Object.freeze({ color: [0.2, 0.4, 0.6, 0.5] });
      const effect = Object.create(Effect.prototype);
      effect._init(parameters);
      assert.equal(parameters.color.length, 4);
      effect.preload(new URL('..', import.meta.url).pathname);
      assert.equal(uniformWrites.filter(([name]) => name === 'tex').length,
        legacy || path === 'blur' ? 1 : 0, 'sampler is initialized once');
      const beforePaint = uniformWrites.length;
      for (let frame = 0; frame < 100; frame++) effect.vfunc_paint_target();
      assert.equal(uniformWrites.length, beforePaint,
        'painting never changes uniforms or queues another effect repaint');
      const second = Object.create(Effect.prototype);
      second._init(parameters);
      second.preload(new URL('..', import.meta.url).pathname);
      assert.equal(shaderReads, 1, 'effect instances share the loaded shader source');
      if (legacy) {
        assert.match(effect.source, /void main\(\)/);
      } else {
        const [, declarations, post] = effect.vfunc_get_static_snippet();
        assert.doesNotMatch(declarations, /void main\(\)/);
        assert.match(declarations, /d2da_effect/);
        assert.match(post, /cogl_color_out = d2da_effect/);
      }
    }
  }
});
