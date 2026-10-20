/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-_queryDisplay2.0-or-later
 *
 */

('use strict');

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Fav from 'resource:///org/gnome/shell/ui/appFavorites.js';

import St from 'gi://St';
import Shell from 'gi://Shell';
import Graphene from 'gi://Graphene';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { tempPath, trySpawnCommandLine } from './utils.js';
import { loadFile, firstInstalledCommand, configFile } from './utils.js';

import { Timer } from './timer.js';
import { Style } from './style.js';
import { Dock } from './dock.js';
import { Services } from './services.js';
import { Integrations } from './integrations.js';
import { runTests } from './diagnostics.js';

import {
  Extension,
  gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { schemaId, SettingsKeys } from './preferences/keys.js';

const ANIM_ICON_QUALITY = 2.0;
const ANIM_INTERVAL = 15;
const ANIM_INTERVAL_PAD = 15;

export default class Dash2DockLiteExt extends Extension {
  createDock(monitorIndex = 0, config = null) {
    let d = new Dock({ extension: this });
    d.extension = this;
    d.opacity = 0; // animate
    d._monitorIndex = monitorIndex;
    d._config = config;
    d.dock();
    this.dock = d;
    this.docks.push(this.dock);
    this.listeners = [this.services, ...this.docks];
    return d;
  }

  createTheDocks() {
    if (!this._enabled || Main.sessionMode.isLocked || Main.sessionMode.isGreeter) return;
    this.docks = this.docks ?? [];
    const monitors = Main.layoutManager.monitors;
    let desired = [];
    if (Array.isArray(this._config.docks)) {
      for (const config of this._config.docks) {
        const geometry = config?.monitor;
        const monitor = monitors.find((m) => m.x === geometry?.x && m.y === geometry?.y);
        if (monitor) desired.push({ index: monitor.index, config });
      }
    } else if (this.multi_monitor_preference === 1) {
      desired = monitors.map((monitor) => ({ index: monitor.index, config: null }));
    } else if (monitors.length) {
      desired = [{ index: this._queryDisplay(0), config: null }];
    }

    // Config loading and monitor signals can both reach startup. Reusing the
    // same topology prevents duplicate docks and their animation subscribers.
    if (desired.length === this.docks.length && desired.every((entry, i) =>
      this.docks[i]._monitorIndex === entry.index && this.docks[i]._config === entry.config)) return;
    this.destroyDocks();
    for (const { index, config } of desired) this.createDock(index, config);
  }

  destroyDocks() {
    const docks = this.docks || [];
    this.docks = [];
    this.dock = null;
    this.listeners = this.services ? [this.services] : [];
    docks.forEach((dock) => {
      dock._destroyed = true;
      // Native actors may already be partially disposed after a session or
      // monitor change. Still release every other actor and timer if one
      // cleanup step fails.
      for (const method of ['undock', 'cancelAnimations', 'destroyDash', 'destroy']) {
        try {
          dock[method]();
        } catch (error) {
          console.error(`Dock ${method}: ${error.message ?? error}`);
        }
      }
    });
    this.docks = [];
    // stop forwarding display events to the destroyed docks
    this.listeners = this.services ? [this.services] : [];
  }

  recreateAllDocks(delay = 750) {
    // console.log('recreate all docks');

    // recreate only the dash
    this.docks.forEach((d) => {
      d.recreateDash();
      d._beginAnimation();
      d._debounceEndAnimation();
    });
  }

  _showMainOverviewDash(show) {
    if (show) {
      // the dash container is hidden on startup-complete
      if (Main.overview.dash.last_child) {
        Main.overview.dash.last_child.visible = true;
      }
      Main.overview.dash.visible = true;
    }
    Main.overview.dash.opacity = show ? 255 : 0;
    // Main.overview.dash._background.opacity = show ? 255 : 0;
    Main.overview.dash._background.style = show
      ? ''
      : 'background: transparent !important;';

    let box = Main.overview.dash.__box || Main.overview.dash._box;
    box.get_children().forEach((c) => {
      c.opacity = show ? 255 : 0;
      c.visible = show;
      if (c.child) {
        c.child.reactive = show;
        c.child.track_hover = show;
      }
    });

    Main.overview.dash._showAppsIcon.opacity = show ? 255 : 0;
    Main.overview.dash._showAppsIcon.child.reactive = show;
    Main.overview.dash._showAppsIcon.child.track_hover = show;
  }

  _patchMainOverviewDash() {
    // The hidden overview can redisplay before style initialization creates
    // its first icon texture. Defer sizing until normal style initialization
    // finishes; creating a child here can re-enter allocation or teardown.
    let dash = Main.overview.dash;
    let adjustIconSize = dash._adjustIconSize;
    const hadOwnAdjustment = Object.prototype.hasOwnProperty.call(dash, '_adjustIconSize');
    const wrapper = function (...args) {
      if (this._d2dlDestroying) return;
      const firstItem = this._box.get_children().find((item) =>
        item.child?._delegate?.icon && !item.animatingOut
      ) ?? this._showAppsIcon;
      const firstIcon = firstItem?.child?._delegate?.icon ?? firstItem?.icon;
      if (!firstIcon?.icon || firstItem._d2dlDestroying ||
          firstItem.child?._d2dlDestroying || firstIcon._d2dlDestroying || firstIcon._d2dlCreating ||
          (firstIcon._iconBin && firstIcon._iconBin.child !== firstIcon.icon)) return;
      return adjustIconSize.apply(this, args);
    };
    this._overviewDashAdjustment = { dash, adjustIconSize, hadOwnAdjustment, wrapper };
    dash._adjustIconSize = wrapper;
  }

  enable() {
    this._enabled = true;
    this._lifecycleId = (this._lifecycleId ?? 0) + 1;
    Main.overview.d2dl = this;

    // Use UUID to avoid conflicting with other instances of this extensions (multi user setup)
    if (!this.uuid) {
      this.uuid = GLib.get_user_name();
    }

    // three available timers
    // for persistent runs
    this._timer = new Timer('loop timer');
    this._timer.initialize(1000);

    // for animation runs
    // resolution (15) will be modified by animation-fps
    this._hiTimer = new Timer('hi-res timer');
    this._hiTimer.initialize(15);

    // for deferred or debounced runs
    this._loTimer = new Timer('lo-res timer');
    this._loTimer.initialize(750);

    this.listeners = [];
    this.scale = 1.0;
    this.icon_size = 0;
    this.icon_quality = ANIM_ICON_QUALITY;

    this._style = new Style();

    this._enableSettings();
    this._loadConfig().catch((error) => console.error(error));

    // no longer needed
    // this._disable_borders = this.border_radius > 0;

    // animations are always on - but may be muted
    if (!this._settingsKeys.getValue('animate-icons')) {
      this._settingsKeys.setValue('animate-icons', true);
    }

    Main.overview.dash.__box = Main.overview.dash._box;
    this._showMainOverviewDash(false);
    this._patchMainOverviewDash();
    this.docks = [];

    this.icon_theme = St.IconTheme.new();

    // integrations
    this.integrations = new Integrations();
    this.integrations.extension = this;
    this.integrations.enable();

    // service
    this.services = new Services();
    this.services.extension = this;
    this.services.setupFolderIcons();

    // todo follow animator and autohider protocol
    if (!Main.sessionMode.isLocked && !Main.sessionMode.isGreeter) this.services.enable();
    this._servicesUpdatedAt = null;
    this._syncServiceTimer();

    this._updateAnimationFPS();
    this._updateShrink();
    this._updateIconResolution();
    this._updateStyle();
    this._updateBlurredBackground();

    this._addEvents();
    this._queryDisplay();
    // this.startUp();

    console.log('dash2dock-lite enabled');

    // to allow dynamic imports
    this._startupSeq = this._loTimer.runOnce(() => {
      this._startupSeq = null;
      this.startUp();
    }, 250);
  }

  disable() {
    this._enabled = false;
    this._lifecycleId = (this._lifecycleId ?? 0) + 1;
    this._loTimer?.cancel(this._startupSeq);
    this._loTimer?.cancel(this._startupRefreshSeq);
    this._startupSeq = null;
    this._startupRefreshSeq = null;
    if (this._debounceStyleSeq) {
      this._hiTimer?.cancel(this._debounceStyleSeq);
      this._debounceStyleSeq = null;
    }
    if (this._iconSpacingDebounceSeq) {
      this._loTimer?.cancel(this._iconSpacingDebounceSeq);
      this._iconSpacingDebounceSeq = null;
    }

    this._removeEvents();
    this._disableSettings();

    this._updateShrink(true);
    this._restorePanelStyle();
    this._unloadConfig();

    this._showMainOverviewDash(true);
    const adjustment = this._overviewDashAdjustment;
    if (adjustment && adjustment.dash._adjustIconSize === adjustment.wrapper) {
      if (adjustment.hadOwnAdjustment) adjustment.dash._adjustIconSize = adjustment.adjustIconSize;
      else delete adjustment.dash._adjustIconSize;
    }
    this._overviewDashAdjustment = null;

    this.integrations?.disable();

    this.destroyDocks();
    this.docks = [];

    this.integrations = null;

    this.services?.disable();
    this.services = null;
    this.listeners = [];

    this._timer?.shutdown();
    this._serviceSeq = null;
    this._servicesUpdatedAt = null;
    this._hiTimer?.shutdown();
    this._loTimer?.shutdown();
    this._diagnosticTimer?.shutdown();

    this._timer = null;
    this._hiTimer = null;
    this._loTimer = null;
    this._diagnosticTimer = null;

    this._style?.unloadAll();
    this._style = null;

    this.icon_theme = null;
    this._iconTheme = null;
    this.simulated_pointer = null;
    this._inOverview = false;

    Main.overview.d2dl = null;
    console.log('dash2dock-lite disabled');
  }

  animate(settings = {}) {
    (this.docks ?? []).forEach((dock) => {
      if (settings && settings.preview) {
        dock.preview();
      }
      if (settings.refresh) {
        dock._icons = null;
        dock.layout();
      }
      dock._beginAnimation();
    });
  }

  // This is needed. Each dock has a autohider class.
  // This informs everyone to re-check overlaps
  // TODO use signals
  checkHide() {
    this.docks.forEach((dock) => {
      if (dock.autohider) {
        dock.autohider._debounceCheckHide();
      }
    });
  }

  startUp() {
    if (!this._enabled || Main.sessionMode.isLocked || Main.sessionMode.isGreeter) return;
    this.createTheDocks();
    this._loTimer.cancel(this._startupRefreshSeq);
    this._startupRefreshSeq = this._loTimer.runOnce(() => {
      this._startupRefreshSeq = null;
      if (!this._enabled) return;
      this._updateWidgetStyle();
      this.animate({ refresh: true });
      this.docks.forEach((dock) => {
        dock._beginAnimation();
        dock._debounceEndAnimation();
      });
    }, 10);
  }

  _autohiders() {
    return this.docks.map((d) => {
      return d.autohider;
    });
  }

  // to be called by docks
  _queryDisplay(currentMonitorIndex) {
    if (
      Main.layoutManager.monitors.length > 0 &&
      this.multi_monitor_preference > 0
    ) {
      // if multi-monitor ... let _updateLayout take care of updating the docks
      return currentMonitorIndex;
    }

    let idx = this.preferred_monitor || 0;
    if (idx == 0) {
      idx = Main.layoutManager.primaryIndex;
    } else if (idx == Main.layoutManager.primaryIndex) {
      idx = 0;
    }

    if (!Main.layoutManager.monitors[idx]) {
      idx = Main.layoutManager.primaryIndex;
    }

    return idx;
  }

  async _loadConfig() {
    const lifecycleId = this._lifecycleId;
    const isCurrent = () => this._enabled && lifecycleId === this._lifecycleId;
    const configuredOpener = (config) => {
      const value = config?.['file-explorer'];
      return typeof value === 'string' ? value.trim() || null : null;
    };
    const previousOpener = configuredOpener(this._config);
    let validOpenerConfig = false;
    this._config = {};
    let fn_config = configFile('config.json');
    if (fn_config.query_exists(null)) {
      try {
        const contents = await loadFile(fn_config);
        if (!isCurrent()) return;
        const config = JSON.parse(contents);
        if (config && typeof config === 'object' && !Array.isArray(config)) {
          validOpenerConfig = config['file-explorer'] === undefined ||
            typeof config['file-explorer'] === 'string';
          if (!validOpenerConfig) delete config['file-explorer'];
          this._config = config;
        }
      } catch (err) {
        console.log(err);
      }

      if (!isCurrent()) return;

      // precompute
      {
        const value = this._config['icon-size'];
        const iconSize = typeof value === 'string' || typeof value === 'number'
          ? Number(value) : NaN;
        this._config.icon_size = Number.isFinite(iconSize) && iconSize > 0 ? iconSize : null;
      }

      {
        const value = this._config['speed-up'];
        const speed = typeof value === 'string' || typeof value === 'number'
          ? Number(value) : NaN;
        this._config.speed_up = Number.isFinite(speed) ? Math.max(0.5, Math.min(4, speed)) : 1;
      }

      // the config may override the file explorer used by these items
      this.services?.setupFolderIcons();
    }

    let fn_icons = configFile('icons.json');
    if (fn_icons.query_exists(null)) {
      try {
        const contents = await loadFile(fn_icons);
        if (!isCurrent()) return;
        let json = JSON.parse(contents);
        if (json['icons']) {
          this.icon_map = json['icons'];
          this.icon_map_cache = {};
          Object.keys(this.icon_map).forEach((k) => {
            let path = this.icon_map[k];
            if (typeof path === 'string' && path.toLowerCase().endsWith('.svg')) {
              let file = configFile(path);
              if (file.query_exists(null)) {
                console.log(`loading icon ${file.get_path()}`);
                this.icon_map_cache[k] = new Gio.FileIcon({ file: file });
              }
            }
          });
        }
        if (json['apps']) {
          this.app_map = json['apps'];
          this.app_map_cache = {};
          Object.keys(this.app_map).forEach((k) => {
            let path = this.app_map[k];
            if (typeof path === 'string' && path.toLowerCase().endsWith('.svg')) {
              let file = configFile(path);
              if (file.query_exists(null)) {
                console.log(`loading icon ${file.get_path()}`);
                this.app_map_cache[k] = new Gio.FileIcon({ file: file });
              }
            }
          });
        }
      } catch (err) {
        console.log(err);
      }
    }

    if (!isCurrent()) return;

    let fn_style = configFile('style.css');
    if (fn_style.query_exists(null)) {
      let ctx = St.ThemeContext.get_for_stage(global.stage);
      let theme = ctx.get_theme();
      theme.load_stylesheet(fn_style);
      this._configStylesheet = fn_style;
    }

    if (this.docks?.length && !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter) {
      const previousDocks = this.docks;
      if (this._config.docks) {
        this.createTheDocks();
      }
      // Rewriting a launcher file does not update DesktopAppInfo objects
      // already held by custom icons or their menus. New topology already
      // uses the loaded opener; existing dashes need fresh launcher actors.
      if (validOpenerConfig && previousOpener !== configuredOpener(this._config) &&
          this.docks === previousDocks) this.recreateAllDocks();
      this.animate({ refresh: true });
    }
  }

  _unloadConfig() {
    this.icon_map = {};
    this.icon_map_cache = {};
    this.app_map = {};
    this.app_map_cache = {};

    if (this._configStylesheet) {
      let ctx = St.ThemeContext.get_for_stage(global.stage);
      let theme = ctx.get_theme();
      theme.unload_stylesheet(this._configStylesheet);
      this._configStylesheet = null;
    }
  }

  _enableSettings() {
    try {
      this._interfaceSettings = new Gio.Settings({
        schema_id: 'org.gnome.desktop.interface',
      });
      this._interfaceSettings.connectObject(
        'changed::color-scheme',
        () => {
          // apply light/dark themeing
        },
        this
      );
    } catch (err) {
      console.log(err);
      this._interfaceSettings = null;
    }

    this._settings = this.getSettings(schemaId);
    this._settingsKeys = SettingsKeys();

    this._settingsKeys.connectSettings(this._settings, (name, value) => {
      let n = name.replace(/-/g, '_');
      this[n] = value;

      // console.log(`${n} ${value}`);

      switch (name) {
        case 'msg-to-ext': {
          if (value.length) {
            try {
              eval(value);
            } catch (err) {
              console.log(err);
            }
            this._settings.set_string('msg-to-ext', '');
          }
          break;
        }
        case 'lamp-app-animation': {
          this.integrations.hookCompiz();
          break;
        }
        case 'animation-fps': {
          this._updateAnimationFPS();
          break;
        }
        case 'debug-visual':
        case 'multi-monitor-filter':
        case 'downloads-icon-rotate-labels':
        case 'overview-transparent-background':
        case 'overview-transparent-topbar-background':
          this.animate();
          break;
        case 'animate-icons-unmute':
          this.animate({ refresh: true });
          break;
        case 'hide-labels': {
          for (const dock of this.docks ?? []) {
            for (const icon of dock._icons ?? []) {
              if (value) {
                icon._label?.remove_all_transitions();
                icon._label?.hide();
              } else if (icon === dock._nearestIcon) {
                icon.showLabel?.();
              }
            }
          }
          this.animate();
          break;
        }
        case 'mounted-icon': {
          this.services.checkMounts();
          this.services._commitMounts();
          this.animate({ refresh: true });
          break;
        }
        case 'peek-hidden-icons': {
          this.animate();
          break;
        }
        case 'animation-magnify':
        case 'animation-spread':
        case 'animation-rise':
        case 'animation-rise-curve':
        case 'animation-bounce-height': {
          if (this.animate_icons) {
            this.animate({ preview: true });
          }
          break;
        }
        case 'notification-badge-size':
        case 'notification-badge-color':
        case 'notification-badge-style':
        case 'running-indicator-size':
        case 'running-indicator-color':
        case 'running-indicator-style': {
          this.animate();
          break;
        }
        case 'clock-style':
        case 'calendar-style':
        case 'drawing-dark-color':
        case 'drawing-light-color':
        case 'drawing-accent-color':
        case 'drawing-dark-foreground':
        case 'drawing-light-foreground':
        case 'drawing-secondary-color':
          this._updateWidgetStyle();
          break;
        case 'max-recent-items':
          this.services._debounceCheckDownloads();
          break;
        case 'apps-icon':
        case 'apps-icon-front':
        case 'calendar-icon':
        case 'clock-icon':
        case 'favorites-only': {
          this._syncServiceTimer();
          this.animate({ refresh: true });
          break;
        }
        case 'downloads-path':
          this.services.setupDownloads();
          this._syncServiceTimer();
          break;
        // problematic settings needing animator restart
        case 'dock-location':
          this.recreateAllDocks();
          this.animate({ preview: true });
          break;
        case 'icon-resolution': {
          this._updateIconResolution();
          this._updateStyle();
          this._updateLayout();
          this._updateIconSpacing();
          this.animate();
          break;
        }
        case 'icon-effect': {
          this.docks.forEach((dock) => {
            dock._updateIconEffect();
          });
          break;
        }
        case 'icon-effect-color': {
          this.docks.forEach((dock) => {
            dock._updateIconEffectColor(this.icon_effect_color);
          });
          this.animate();
          break;
        }
        case 'icon-spacing': {
          this._updateIconSpacing();
          break;
        }
        case 'multi-monitor-preference':
          this._updateMultiMonitorPreference();
          break;
        case 'icon-size': {
          this._updateShrink();
          this._updateLayout();
          this.animate({ refresh: true });
          break;
        }
        case 'preferred-monitor': {
          this._updateLayout();
          this.animate({ refresh: true });
          break;
        }
        case 'autohide-dodge':
        case 'autohide-dash': {
          this._updateAutohide();
          break;
        }
        case 'dock-padding':
        case 'edge-distance': {
          this.animate();
          break;
        }
        case 'shrink-icons': {
          this._updateShrink();
          this.animate();
          break;
        }
        case 'border-radius':
          this._debouncedUpdateStyle();
          this.animate();
          break;
        case 'separator-thickness':
          this._updateStyle();
          this.recreateAllDocks();
          this.animate({ preview: true });
          break;
        case 'icon-border-color':
        case 'icon-border-thickness':
        case 'icon-border-radius':
        case 'icon-background-color':
        case 'separator-color':
        case 'border-color':
        case 'border-thickness':
        case 'customize-topbar':
        case 'icon-shadow':
        case 'topbar-border-color':
        case 'topbar-border-thickness':
        case 'topbar-background-color':
        case 'topbar-foreground-color':
        case 'customize-label':
        case 'label-border-radius':
        case 'label-border-color':
        case 'label-border-thickness':
        case 'label-background-color':
        case 'label-foreground-color':
        case 'panel-mode': {
          this._updateStyle();
          this._updateLayout();
          this.animate();
          break;
        }
        // case 'topbar-background-color':
        // case 'topbar-blur-background':
        case 'background-color':
        case 'blur-resolution':
        case 'blur-background':
          this.integrations.hookBms();
          this._updateBlurredBackground();
          this._updateStyle();
          this._updateLayout();
          this.animate();
          break;
        case 'pressure-sense': {
          break;
        }
        case 'downloads-icon':
        case 'documents-icon':
        case 'trash-icon': {
          if (name === 'downloads-icon') this.services?.setupDownloads();
          if (name === 'trash-icon') this.services?.setupTrash();
          this._syncServiceTimer();
          this._updateLayout();
          this.animate({ refresh: true });
          break;
        }
      }
    });

    Object.keys(this._settingsKeys._keys).forEach((k) => {
      let key = this._settingsKeys.getKey(k);
      let name = k.replace(/-/g, '_');
      this[name] = key.value;
      // console.log(`${name} = ${key.value}`);
      if (key.options) {
        this[`${name}_options`] = key.options;
      }
    });
  }

  _disableSettings() {
    this._settingsKeys?.disconnectSettings();
    this._settingsKeys = null;
    this._settings = null;

    if (this._interfaceSettings) {
      this._interfaceSettings.disconnectObject(this);
      this._interfaceSettings = null;
    }
  }

  _addEvents() {
    this._appSystem = Shell.AppSystem.get_default();

    this._appSystem.connectObject(
      'installed-changed',
      () => {
        this._onAppsChanged();
      },
      'app-state-changed',
      () => {
        this._onAppsChanged();
      },
      this
    );

    this._appFavorites = Fav.getAppFavorites();
    this._appFavorites.connectObject(
      'changed',
      () => {
        this._onAppsChanged();
      },
      this
    );

    Main.sessionMode.connectObject(
      'updated',
      this._onSessionUpdated.bind(this),
      this
    );

    Main.extensionManager.connectObject(
      'extensions-loaded',
      (manager) => {
        this.integrations.hookCompiz(true);
        this.integrations.hookBms(true);
      },
      'extension-state-changed',
      (manager, extension) => {
        switch (extension.uuid) {
          case 'compiz-alike-magic-lamp-effect@hermes83.github.com':
            this.integrations.hookCompiz(extension.state == 1);
            break;
          case 'blur-my-shell@aunetx':
            this.integrations.hookBms(extension.state == 1);
            if (extension.state == 1) {
              this.animate();
            }
            break;
        }
      },
      this
    );

    Main.layoutManager.connectObject(
      'startup-complete',
      () => {
        if (Main.overview.dash.last_child) Main.overview.dash.last_child.visible = false;
        Main.overview.dash.opacity = 0;
        // fix for topbar not blurring
        this._updateBlurredBackground();
      },
      // this.startUp.bind(this),
      'monitors-changed',
      () => {
        this._updateMultiMonitorPreference();
      },
      this
    );

    global.display.connectObject(
      'notify::focus-window',
      this._onFocusWindow.bind(this),
      'in-fullscreen-changed',
      this._onFullScreen.bind(this),
      'restacked',
      this._onRestacked.bind(this),
      this
    );

    // global.stage.connectObject(
    //   'key-press-event',
    //   this._onKeyPressed.bind(this),
    //   this
    // );

    Main.overview.connectObject(
      'showing',
      this._onOverviewShowing.bind(this),
      'hidden',
      this._onOverviewHidden.bind(this),
      this
    );

    St.TextureCache.get_default().connectObject(
      'icon-theme-changed',
      this._onIconThemeChanged.bind(this),
      this
    );

    St.ThemeContext.get_for_stage(global.stage).connectObject(
      'notify::scale-factor',
      this.recreateAllDocks.bind(this),
      this
    );

  }

  _removeEvents() {
    this._appSystem?.disconnectObject(this);
    this._appSystem = null;
    this._appFavorites?.disconnectObject(this);
    this._appFavorites = null;
    Main.extensionManager.disconnectObject(this);
    Main.messageTray.disconnectObject(this);
    Main.overview.disconnectObject(this);
    Main.layoutManager.disconnectObject(this);
    Main.sessionMode.disconnectObject(this);
    global.display.disconnectObject(this);
    global.stage.disconnectObject(this);
    St.TextureCache.get_default().disconnectObject(this);
    St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
  }

  _onKeyPressed(evt) {
    this.docks.forEach((d) => {
      if (d._list && d._list.visible) {
        d._list.slideOut();
      }
    });
    return Clutter.EVENT_PROPAGATE;
  }

  _onIconThemeChanged() {
    if (this.services?._enabled) {
      this.services.disable();
      this.services.enable();
      this._servicesUpdatedAt = null;
      this._syncServiceTimer();
    }
    this.icon_theme = St.IconTheme.new();
    this._iconTheme = this.icon_theme;
    this._updateStyle();
    this.recreateAllDocks();
  }

  _onFocusWindow() {
    let listeners = [...this.listeners];
    listeners.forEach((l) => {
      if (l._onFocusWindow) l._onFocusWindow();
    });
  }

  _onFullScreen(display) {
    let listeners = [...this.listeners];
    listeners.forEach((l) => {
      if (l._onFullScreen) l._onFullScreen();
    });
    // console.log(`_onFullScreen ${f}`);
  }

  _onRestacked() {
    let listeners = [...this.listeners];
    listeners.forEach((l) => {
      if (l._onRestacked) l._onRestacked();
    });
  }

  _onAppsChanged() {
    let listeners = [...this.listeners];
    listeners.forEach((l) => {
      if (l._onAppsChanged) l._onAppsChanged();
    });
  }

  _onOverviewShowing() {
    this._showMainOverviewDash(false);
    //this._loTimer.runOnce(() => { Main.overview.dash.set_height(1); }, 50);
    this._inOverview = true;
    this._autohiders().forEach((autohider) => {
      autohider._debounceCheckHide();
    });
    this.animate();
    this.docks.forEach((dock) => {
      dock._updateTransparenies();
    });
  }

  _onOverviewHidden() {
    //Main.overview.dash.set_height(1);
    this._inOverview = false;
    this._autohiders().forEach((autohider) => {
      autohider._debounceCheckHide();
    });
    this.docks.forEach((dock) => {
      dock._updateTransparenies();
    });
  }

  _onSessionUpdated() {
    if (!this._enabled) return;
    if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
      this._loTimer.cancel(this._startupSeq);
      this._loTimer.cancel(this._startupRefreshSeq);
      this._startupSeq = null;
      this._startupRefreshSeq = null;
      this._restorePanelStyle();
      this._timer?.cancel(this._serviceSeq);
      this._timer?.stop();
      this._serviceSeq = null;
      this._servicesUpdatedAt = null;
      this.services?.disable();
      this.destroyDocks();
      return;
    }
    if (this.services && !this.services._enabled) this.services.enable();
    this._syncServiceTimer();
    this.startUp();
    this.animate();
  }

  _onCheckServices() {
    if (!this.services) return;
    const now = GLib.get_monotonic_time();
    const elapsed = this._servicesUpdatedAt === null || this._servicesUpdatedAt === undefined
      ? 0 : Math.max(0, (now - this._servicesUpdatedAt) / 1000);
    this._servicesUpdatedAt = now;
    this.services.update(elapsed);
  }

  _syncServiceTimer() {
    if (!this._timer) return;
    this._timer.cancel(this._serviceSeq);
    this._timer.stop();
    this._serviceSeq = null;
    if (!this._enabled || !this.services ||
        Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
      this._servicesUpdatedAt = null;
      return;
    }
    this._onCheckServices();
    const delay = this.services.nextUpdateDelay();
    if (delay === null) {
      this._servicesUpdatedAt = null;
      return;
    }
    // The service timer sleeps until actual work is due (normally a minute),
    // rather than waking repeatedly to check counters for disabled features.
    this._timer.start(delay);
    this._serviceSeq = this._timer.runOnce(() => {
      this._serviceSeq = null;
      this._syncServiceTimer();
    }, delay, 'services');
  }

  _updateWidgetStyle() {
    this._widgetStyle = {
      dark_color: this.drawing_dark_color,
      light_color: this.drawing_light_color,
      accent_color: this.drawing_accent_color,
      dark_foreground: this.drawing_dark_foreground,
      light_foreground: this.drawing_light_foreground,
      secondary_color: this.drawing_secondary_color,
      clock_style: this.clock_style,
    };
    (this.docks ?? []).forEach((dock) => {
      let widgets = [dock._clock, dock._calendar];
      widgets.forEach((w) => {
        if (w) {
          w.settings = this._widgetStyle;
          w.redraw();
        }
      });
    });
    this.animate();
  }

  _updateBlurredBackground() {}

  _updatePanelTransparency(transparent) {
    if (!transparent || !Main.panel) {
      this._restorePanelStyle();
      return;
    }
    const panel = Main.panel;
    const patch = this._panelStylePatch;
    if (patch && patch.panel === panel && panel.style === patch.applied) return;
    this._restorePanelStyle();
    const previous = panel.style;
    const baseStyle = previous?.trim() ?? '';
    const prefix = baseStyle ? `${baseStyle}${baseStyle.endsWith(';') ? '' : ';'} ` : '';
    const applied = `${prefix}border: 0px; background: transparent;`;
    this._panelStylePatch = { panel, previous, applied };
    panel.style = applied;
  }

  _restorePanelStyle() {
    const patch = this._panelStylePatch;
    this._panelStylePatch = null;
    try {
      if (patch && patch.panel.style === patch.applied) patch.panel.style = patch.previous;
    } catch (error) {
      console.warn(`Unable to restore panel style: ${error.message}`);
    }
  }

  _getPreferredColorScheme() {
    let scheme = 'light';

    if (this._interfaceSettings) {
      try {
        scheme = this._interfaceSettings.get_string('color-scheme') || 'light';
      } catch (err) {
        console.log(err);
      }
    } else if (Main.panel?.has_style_pseudo_class?.('dark')) {
      return 'dark';
    }

    if (scheme === 'prefer-dark') {
      return 'dark';
    }

    if (scheme === 'default' && Main.panel?.has_style_pseudo_class?.('dark')) {
      return 'dark';
    }

    return 'light';
  }

  _updateAnimationFPS() {
    (this.docks ?? []).forEach((dock) => {
      dock.cancelAnimations();
    });
    this.animationInterval =
      ANIM_INTERVAL + (this.animation_fps || 0) * ANIM_INTERVAL_PAD;
    this._hiTimer?.shutdown();
    this._hiTimer?.initialize(this.animationInterval);
    if (this._enabled) this.animate();
  }

  _updateShrink(disable) {
    if (this.shrink_icons && !disable) {
      this.scale = 0.8; // * rescale_modifier;
    } else {
      this.scale = 1.0; // * rescale_modifier;
    }
    if (this.animate_icons) {
      // this._animators().forEach((animator) => {
      //   animator.relayout();
      // });
    }
  }

  _updateMultiMonitorPreference() {
    if (!this._enabled) return;
    // console.log('update monitors');
    this.destroyDocks();
    this._loTimer.cancel(this._startupSeq);
    this._loTimer.cancel(this._startupRefreshSeq);
    this._startupRefreshSeq = null;
    this._startupSeq = this._loTimer.runOnce(() => {
      this._startupSeq = null;
      this.startUp();
    }, 500);
  }

  _updateIconResolution(disable) {
    this.icon_quality = 1 + [2, 0, 1, 2, 3][this.icon_resolution || 0];
  }

  _debouncedUpdateStyle(disable) {
    if (disable) return;
    if (!this._debounceStyleSeq) {
      this._debounceStyleSeq = this._hiTimer.runDebounced(
        () => {
          this._updateStyle();
        },
        500,
        'debounceStyle'
      );
    } else {
      this._hiTimer.runDebounced(this._debounceStyleSeq);
    }
  }

  _updateStyle(disable) {
    let styles = [];

    let rads = [0, 8, 16, 20, 24, 28, 32, 36, 40, 42];

    // icons-shadow
    if (this.icon_shadow) {
      styles.push(
        '#d2daIcon, #DockItemList StIcon {icon-shadow: rgba(0, 0, 0, 0.32) 0 2px 6px;}'
      );
      // styles.push(
      //   '#dash StIcon:hover, #DockItemList StIcon:hover {icon-shadow: rgba(0, 0, 0, 0.24) 0 2px 8px;}'
      // );
    }

    // dash
    {
      let r = rads[Math.floor(this.border_radius)];
      let ss = [];
      if (this.panel_mode) {
        r = 0;
      }
      ss.push(`border-radius: ${r}px;`);
      this.computed_border_radius = r;
      let rgba = this._style.rgba(this.background_color);
      ss.push(`background: rgba(${rgba});`);
      styles.push(`#d2daBackground { ${ss.join(' ')}}`);
    }

    // icon backgrounds
    {
      let ss = [];
      ss.push(`margin: 2px;`);

      let r = rads[Math.floor(this.icon_border_radius)];
      ss.push(`border-radius: ${r}px;`);

      {
        let rgba = this._style.rgba(this.icon_background_color);
        ss.push(`background: rgba(${rgba});`);
      }

      // {
      //   let rgba = this._style.rgba(this.icon_border_color);
      //   let t = this.icon_border_thickness;
      //   ss.push(`border: ${t}px rgba(${rgba});`);
      // }

      // styles.push(`.icon-focused { ${ss.join(' ')}}`);
    }

    // dash label
    if (this.customize_label) {
      let rads = [0, 2, 6, 10, 12, 16, 20];
      let r = rads[Math.floor(this.label_border_radius)];
      let ss = [];
      ss.push(`border-radius: ${r}px;`);

      {
        let rgba = this._style.rgba(this.label_background_color);
        ss.push(`background: rgba(${rgba});`);
      }

      {
        let rgba = this._style.rgba(this.label_border_color);
        let t = this.label_border_thickness;
        ss.push(`border: ${t}px rgba(${rgba});`);
      }

      {
        let rgba = this._style.rgba(this.label_foreground_color);
        ss.push(`color: rgba(${rgba});`);
      }

      // ss.push(`padding: 8px;`);
      styles.push(`.dash-label { ${ss.join(' ')}}`);
    }

    // topbar
    if (this.customize_topbar) {
      let ss = [];
      // border
      if (this.topbar_border_thickness) {
        let rgba = this._style.rgba(this.topbar_border_color);
        ss.push(
          `border: ${this.topbar_border_thickness}px solid rgba(${rgba}); border-top: 0px; border-left: 0px; border-right: 0px;`
        );
      }

      // background
      // ss.push('background: transparent;');
      {
        let rgba = this._style.rgba(this.topbar_background_color);
        ss.push(`background: rgba(${rgba});`);
      }
      styles.push(`#panelBox #panel {${ss.join(' ')}}`);
      ss = [];

      // foreground
      if (this.topbar_foreground_color && this.topbar_foreground_color[3] > 0) {
        let rgba = this._style.rgba(this.topbar_foreground_color);
        styles.push(
          `.panel-status-indicator-icon, #panelBox #panel * { color: rgba(${rgba}) }`
        );
      } else {
        let rgba = this._style.rgba([0, 0, 0, 1]);
        let bg = this.topbar_background_color;
        if (0.3 * bg[0] + 0.59 * bg[1] + 0.11 * bg[2] < 0.5) {
          rgba = this._style.rgba([1, 1, 1, 1]);
        }
        styles.push(
          `.panel-status-indicator-icon, #panelBox #panel * { color: rgba(${rgba}) }`
        );
      }
    }

    if (this.separator_thickness) {
      let rgba = this._style.rgba(this.separator_color);
      styles.push(`.dash-separator { background-color: rgba(${rgba}); }`);
    }

    this._style.build('custom-d2dl', styles);

    this._updateBorderStyle();
  }

  _updateBorderStyle() {
    this._backgroundStyle = '';

    // apply border as inline style... otherwise buggy and won't show at startup
    // also add deferred bordering... otherwise rounder borders show with artifacts
    // no longer necessary<<<?

    let border_style = '';
    if (this.border_thickness /* && !this._disable_borders */) {
      let rgba = this._style.rgba(this.border_color);
      border_style = `border: ${this.border_thickness}px solid rgba(${rgba}) !important;`;
    }

    let panel_borders = '';
    if (this.panel_mode) {
      panel_borders =
        'border-left: 0px; border-right: 0px; border-bottom: 0px;';
      // vertical border-left/right doesn;t seem to work
      if (this._position == 'left') {
        panel_borders =
          'border-left: 0px; border-top: 0px; border-bottom: 0px;';
      }
      if (this._position == 'right') {
        panel_borders =
          'border-top: 0px; border-right: 0px; border-bottom: 0px;';
      }
    }

    this._backgroundStyle = `${border_style} ${panel_borders}`;
  }

  _updateLayout(disable) {
    this.docks.forEach((dock) => {
      dock.layout();
    });
  }

  _updateIconSpacing(disable) {
    if (!this._iconSpacingDebounceSeq) {
      this._iconSpacingDebounceSeq = this._loTimer.runDebounced(() => {
        this.animate({ refresh: true });
      }, 750);
    } else {
      this._loTimer.runDebounced(this._iconSpacingDebounceSeq);
    }
  }

  _updateAutohide(disable) {
    if (this.autohide_dash && !disable) {
      this._autohiders().forEach((autohider) => {
        autohider.enable();
      });
    } else {
      this._autohiders().forEach((autohider) => {
        autohider.disable();
      });
    }

    if (!disable) {
      this.docks.forEach((dock) => {
        dock.removeFromChrome();
        dock.addToChrome();
      });
    }

    if (this.animate_icons && !disable) {
      this.animate();
    }
  }

  runDiagnostics() {
    if (!this._diagnosticTimer) {
      this._diagnosticTimer = new Timer('diagnostics');
      this._diagnosticTimer.initialize(50);
    }
    runTests(this, this._settingsKeys);
  }

  dumpTimers() {
    this._timer.dumpSubscribers();
    this._hiTimer.dumpSubscribers();
    this._loTimer.dumpSubscribers();
    if (this._diagnosticTimer) {
      this._diagnosticTimer.dumpSubscribers();
    }
  }

  lookup_icon_from_names(names) {
    // no icon theme to ask (Gnome 42 without a GTK display)
    if (!this.icon_theme) {
      return names[0] ?? null;
    }
    for (let i = 0; i < names.length; i++) {
      if (this.icon_theme.lookup_icon(names[i], 16, 1)) {
        return names[i];
      }
    }
    return null;
  }

  file_explorer() {
    // --select would open the parent folder instead
    let candidates = ['nautilus', 'xdg-open', 'gio open'];
    if (this._config && this._config['file-explorer']) {
      candidates.unshift(this._config['file-explorer']);
    }
    return firstInstalledCommand(candidates);
  }

  // opens files and URIs with their default application
  file_opener() {
    return firstInstalledCommand(['xdg-open', 'gio open']);
  }
}
