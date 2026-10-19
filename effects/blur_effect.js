'use strict';

import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';

// Gnome 51 replaced the GLSL source of ShaderEffect with Cogl snippets
const USE_SNIPPET = !Clutter.ShaderEffect.prototype.set_shader_source;

const legacyShaderSource = (source) => `${source}
void main() {
    cogl_color_out = d2da_effect(cogl_tex_coord_in[0].st);
}
`;

let cachedShaderPath;
let cachedShaderSource;
const getBlurShaderSource = (extensionDir) => {
  const SHADER_PATH = GLib.build_filenamev([
    extensionDir,
    'effects',
    'blur_effect.glsl',
  ]);

  if (cachedShaderPath === SHADER_PATH) return cachedShaderSource;
  try {
    cachedShaderSource = Shell.get_file_contents_utf8_sync(SHADER_PATH);
    cachedShaderPath = SHADER_PATH;
    return cachedShaderSource;
  } catch (e) {
    log(`[d2dl] error loading shader from ${SHADER_PATH}: ${e}`);
    return null;
  }
};

const D2DABlurEffectBase = GObject.registerClass(
  {},
  class D2DABlurEffect extends Clutter.ShaderEffect {
    _init(params = {}) {
      this._red = null;
      this._green = null;
      this._blue = null;
      this._blend = null;

      this._static = true;

      // initialize without color as a parameter

      const { color: _color, ...effectParams } = params;

      super._init(effectParams);

      // set shader color

      if (_color) this.color = _color;
    }

    preload(path) {
      // set shader source
      this._source = getBlurShaderSource(path);
      if (this._source && !USE_SNIPPET)
        this.set_shader_source(legacyShaderSource(this._source));
      if (this._source) this.set_uniform_value('tex', 0);

      this.update_enabled();
    }

    get red() {
      return this._red;
    }

    set red(value) {
      if (this._red !== value) {
        this._red = value;

        this.set_uniform_value('red', parseFloat(this._red - 1e-6));
      }
    }

    get green() {
      return this._green;
    }

    set green(value) {
      if (this._green !== value) {
        this._green = value;

        this.set_uniform_value('green', parseFloat(this._green - 1e-6));
      }
    }

    get blue() {
      return this._blue;
    }

    set blue(value) {
      if (this._blue !== value) {
        this._blue = value;

        this.set_uniform_value('blue', parseFloat(this._blue - 1e-6));
      }
    }

    get blend() {
      return this._blend;
    }

    set blend(value) {
      if (value > 0.5) {
        value *= 0.75;
        if (value < 0.5) {
          value = 0.5;
        }
      }
      if (this._blend !== value) {
        this._blend = value;

        this.set_uniform_value('blend', parseFloat(this._blend - 1e-6));
      }
      this.update_enabled();
    }

    set color(rgba) {
      let [r, g, b, a] = rgba;
      this.red = r;
      this.green = g;
      this.blue = b;
      this.blend = a;
    }

    get color() {
      return [this.red, this.green, this.blue, this.blend];
    }

    /// False set function, only cares about the color. Too hard to change.
    set(params) {
      this.color = params.color;
    }

    update_enabled() {
      this.set_enabled(this.blend > 0 && this._static && !!this._source);
    }

  }
);

export const BlurEffect = USE_SNIPPET
  ? GObject.registerClass(
      {},
      class D2DABlurSnippetEffect extends D2DABlurEffectBase {
        vfunc_get_static_snippet() {
          return Cogl.Snippet.new(
            Cogl.SnippetHook.FRAGMENT,
            this._source || 'vec4 d2da_effect(vec2 coord) { return vec4(0.0); }',
            'cogl_color_out = d2da_effect(cogl_tex_coord0_in.st);'
          );
        }
      }
    )
  : D2DABlurEffectBase;
