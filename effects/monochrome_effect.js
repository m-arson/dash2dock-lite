// Adapted from from Blur-My-Shell
// Adapted from https://gist.github.com/yiwenl/1c2ce935e66b82c7df5f

'use strict';

import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';

// Gnome 51 replaced the GLSL source of ShaderEffect with Cogl snippets
const USE_SNIPPET = !Clutter.ShaderEffect.prototype.set_shader_source;

// monochrome_effect.glsl provides d2da_effect(); wrap it for the legacy API
const legacyShaderSource = (source) => `uniform sampler2D tex;
${source}
void main() {
    cogl_color_out = d2da_effect(texture2D(tex, cogl_tex_coord_in[0].st));
}
`;

const getMonochromeShaderSource = (extensionDir) => {
  const SHADER_PATH = GLib.build_filenamev([
    extensionDir,
    'effects',
    'monochrome_effect.glsl',
  ]);

  try {
    return Shell.get_file_contents_utf8_sync(SHADER_PATH);
  } catch (e) {
    log(`[d2dl] error loading shader from ${SHADER_PATH}: ${e}`);
    return null;
  }
};

/// New Clutter Shader Effect that simply mixes a color in, the class applies
/// the GLSL shader programmed into vfunc_get_static_shader_source and applies
/// it to an Actor.
///
/// Clutter Shader Source Code:
/// https://github.com/GNOME/clutter/blob/master/clutter/clutter-shader-effect.c
///
/// GJS Doc:
/// https://gjs-docs.gnome.org/clutter10~10_api/clutter.shadereffect
const D2DAMonochromeEffectBase = GObject.registerClass(
  {},
  class D2DAMonochromeEffect extends Clutter.ShaderEffect {
    _init(params) {
      this._red = null;
      this._green = null;
      this._blue = null;
      this._blend = null;

      this._static = true;

      // initialize without color as a parameter

      let _color = params.color;
      delete params.color;

      super._init(params);

      // set shader color
      if (_color) this.color = _color;
    }

    preload(path) {
      // set shader source
      this._source = getMonochromeShaderSource(path);
      if (this._source && !USE_SNIPPET)
        this.set_shader_source(legacyShaderSource(this._source));

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

    vfunc_paint_target(paint_node = null, paint_context = null) {
      if (!USE_SNIPPET) this.set_uniform_value('tex', 0);

      if (paint_node && paint_context)
        super.vfunc_paint_target(paint_node, paint_context);
      else if (paint_node) super.vfunc_paint_target(paint_node);
      else super.vfunc_paint_target();
    }
  }
);

// registerClass rejects vfuncs the parent class does not have, so the
// snippet is only provided where ShaderEffect supports it
export const MonochromeEffect = USE_SNIPPET
  ? GObject.registerClass(
      {},
      class D2DAMonochromeSnippetEffect extends D2DAMonochromeEffectBase {
        vfunc_get_static_snippet() {
          return Cogl.Snippet.new(
            Cogl.SnippetHook.FRAGMENT,
            this._source,
            'cogl_color_out = d2da_effect(cogl_color_out);'
          );
        }
      }
    )
  : D2DAMonochromeEffectBase;
