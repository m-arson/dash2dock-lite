import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

function load(file, names, dependencies) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(dependencies), `${source}\nreturn {${names}};`)(
    ...Object.values(dependencies));
}

const {SettingsKeys} = load('preferences/keys.js', 'SettingsKeys', {
  PrefKeys: class {setKeys(keys) { this.keys = keys; }},
});
const badgeOptions = SettingsKeys().keys['notification-badge-style'].options;
assert.deepEqual(badgeOptions, ['none', 'dot', 'dash', 'square', 'triangle', 'diamond', 'count'],
  'count is appended without changing existing saved style indices');

const Pango = {SCALE: 1024, FontDescription: {from_string() {
  return {set_absolute_size(size) { this.pixels = size / Pango.SCALE; }};
}}};
let layoutAllocations = 0;
const PangoCairo = {
  create_layout() {
    layoutAllocations++;
    return {
      set_text(text) { this.text = text; },
      set_font_description(font) { this.font = font; },
      get_pixel_extents() {
        // Real fonts have nonzero ink offsets and leading. Deliberately retain
        // these so logical-size centering cannot accidentally pass the test.
        const size = this.font.pixels;
        const ink = {x: 2, y: size * 0.23, width: this.text.length * size * 0.55,
          // A tall glyph exercises vertical fitting independently of the
          // horizontal fitting needed for multiple digits.
          height: size * (this.text === '9' ? 1 : 0.7)};
        return [ink, {x: 0, y: 0, width: ink.width + 3, height: size * 1.4}];
      },
    };
  },
  update_layout() {},
  show_layout(context, layout) { context.captureText(layout); },
};
const Drawing = {set_color(context, color, alpha = 1) {
  context.setSourceRGBA(color[0], color[1], color[2], color[3] ?? alpha);
}};
const common = {
  GObject: {registerClass: (...args) => args.at(-1)},
  St: {Widget: class {}, DrawingArea: class {}}, Clutter: {}, Drawing,
};
const {DotCanvas} = load('apps/dot.js', 'DotCanvas', {
  ...common, Pango, PangoCairo,
  Cairo: {Operator: {CLEAR: 0, SOURCE: 1, OVER: 2}, LineCap: {ROUND: 1}},
});
const {DockItemBadgeOverlay} = load('dockItems.js', 'DockItemBadgeOverlay', {
  ...common, PopupMenu: {PopupMenu: class {}}, DashIcon: class {}, DashItemContainer: class {},
});

function fixture(options = {}) {
  const canvas = Object.create(DotCanvas.prototype);
  Object.assign(canvas, {width: 96, height: 96, state: {}, repaints: 0});
  canvas.get_surface_size = () => [96, 96];
  canvas.queue_repaint = () => canvas.repaints++;
  canvas.set_scale = (x, y) => { canvas.scale_x = x; canvas.scale_y = y; };
  const renderer = {_canvas: canvas, set_state: state => canvas.set_state(state)};
  const overlay = {renderer};
  const icon = {_icon: {width: 48, height: 48},
    _renderer: {width: 32, scale_x: (options.scale ?? 1) * (options.zoom ?? 1)}};
  const data = {
    noticesCount: options.count ?? 3, position: options.position ?? 'left',
    extension: {
      notification_badge_style_options: badgeOptions, notification_badge_style: options.style ?? 6,
      notification_badge_size: options.size ?? 0,
      notification_badge_color: options.color ?? [0.9, 0.1, 0.15, 1],
    },
  };
  const update = () => DockItemBadgeOverlay.prototype.update.call(overlay, icon, data);
  update();
  return {canvas, renderer, overlay, icon, data, update};
}

