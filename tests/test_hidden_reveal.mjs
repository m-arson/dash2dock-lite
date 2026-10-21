import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const stripImports = source => source.replace(/^import\s[\s\S]*?;\n/gm, '')
  .replace(/^export /gm, '');
const utilsSource = stripImports(readFileSync(new URL('../utils.js', import.meta.url), 'utf8'));
const {isInRect, isOverlapRect} = new Function('GLib', 'Gio',
  `${utilsSource}\nreturn {isInRect, isOverlapRect};`)({}, {});
const dockSource = stripImports(readFileSync(new URL('../dock.js', import.meta.url), 'utf8'));
const dockDependencies = {
  Main: {}, DashModule: {Dash: class {}},
  GObject: {registerClass: (...args) => args.at(-1)},
  St: {Widget: class {}}, Config: {PACKAGE_VERSION: '48'},
  Graphene: {Point: class {}}, isInRect,
};
const Dock = new Function(...Object.keys(dockDependencies), `${dockSource}\nreturn Dock;`)(
  ...Object.values(dockDependencies));
const autoHideSource = stripImports(readFileSync(new URL('../autohide.js', import.meta.url), 'utf8'));

function makeHarness(position, scale) {
  const monitor = {index: 0, x: -2560, y: -400, width: 1600 * scale,
    height: 900 * scale, geometry_scale: scale, inFullscreen: false};
  const vertical = position === 'left' || position === 'right';
  const thickness = 100 * scale;
  const rect = vertical
    ? [position === 'left' ? monitor.x : monitor.x + monitor.width - thickness,
      monitor.y + 100 * scale, thickness, 600 * scale]
    : [monitor.x + 300 * scale,
      position === 'top' ? monitor.y : monitor.y + monitor.height - thickness,
      700 * scale, thickness];
  const nearPointer = vertical
    ? [position === 'left' ? monitor.x + 50 * scale : monitor.x + monitor.width - 50 * scale,
      rect[1] + rect[3] / 2]
    : [rect[0] + rect[2] / 2,
      position === 'top' ? monitor.y + 50 * scale : monitor.y + monitor.height - 50 * scale];
  const edgePointer = vertical
    ? [position === 'left' ? monitor.x + 1 : monitor.x + monitor.width - 1, nearPointer[1]]
    : [nearPointer[0], position === 'top' ? monitor.y + 1 : monitor.y + monitor.height - 1];
  const state = {pointer: nearPointer, covered: true, menuOpen: false,
    now: 0, jobs: new Set(), showCalls: 0};
  const coveringWindow = {
    connectObject() {}, disconnectObject() {}, can_close: () => true,
    get_monitor: () => monitor.index, get_workspace: () => ({index: () => 0}),
    showing_on_its_workspace: () => true, get_window_type: () => 0,
    get_frame_rect: () => ({x: monitor.x, y: monitor.y,
      width: monitor.width, height: monitor.height}),
  };
  const timer = {
    runDebounced(callback, delay) {
      const job = {callback, due: state.now + delay};
      state.jobs.add(job);
      return job;
    },
    cancel(job) { state.jobs.delete(job); },
  };
  const extension = {_loTimer: timer, _hiTimer: timer,
    autohide_dash: true, autohide_dodge: false, pressure_sense: false};
  const dependencies = {
    console: {log() {}}, Meta: {WindowType: {NORMAL: 0}},
    DockPosition: {LEFT: 'left', RIGHT: 'right', TOP: 'top', BOTTOM: 'bottom'},
    global: {get_pointer: () => state.pointer,
      get_window_actors: () => state.covered ? [{get_meta_window: () => coveringWindow}] : [],
      workspace_manager: {get_active_workspace_index: () => 0}},
    isInRect, isOverlapRect,
  };
  const AutoHide = new Function(...Object.keys(dependencies), `${autoHideSource}\nreturn AutoHide;`)(
    ...Object.values(dependencies));
  const dock = Object.assign(Object.create(Dock.prototype), {
    _monitor: monitor, _position: position, _hidden: false, _icons: [], extension,
    struts: {width: rect[2], height: rect[3], get_transformed_position: () => rect.slice(0, 2)},
    isVertical: () => vertical, _hasOpenMenu: () => state.menuOpen,
    slideIn() { state.showCalls++; this._hidden = false; },
    slideOut() { this._hidden = true; },
  });
  const autoHide = new AutoHide();
  autoHide.extension = extension;
  autoHide.dock = dock;
  function advance(ms = 120) {
    state.now += ms;
    for (const job of [...state.jobs]) {
      if (job.due <= state.now) {
        state.jobs.delete(job);
        job.callback();
      }
    }
  }
  function check() { autoHide._debounceCheckHide(); advance(); }
  autoHide.enable();
  advance();
  return {autoHide, dock, extension, monitor, rect, nearPointer, edgePointer, state, check, advance};
}

