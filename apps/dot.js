// adapted from https://github.com/jderose9/dash-to-panel
// adapted from https://github.com/micheleg/dash-to-dock

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import St from 'gi://St';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import { Drawing } from '../drawing.js';

export const Dot = GObject.registerClass(
  {},
  class Dot extends St.Widget {
    _init(x, settings = {}) {
      super._init();

      let size = x || 400;

      this._canvas = new DotCanvas(settings);
      this._canvas.width = size;
      this._canvas.height = size;
      this.add_child(this._canvas);

      this.set_state = this._canvas.set_state.bind(this._canvas);
    }

    redraw() {
      this.visible = true;
      this._canvas.redraw();
    }
  }
);

const DotCanvas = GObject.registerClass(
  {},
  class DotCanvas extends St.DrawingArea {
    _init(settings = {}) {
      super._init();

      this.state = {};

      this._padding = 8;
      this._barHeight = 6;
    }

    redraw() {
      this.queue_repaint();
    }

    set_state(s) {
      const sameArray = (a, b) =>
        a === b ||
        (a == null && b == null) ||
        (Array.isArray(a) &&
          Array.isArray(b) &&
          a.length === b.length &&
          a.every((v, idx) => v === b[idx]));
      if (
        !this.state ||
        this.state.count != s.count ||
        !sameArray(this.state.color, s.color) ||
        this.state.style != s.style ||
        this.state.rotate != s.rotate ||
        !sameArray(this.state.translate, s.translate) ||
        this.state.scale != s.scale ||
        this.state.size != s.size
      ) {
        this.state = {
          ...s,
          color: s.color ? [...s.color] : null,
          translate: s.translate ? [...s.translate] : null,
        };
        this.redraw();
      }
    }

    dot_size(h) {
      let sz = [0.8, 0.5, 1.0];
      return h * (sz[this.state.size] || 1);
    }

    vfunc_repaint() {
      let ctx = this.get_context();
      try {
        this._paint(ctx);
      } finally {
        ctx.$dispose();
      }
    }

    _paint(ctx) {
      let [width, height] = this.get_surface_size();

      let size = width;

      ctx.setOperator(Cairo.Operator.CLEAR);
      ctx.paint();

      if (!this.state || !this.state.color || !this.state.count) return;

      ctx.setLineWidth(1);
      ctx.setLineCap(Cairo.LineCap.ROUND);
      ctx.setOperator(Cairo.Operator.SOURCE);

      ctx.save();

      ctx.translate(width / 2, height / 2);
      if (this.state.translate) {
        ctx.translate(
          this.state.translate[0] * width,
          this.state.translate[1] * height
        );
      }
      if (this.state.rotate) {
        ctx.rotate((this.state.rotate * Math.PI) / 180);
      }
      ctx.translate(-width / 2, -height / 2);

      // _draw_dot...
      let func = this[`_draw_${this.state.style}`];
      if (typeof func === 'function') {
        func.call(this, ctx, this.state);
      }

      ctx.restore();
    }

    _draw_segmented(ctx, state) {
      let [size, _] = this.get_surface_size();

      let count = state.count;
      if (count > 4) count = 4;
      let height = this.dot_size(this._barHeight);
      let width = size - this._padding * 2;
      ctx.translate(this._padding, size - height * 2.5);

      let sz = width / 20;
      let spacing = Math.ceil(width / 18); // separation between the dots
      let dashLength = Math.ceil((width - (count - 1) * spacing) / count);
      let lineLength = width - sz * (count - 1) - spacing * (count - 1);

      for (let i = 0; i < count; i++) {
        ctx.newSubPath();
        ctx.rectangle(i * dashLength + i * spacing, 0, dashLength, height);
      }

      ctx.strokePreserve();
      Drawing.set_color(ctx, state.color, state.color[3]);
      ctx.fill();
    }

    _draw_solid(ctx, state) {
      this._draw_segmented(ctx, { ...state, count: 1 });
    }

    _draw_dashes(ctx, state) {
      let [size, _] = this.get_surface_size();

      let count = state.count;
      if (count > 4) count = 4;
      let height = this.dot_size(this._barHeight + 2);
      let width = size - this._padding * 2;

      // Include the one-pixel outline so Small halves the visible thickness.
      const thicknessScale = [1, 0.5, 1.25][state.size] ?? 1;
      let sz = Math.max(0, (width / 14 + 1) * thicknessScale - 1);
      let spacing = Math.ceil(width / 16); // separation between the dots
      let dashLength = Math.floor(width / 4) - spacing;

      ctx.translate(
        Math.floor((size - count * dashLength - (count - 1) * spacing) / 2),
        size - height * 1.5
      );

      for (let i = 0; i < count; i++) {
        ctx.newSubPath();
        ctx.rectangle(i * dashLength + i * spacing, 0, dashLength, sz);
      }

      ctx.strokePreserve();
      Drawing.set_color(ctx, state.color, state.color[3]);
      ctx.fill();
    }

    _draw_dash(ctx, state) {
      this._draw_dashes(ctx, { ...state, count: 1 });
    }

    _draw_squares(ctx, state) {
      let [size, _] = this.get_surface_size();

      let count = state.count;
      if (count > 4) count = 4;
      let height = this.dot_size(this._barHeight + 5);
      let width = size - this._padding * 2;

      let spacing = Math.ceil(width / 18); // separation between the dots
      let dashLength = height;

      ctx.translate(
        Math.floor((size - count * dashLength - (count - 1) * spacing) / 2),
        size - height * 1.5
      );

      for (let i = 0; i < count; i++) {
        ctx.newSubPath();
        ctx.rectangle(i * dashLength + i * spacing, 0, dashLength, height);
      }

      ctx.strokePreserve();
      Drawing.set_color(ctx, state.color, state.color[3]);
      ctx.fill();
    }

    _draw_square(ctx, state) {
      this._draw_squares(ctx, { ...state, count: 1 });
    }

    _draw_triangles(ctx, state) {
      let [size, _] = this.get_surface_size();

      let count = state.count;
      if (count > 4) count = 4;
      let height = this.dot_size(this._barHeight + 6);
      let width = size - this._padding * 2;

      let spacing = Math.ceil(width / 16); // separation between the dots
      let dashLength = height + 8;

      ctx.translate(
        Math.floor((size - count * dashLength - (count - 1) * spacing) / 2),
        size - height * 1.5
      );

      for (let i = 0; i < count; i++) {
        ctx.newSubPath();
        ctx.moveTo(i * dashLength + i * spacing + dashLength / 2, 0);
        ctx.lineTo(i * dashLength + i * spacing, height);
        ctx.lineTo(i * dashLength + i * spacing + dashLength, height);
      }

      ctx.strokePreserve();
      Drawing.set_color(ctx, state.color, state.color[3]);
      ctx.fill();
    }

    _draw_triangle(ctx, state) {
      this._draw_triangles(ctx, { ...state, count: 1 });
    }

    _draw_diamonds(ctx, state) {
      let [size, _] = this.get_surface_size();

      let count = state.count;
      if (count > 4) count = 4;
      let height = this.dot_size(this._barHeight + 10);
      let width = size - this._padding * 2;

      let spacing = Math.ceil(width / 16); // separation between the dots
      let dashLength = height;

      ctx.translate(
        Math.floor((size - count * dashLength - (count - 1) * spacing) / 2),
        size - height * 1.5
      );

      for (let i = 0; i < count; i++) {
        ctx.newSubPath();
        ctx.moveTo(i * dashLength + i * spacing + dashLength / 2, 0);
        ctx.lineTo(i * dashLength + i * spacing, height / 2);
        ctx.lineTo(i * dashLength + i * spacing + dashLength / 2, height);
        ctx.lineTo(i * dashLength + i * spacing + dashLength, height / 2);
      }

      ctx.strokePreserve();
      Drawing.set_color(ctx, state.color, state.color[3]);
      ctx.fill();
    }

    _draw_diamond(ctx, state) {
      this._draw_diamonds(ctx, { ...state, count: 1 });
    }

    _draw_dots(ctx, state) {
      let [size, _] = this.get_surface_size();

      let count = state.count;
      if (count > 4) count = 4;
      let height = this.dot_size(this._barHeight);
      let width = size - this._padding * 2;

      let spacing = Math.ceil(width / 18); // separation between the dots
      let radius = height;

      ctx.translate(
        Math.floor(
          (size - count * radius - (count - 1) * spacing) / 2 - radius / 2
        ),
        size - height
      );

      for (let i = 0; i < count; i++) {
        ctx.newSubPath();
        ctx.arc(
          (2 * i + 1) * radius + i * radius,
          -radius,
          radius,
          0,
          2 * Math.PI
        );
      }

      ctx.strokePreserve();
      Drawing.set_color(ctx, state.color, state.color[3]);
      ctx.fill();
    }

    _draw_binary(ctx, state) {
      let [size, _] = this.get_surface_size();

      let count = 4;
      let n = Math.min(15, state.count);
      let binaryValue = String('0000' + (n >>> 0).toString(2)).slice(-4);

      let height = this.dot_size(this._barHeight + 2);
      let width = size - this._padding * 2;

      let spacing = Math.ceil(width / 14); // separation between the dots
      let dashLength = height * 1.4;
      let radius = height * 0.9;

      ctx.translate(
        Math.floor((size - count * dashLength - (count - 1) * spacing) / 2),
        size - height * 1.5 - radius / 2
      );

      for (let i = 0; i < count; i++) {
        ctx.newSubPath();
        if (binaryValue[i] == '1') {
          ctx.arc(
            i * dashLength + i * spacing + dashLength / 2,
            radius / 2,
            radius,
            0,
            2 * Math.PI
          );
        } else {
          ctx.rectangle(
            i * dashLength + i * spacing,
            0,
            dashLength,
            height - 2
          );
        }
      }

      ctx.strokePreserve();
      Drawing.set_color(ctx, state.color, state.color[3]);
      ctx.fill();
    }

    _draw_count(ctx, state) {
      const count = Math.floor(Number(state.count));
      if (!Number.isFinite(count) || count <= 0) return;

      const [width, surfaceHeight] = this.get_surface_size();
      const size = Math.min(width, surfaceHeight);
      const factor = [1, (1.15 / 3) * 2.25, 1.15][state.size] ?? 1;
      const diameter = size * 0.44 * factor;
      const inset = size * 0.055;
      const text = count > 99 ? '99+' : String(count);
      // Keep every ink corner inside the circle, with room for pixel rounding.
      const maxInkSize = Math.max(1, diameter * 0.7 - 1);
      const layout = PangoCairo.create_layout(ctx);
      const font = Pango.FontDescription.from_string('Sans Bold');
      let fontSize = diameter * 0.85;
      const measure = () => {
        font.set_absolute_size(fontSize * Pango.SCALE);
        layout.set_font_description(font);
        PangoCairo.update_layout(ctx, layout);
        return layout.get_pixel_extents()[0];
      };
      layout.set_text(text, -1);
      let ink = measure();
      const textScale = Math.min(
        1,
        maxInkSize / Math.max(1, ink.width),
        maxInkSize / Math.max(1, ink.height)
      );
      if (textScale < 1) {
        fontSize *= textScale;
        ink = measure();
      }

      const radius = diameter / 2;
      const centerX = width - inset - radius;
      const centerY = inset + radius;
      ctx.newSubPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      Drawing.set_color(ctx, state.color, state.color[3]);
      ctx.fill();

      // Keep text legible if the badge color is customized after installation.
      const brightness = state.color[0] * 0.2126 +
        state.color[1] * 0.7152 + state.color[2] * 0.0722;
      const foreground = brightness > 0.65 ? [0.1, 0.1, 0.1, 1] : [1, 1, 1, 1];
      ctx.setOperator(Cairo.Operator.OVER);
      Drawing.set_color(ctx, foreground);
      ctx.moveTo(
        centerX - ink.x - ink.width / 2,
        centerY - ink.y - ink.height / 2
      );
      PangoCairo.show_layout(ctx, layout);
    }

    _draw_dot(ctx, state) {
      this._draw_dots(ctx, { ...state, count: 1 });
    }
  }
);