function paint(canvas) {
  const painted = {backgrounds: [], texts: [], clears: 0, arcs: 0, rectangles: 0};
  let offset = [0, 0], current = [0, 0], color, points = [];
  const stack = [];
  const methods = {
    save() { stack.push({offset: [...offset], current: [...current], color}); },
    restore() { ({offset, current, color} = stack.pop()); },
    translate(x, y) { offset = [offset[0] + x, offset[1] + y]; },
    rotate(angle) { assert.equal(angle, 0, 'count badges remain upright on every dock edge'); },
    moveTo(x, y) { current = [x + offset[0], y + offset[1]]; },
    newSubPath() { points = []; },
    arc(x, y, radius) {
      painted.arcs++;
      points.push([x + offset[0] - radius, y + offset[1] - radius],
        [x + offset[0] + radius, y + offset[1] + radius]);
    },
    rectangle(x, y, width, height) {
      painted.rectangles++;
      points.push([x + offset[0], y + offset[1]],
        [x + offset[0] + width, y + offset[1] + height]);
    },
    setSourceRGBA(...rgba) { color = rgba; },
    fill() {
      painted.backgrounds.push({color: [...color],
        x: Math.min(...points.map(point => point[0])),
        y: Math.min(...points.map(point => point[1])),
        right: Math.max(...points.map(point => point[0])),
        bottom: Math.max(...points.map(point => point[1]))});
      points = [];
    },
    paint() { painted.clears++; },
    captureText(layout) {
      const [ink] = layout.get_pixel_extents();
      painted.texts.push({text: layout.text, color: [...color],
        x: current[0] + ink.x, y: current[1] + ink.y,
        width: ink.width, height: ink.height});
    },
  };
  canvas._paint(new Proxy(methods, {get: (target, property) => target[property] ?? (() => {})}));
  return painted;
}

function assertLayout(painted, text, expectedDiameter = 96 * 0.44) {
  assert.equal(painted.backgrounds.length, 1, 'one red background is painted');
  assert.equal(painted.rectangles, 0, 'count badges do not draw rectangular backgrounds');
  assert.equal(painted.arcs, 1, 'every count uses one circular background');
  assert.equal(painted.texts.length, 1, 'one notification count is painted');
  const background = painted.backgrounds[0], label = painted.texts[0];
  const width = background.right - background.x;
  const height = background.bottom - background.y;
  assert.equal(label.text, text);
  assert.deepEqual(background.color, [0.9, 0.1, 0.15, 1]);
  assert.deepEqual(label.color, [1, 1, 1, 1], 'red badges use white numbers');
  assert.ok(background.x >= 0 && background.y >= 0 && background.right <= 96 && background.bottom <= 96,
    'the full background fits inside its canvas');
  assert.ok(background.x > 0 && background.y < 10 && background.right > 90,
    'the badge sits at the top-right of the icon');
  assert.ok(label.x >= background.x && label.y >= background.y &&
    label.x + label.width <= background.right && label.y + label.height <= background.bottom,
  'the measured text fits inside its background');
  assert.ok(Math.abs(label.x + label.width / 2 - (background.x + background.right) / 2) < 1e-8);
  assert.ok(Math.abs(label.y + label.height / 2 - (background.y + background.bottom) / 2) < 1e-8,
    'ink bounds are centered despite font leading');
  assert.ok(Math.abs(width - height) < 1e-8, 'counts never widen the circular badge into a pill');
  assert.ok(Math.abs(width - expectedDiameter) < 1e-8,
    'the requested badge diameter stays fixed for one digit, multiple digits, and 99+');
  assert.ok(label.width <= width * 0.72 + 1e-8 && label.height <= height * 0.72 + 1e-8,
    'text fits both the width and height limit inside the circle');
  const centerX = (background.x + background.right) / 2;
  const centerY = (background.y + background.bottom) / 2;
  for (const x of [label.x, label.x + label.width]) {
    for (const y of [label.y, label.y + label.height]) {
      assert.ok(Math.hypot(x - centerX, y - centerY) <= width / 2 + 1e-8,
        'all measured ink corners stay inside the circular background');
    }
  }
}

