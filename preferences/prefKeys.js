// const Gdk = imports.gi.Gdk;
// const GLib = imports.gi.GLib;

import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';

export let PrefKeys = class {
  constructor() {
    this._keys = {};
    this._settingsListeners = [];
    this._builderListeners = [];
    this._updatingWidgets = 0;
  }

  setKeys(keys) {
    Object.keys(keys).forEach((name) => {
      let key = keys[name];
      this.setKey(
        name,
        key.default_value,
        key.widget_type,
        key.key_maps,
        key.test,
        key.callback,
        key.options,
        key.themed
      );
    });
  }

  setKey(
    name,
    default_value,
    widget_type,
    maps,
    test,
    callback,
    options,
    themed
  ) {
    this._keys[name] = {
      name,
      default_value,
      widget_type,
      value: default_value,
      maps: maps,
      test: test,
      callback,
      options,
      object: null,
      themed: themed || false,
    };
  }

  setValue(name, value) {
    let settings = this._settings;
    let keys = this._keys;
    if (settings) {
      let key = keys[name];
      let accepted = true;
      switch (key.widget_type) {
        case 'switch': {
          accepted = settings.set_boolean(name, value);
          break;
        }
        case 'dropdown': {
          accepted = settings.set_int(name, value);
          break;
        }
        case 'scale': {
          accepted = settings.set_double(name, value);
          break;
        }
        case 'color': {
          accepted = settings.set_value(name, new GLib.Variant('(dddd)', value));
          break;
        }
        case 'string': {
          accepted = settings.set_string(name, value);
          break;
        }
        case 'json_array': {
          accepted = settings.set_string(name, JSON.stringify(value));
          break;
        }
      }
      if (accepted === false) {
        this.updateWidget(name);
        return false;
      }
    }

    this._keys[name].value = value;
    if (this._keys[name].callback) {
      this._keys[name].callback(this._keys[name].value);
    }
    return true;
  }

  getKey(name) {
    return this._keys[name];
  }

  getValue(name) {
    let value = this._keys[name].value;
    return value;
  }

  reset(name) {
    this.setValue(name, this._keys[name].default_value);
  }

  resetAll() {
    Object.keys(this._keys).forEach((k) => {
      this.reset(k);
    });
  }

  keys() {
    return this._keys;
  }

  _readValue(settings, key) {
    switch (key.widget_type) {
      case 'json_array': {
        try {
          const value = JSON.parse(settings.get_string(key.name));
          return Array.isArray(value) ? value : [];
        } catch (err) {
          return [];
        }
      }
      case 'switch':
        return settings.get_boolean(key.name);
      case 'dropdown':
        return settings.get_int(key.name);
      case 'scale':
        return settings.get_double(key.name);
      case 'string':
        return settings.get_string(key.name);
      case 'color': {
        const value = settings.get_value(key.name).deepUnpack();
        return value.length === 4 ? value : [1, 1, 1, 0];
      }
      default:
        return key.value;
    }
  }

  updateWidget(name, update = null) {
    const key = this._keys[name];
    if (!key.object) return;

    // Model replacements and settings changes also emit widget signals.
    // They must never write intermediate selections back to GSettings.
    this._updatingWidgets++;
    try {
      if (update) {
        update(key.object);
        return;
      }
      switch (key.widget_type) {
        case 'switch':
          key.object.set_active(key.value);
          break;
        case 'dropdown': {
          const mapped = Object.entries(key.maps ?? {}).find(
            ([, value]) => value === key.value
          );
          key.object.set_selected(mapped ? Number(mapped[0]) : key.value);
          break;
        }
        case 'scale':
          key.object.set_value(key.value);
          break;
        case 'string':
          key.object.set_text?.(key.value);
          break;
        case 'color':
          key.object.set_rgba(
            new Gdk.RGBA({
              red: key.value[0],
              green: key.value[1],
              blue: key.value[2],
              alpha: key.value[3],
            })
          );
          break;
      }
    } finally {
      this._updatingWidgets--;
    }
  }

  connectSettings(settings, callback) {
    this.disconnectSettings();
    this._settings = settings;
    Object.values(this._keys).forEach((key) => {
      key.value = this._readValue(settings, key);
      this.updateWidget(key.name);
      this._settingsListeners.push(
        settings.connect(`changed::${key.name}`, () => {
          key.value = this._readValue(settings, key);
          this.updateWidget(key.name);
          if (callback) callback(key.name, key.value);
        })
      );
    });
  }

  disconnectSettings() {
    this._settingsListeners.forEach((id) => this._settings.disconnect(id));
    this._settingsListeners = [];
    this._settings = null;
  }

  connectBuilder(builder) {
    this.disconnectBuilder();
    this._builder = builder;
    Object.values(this._keys).forEach((key) => {
      key.object = builder.get_object(key.name);
      if (!key.object) return;

      this.updateWidget(key.name);
      let signalId = null;
      const setValue = (value) => {
        if (!this._updatingWidgets) this.setValue(key.name, value);
      };
      switch (key.widget_type) {
        case 'switch':
          signalId = key.object.connect('notify::active', (w) => {
            setValue(w.get_active());
          });
          break;
        case 'dropdown':
          signalId = key.object.connect('notify::selected-item', (w) => {
            const index = w.get_selected();
            // GTK_INVALID_LIST_POSITION occurs while replacing a model.
            if (index === 0xffffffff) return;
            setValue(key.maps && index in key.maps ? key.maps[index] : index);
          });
          break;
        case 'scale':
          signalId = key.object.connect('value-changed', (w) => {
            setValue(w.get_value());
          });
          break;
        case 'color':
          signalId = key.object.connect('color-set', (w) => {
            const rgba = w.get_rgba();
            setValue([rgba.red, rgba.green, rgba.blue, rgba.alpha]);
          });
          break;
        case 'string':
          if (key.object.get_text) {
            signalId = key.object.connect('changed', (w) => setValue(w.get_text()));
          }
          break;
        case 'button':
          signalId = key.object.connect('clicked', () => key.callback?.());
          break;
      }
      if (signalId !== null) {
        this._builderListeners.push({ source: key.object, signal_id: signalId });
      }
    });
  }

  disconnectBuilder() {
    this._builderListeners.forEach(({ source, signal_id }) => {
      source.disconnect(signal_id);
    });
    this._builderListeners = [];
    this._builder = null;
    Object.values(this._keys).forEach((key) => {
      key.object = null;
    });
  }

  destroy() {
    this.disconnectSettings();
    this.disconnectBuilder();
  }
};