for (const scale of [1, 2]) {
  for (const position of ['left', 'right', 'top', 'bottom']) {
    const label = `${position}, scale ${scale}, negative monitor origin`;
    const h = makeHarness(position, scale);
    const {autoHide, dock, extension, state, nearPointer, edgePointer, rect} = h;
    assert.equal(isInRect(rect, nearPointer), true, `${label}: regression pointer is inside the old footprint`);
    assert.equal(dock._hidden, false, `${label}: visible hover keeps the dock open`);
    assert.equal(dock._isWithinDash(nearPointer), true, `${label}: uses the actual visible hover predicate`);

    autoHide.hide();
    const callsAtHide = state.showCalls;
    assert.equal(dock._isWithinDash(nearPointer), false, `${label}: hidden dock has no hover area`);
    // Sliding and shrinking icons can keep scheduling checks for several
    // seconds. The static struts still describe the old visible footprint.
    // The previous implementation reveals on the very first of these checks.
    for (let frame = 0; frame < 25; frame++) {
      h.check();
      assert.equal(dock._hidden, true, `${label}: settling check ${frame} cannot reveal away from the edge`);
      assert.equal(autoHide._shown, false, `${label}: settling checks keep autohide state synchronized`);
    }
    assert.equal(state.showCalls, callsAtHide, `${label}: no transient slide-in occurs during three seconds of checks`);
    assert.equal(state.jobs.size, 0, `${label}: hidden checks add no ongoing polling`);
    h.advance(3000);
    h.check();
    assert.equal(dock._hidden, true, `${label}: reveal distance stays the same after animation settles`);

    // Transformed native icons can extend beyond the struts. Their real input
    // rectangles should hold a visible dock, but never reveal a hidden one.
    const overhang = position === 'left' ? [rect[0] + rect[2] + 30, nearPointer[1] - 10, 30, 30]
      : position === 'right' ? [rect[0] - 60, nearPointer[1] - 10, 30, 30]
      : position === 'top' ? [nearPointer[0] - 10, rect[1] + rect[3] + 30, 30, 30]
      : [nearPointer[0] - 10, rect[1] - 60, 30, 30];
    dock._icons = [{_inputRect: overhang}];
    state.pointer = [overhang[0] + 15, overhang[1] + 15];
    assert.equal(isInRect(rect, state.pointer, 20), false, `${label}: overhang lies beyond the padded struts`);
    autoHide.show();
    assert.equal(dock._isWithinDash(state.pointer), true, `${label}: actual native icon input counts as visible hover`);
    h.check();
    assert.equal(dock._hidden, false, `${label}: magnified icon remains usable outside the frame`);
    autoHide.hide();
    h.check();
    assert.equal(dock._hidden, true, `${label}: stale icon input cannot reveal a hidden dock`);

    state.pointer = edgePointer;
    autoHide._onEnterEvent();
    assert.equal(dock._hidden, false, `${label}: entering the actual edge reveals normally`);
    assert.equal(autoHide._shown, true, `${label}: edge reveal updates autohide state`);

    extension.pressure_sense = true;
    autoHide.hide();
    state.pointer = nearPointer;
    autoHide._onEnterEvent();
    for (let motion = 0; motion < 100; motion++) autoHide._onMotionEvent();
    for (let frame = 0; frame < 25; frame++) h.check();
    assert.equal(dock._hidden, true, `${label}: pressure cannot be bypassed by old-footprint motion or overlap checks`);
    state.pointer = edgePointer;
    for (let motion = 0; motion < 100; motion++) autoHide._onMotionEvent();
    assert.equal(dock._hidden, false, `${label}: sustained pressure at the actual edge still reveals`);

    extension.pressure_sense = false;
    extension.autohide_dodge = true;
    state.pointer = nearPointer;
    autoHide.hide();
    h.check();
    assert.equal(dock._hidden, true, `${label}: covering window keeps the hidden dock hidden`);
    state.covered = false;
    h.check();
    assert.equal(dock._hidden, false, `${label}: removing the covering window legitimately reveals in dodge mode`);

    state.covered = true;
    autoHide.hide();
    state.menuOpen = true;
    h.check();
    assert.equal(dock._hidden, false, `${label}: an open chooser still keeps its source visible`);
    state.menuOpen = false;
    autoHide.hide();
    extension._inOverview = true;
    h.check();
    assert.equal(dock._hidden, false, `${label}: overview still legitimately reveals the dock`);
    extension._inOverview = false;
    autoHide.disable();
    assert.equal(state.jobs.size, 0, `${label}: shutdown leaves no delayed checks`);
  }
}

console.log('Hidden dock reveal regressions passed (all edges, scales, settling, pressure, and valid reveal paths)');