const previousSmallDiameter = 96 * 0.44 * 1.15 / 3;
const expectedDiameters = [96 * 0.44, previousSmallDiameter * 2.25, 96 * 0.44 * 1.15];
for (const size of [0, 1, 2]) {
  for (const [count, text] of [[1, '1'], [2, '2'], [3, '3'], [9, '9'], [10, '10'],
    [99, '99'], [100, '99+'], [1000000, '99+'], [2.8, '2']]) {
    assertLayout(paint(fixture({count, size}).canvas), text, expectedDiameters[size]);
  }
}
const actualDiameters = [1, 2].map(size => {
  const background = paint(fixture({size}).canvas).backgrounds[0];
  return background.right - background.x;
});
assert.ok(Math.abs(actualDiameters[0] / previousSmallDiameter - 2.25) < 1e-8,
  'the selected Small badge is exactly 2.25 times its previous diameter');
assert.ok(Math.abs(actualDiameters[0] / actualDiameters[1] - 0.75) < 1e-8,
  'enlarging Small retains the existing Large badge diameter');
for (const count of [0, -1, NaN, Infinity, -Infinity]) {
  const test = fixture();
  test.data.noticesCount = count;
  test.update();
  const before = layoutAllocations;
  const painted = paint(test.canvas);
  assert.equal(painted.clears, 1, 'empty counts clear any previous visible badge');
  assert.equal(painted.backgrounds.length, 0);
  assert.equal(painted.texts.length, 0);
  assert.equal(layoutAllocations, before, 'invalid or empty counts do not create text layouts');
}

for (const position of ['left', 'right', 'top', 'bottom']) {
  for (const scale of [1, 2]) {
    for (const zoom of [1, 1.75]) {
      const test = fixture({position, scale, zoom, count: 10, size: 1});
      const actualSize = test.icon._renderer.width * test.icon._renderer.scale_x;
      assert.equal(test.overlay.countBadge, true);
      assert.equal(test.renderer.width, actualSize,
        'badge geometry follows the actual rendered icon, including scale and zoom');
      assert.equal(test.renderer.height, actualSize);
      assert.equal(test.canvas.scale_x, actualSize / 96);
      assert.equal(test.canvas.scale_y, actualSize / 96);
      assert.equal(test.renderer.translation_x, 0);
      assert.equal(test.renderer.translation_y, 0);
      assert.deepEqual(test.canvas.state.translate, [0, 0]);
      assert.ok(!test.canvas.state.rotate, 'dock edge does not rotate notification text');
      const painted = paint(test.canvas);
      assertLayout(painted, '10', expectedDiameters[1]);
      const background = painted.backgrounds[0];
      assert.ok(background.right * test.canvas.scale_x <= actualSize &&
        background.bottom * test.canvas.scale_y <= actualSize,
      'zoomed badge remains fully inside the visual icon bounds');
    }
  }
}

const fallback = fixture();
fallback.icon._renderer = null;
fallback.update();
assert.equal(fallback.renderer.width, fallback.icon._icon.width,
  'a missing visual renderer falls back to the native icon size');
const contrast = paint(fixture({color: [1, 1, 1, 1]}).canvas);
assert.deepEqual(contrast.texts[0].color, [0.1, 0.1, 0.1, 1],
  'light custom backgrounds retain a contrasting count');
const none = paint(fixture({style: 0}).canvas);
assert.equal(none.backgrounds.length, 0);
assert.equal(none.texts.length, 0, 'the appended count style preserves notification None');

const changing = fixture({count: 2});
assert.equal(changing.canvas.repaints, 1);
for (let frame = 0; frame < 30; frame++) changing.update();
assert.equal(changing.canvas.repaints, 1, 'unchanged counts do not queue repeated Cairo repaints');
changing.data.noticesCount = 3;
changing.update();
assert.equal(changing.canvas.repaints, 2, 'a changed count schedules a repaint');
assert.equal(paint(changing.canvas).texts[0].text, '3');
changing.update();
assert.equal(changing.canvas.repaints, 2);

console.log('Notification count badge regressions passed');
