'use strict';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { trySpawnCommandLine } from './utils.js';

// import { trySpawnCommandLine } from 'resource:///org/gnome/shell/misc/util.js';

import { Dash } from 'resource:///org/gnome/shell/ui/dash.js';

import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {
  DashIcon,
  DashItemContainer,
} from 'resource:///org/gnome/shell/ui/dash.js';

import { DockPosition } from './dock.js';

class DockItemMenu extends PopupMenu.PopupMenu {
  constructor(sourceActor, side = St.Side.TOP, params = {}) {
    if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL) {
      if (side === St.Side.LEFT) side = St.Side.RIGHT;
      else if (side === St.Side.RIGHT) side = St.Side.LEFT;
    }

    super(sourceActor, 0.5, side);

    let { desktopApp } = params;
    if (!desktopApp) return;

    this.desktopApp = desktopApp;

    this._newWindowItem = this.addAction('Open Window', () => {
      let workspaceManager = global.workspace_manager;
      let workspaceIndex = workspaceManager.get_active_workspace_index();
      let ctx = global.create_app_launch_context(0, workspaceIndex);
      desktopApp.launch([], ctx);
      this._onActivate();
    });

    (desktopApp.list_actions?.() ?? []).forEach((action) => {
      let name = desktopApp.get_action_name(action);
      this.addAction(name, () => {
        let workspaceManager = global.workspace_manager;
        let workspaceIndex = workspaceManager.get_active_workspace_index();
        let ctx = global.create_app_launch_context(0, workspaceIndex);
        desktopApp.launch_action(action, ctx);
        this.item?.dock?.extension.animate({ refresh: true });
      });
    });
  }

  _onActivate() {}

  popup() {
    if (this._destroyed) return;
    try {
      if (BoxPointer.PopupAnimation?.FULL !== undefined) {
        this.open(BoxPointer.PopupAnimation.FULL);
      } else {
        this.open({ animate: true });
      }
    } catch {
      this.open({ animate: true });
    }
    // removed in Gnome 50
    this._menuManager?.ignoreRelease?.();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    super.destroy();
    this.item = null;
    this.desktopApp = null;
    this._newWindowItem = null;
    this._menuManager = null;
    this._onActivate = () => {};
  }
}

const DockItemOverlay = GObject.registerClass(
  {},
  class DockItemOverlay extends St.Widget {
    _init(renderer, params) {
      super._init({
        name: 'DockItemContainer',
        ...params,
      });

      this.renderer = renderer;
      if (renderer) {
        this.add_child(renderer);
      }
    }
  }
);

export const DockItemDotsOverlay = GObject.registerClass(
  {},
  class DockItemDotsOverlay extends DockItemOverlay {
    update(icon, data) {
      let renderer = this.renderer;
      let { appCount, position, vertical, extension, dock } = data;

      renderer.width = dock._iconSizeScaledDown || icon._icon.width;
      renderer.height = dock._iconSizeScaledDown || icon._icon.height;
      renderer.pivot_point = icon._icon.pivot_point;

      let canvasScale = renderer.width / renderer._canvas.width;

      // scaling fix
      let scale = dock._monitor.geometry_scale || 1;
      canvasScale *= scale;
      renderer._canvas.set_scale(canvasScale, canvasScale);

      let offsetX = 0;
      let offsetY = renderer.height * 0.125 * scale;
      if (vertical) {
        offsetX = -offsetY;
        if (position == DockPosition.RIGHT) {
          offsetX = offsetY;
        }
        offsetY = 0;
      } else {
        if (position == DockPosition.TOP) {
          offsetY = -offsetY;
        }
      }

      // renderer.translation_x = icon._icon.translation_x + offsetX;
      // renderer.translation_y = icon._icon.translation_y + offsetY;

      renderer.translation_x = offsetX;
      renderer.translation_y = offsetY;

      let options = extension.running_indicator_style_options;
      let running_indicator_style = options[extension.running_indicator_style];
      let running_indicator_color = extension.running_indicator_color;

      renderer.set_state({
        count: appCount,
        color: running_indicator_color || [1, 1, 1, 1],
        style: running_indicator_style || 'default',
        size: extension.running_indicator_size || 0,
        rotate: vertical
          ? position == DockPosition.RIGHT
            ? -90
            : 90
          : position == DockPosition.TOP
            ? 180
            : 0,
      });
    }
  }
);

export const DockItemBadgeOverlay = GObject.registerClass(
  {},
  class DockItemBadgeOverlay extends DockItemOverlay {
    update(icon, data) {
      let renderer = this.renderer;
      let { noticesCount, position, vertical, extension, scale } = data;

      renderer.width = icon._icon.width;
      renderer.height = icon._icon.height;
      let canvasScale = renderer.width / renderer._canvas.width;
      renderer._canvas.set_scale(canvasScale, canvasScale);

      let options = extension.notification_badge_style_options;
      let notification_badge_style =
        options[extension.notification_badge_style];
      let notification_badge_color = extension.notification_badge_color;

      renderer.translation_x = renderer.width / 1.5;
      // renderer.translation_y = icon._icon.translation_y;

      renderer.set_state({
        count: noticesCount,
        color: notification_badge_color || [1, 1, 1, 1],
        style: notification_badge_style || 'default',
        size: extension.notification_badge_size || 0,
        translate: [0, -0.85],
      });
    }
  }
);

export const DockIcon = GObject.registerClass(
  {},
  class DockIcon extends DashIcon {
    _init(app) {
      super._init(app);
      this._dot.visible = false;

      // Disable drag gestures for GNOME 49+ and previous versions
      if (this._draggable) {
        if (this._draggable._dndGesture) {
          this._draggable._dndGesture.set_enabled(false);
        }
        this._draggable.inhibit = true;
        this._draggable.startDrag = () => {};
        this._draggable._onButtonPress = () => Clutter.EVENT_PROPAGATE;
        this._draggable._onTouchEvent = () => Clutter.EVENT_PROPAGATE;
        this._draggable._grabActor = () => {};
      }

      // Native AppIcon routes pointer, touch and keyboard activation through
      // clicked/activate. Handling button-press as well launches items twice.
      this.connectObject(
        'notify::hover',
        () => {
          const container = this.get_parent();
          if (this.hover) container?.showLabel();
          else container?.hideLabel();
        },
        this
      );
    }

    activate(button) {
      let container = this.get_parent();
      if (button === Clutter.BUTTON_SECONDARY) {
        this.popupMenu();
      } else if (container?._onClick) {
        container._onClick();
      }
    }

    vfunc_clicked(button) {
      this._removeMenuTimeout?.();
      this.activate(button);
      return Clutter.EVENT_STOP;
    }

    popupMenu(side = St.Side.TOP) {
      this._removeMenuTimeout?.();
      this.fake_release();
      let container = this.get_parent();
      if (container?._menu) {
        container._menu.popup();
        return container._menu;
      }
      return null;
    }

    getDragActor() {
      return new Clutter.Actor();
    }

    getDragActorSource() {
      return this;
    }

    _createIcon(size) {
      this._iconActor = new St.Icon({
        icon_name: this._default_icon_name || 'file',
        icon_size: size,
        style_class: this._default_icon_style_class || '',
        reactive: false,
        track_hover: false,
      });
      const gicon = this.app.get_app_info?.()?.get_icon() ?? this.app.get_icon?.();
      if (gicon) this._iconActor.gicon = gicon;

      return this._iconActor;
    }
  }
);

export const DockItemContainer = GObject.registerClass(
  {},
  class DockItemContainer extends DashItemContainer {
    _init(params) {
      super._init({
        name: 'DockItemContainer',
        style_class: 'dash-item-container',
        ...params,
        scale_x: 1,
        scale_y: 1,
      });

      this.custom_icon = true;

      const DesktopAppInfo = Gio.DesktopAppInfo || GioUnix.DesktopAppInfo;
      const desktopApp = params.appinfo_filename
        ? DesktopAppInfo.new_from_filename(params.appinfo_filename)
        : params.app?.get_app_info?.();
      // AppIcon requires Shell.App (including its state property and window
      // signals). Gio.DesktopAppInfo only describes the desktop file.
      const app = params.app ?? (desktopApp ? new Shell.App({app_info: desktopApp}) : null);
      if (!app) throw new Error(`Invalid desktop application: ${params.appinfo_filename}`);

      let dashIcon = new DockIcon(app, {
        name: 'DockItemContainer',
        style_class: 'dash-item-container',
        ...(params || {}),
      });
      this.set_scale(1, 1);
      this.setChild(dashIcon);

      try {
        this.setLabelText(app.get_name());
      } catch (err) {
        console.log(err);
        console.log(params);
      }

      // menu
      if (desktopApp) {
        this._menu = new DockItemMenu(this, St.Side.TOP, {
          desktopApp,
        });
        this._menu.item = this;
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu._menuManager = this._menuManager;
        Main.uiGroup.add_child(this._menu.actor);
        this._menuManager.addMenu(this._menu);
        this._menu.close();
        dashIcon._menu = this._menu;
      }

      this.connect('destroy', () => {
        if (this._menu) {
          this._menuManager.removeMenu(this._menu);
          dashIcon._menu = null;
          this._menu.destroy();
          this._menu = null;
        }
        this._menuManager = null;
        this.dock = null;
      });
    }

    activateNewWindow() {
      if (this._menu && this._menu._newWindowItem) {
        this._menu._newWindowItem.emit('activate', null);
      }
    }

    _onClick() {
      this.activateNewWindow();
    }
  }
);

export const DockBackground = GObject.registerClass(
  {},
  class DockBackground extends St.Widget {
    _init(params) {
      super._init({
        name: 'DockBackground',
        ...(params || {}),
      });
    }

    update(params) {
      let {
        first,
        last,
        iconSize,
        scaleFactor,
        vertical,
        position,
        panel_mode,
        dock,
      } = params;

      this._padding = 0;

      if (!first || !last || !dock.dash) {
        this.opacity = 0;
        return;
      }

      let dp = dock.dash.get_transformed_position();
      if (!dp.every(Number.isFinite)) return;

      let padding =
        iconSize * 0.1 * (dock.extension.dock_padding || 0) * scaleFactor;

      if (first && last) {
        let tx = first._icon?.translation_x ?? 0;
        let ty = first._icon?.translation_y ?? 0;
        let tx2 = last._icon?.translation_x ?? 0;
        let ty2 = last._icon?.translation_y ?? 0;
        if (isNaN(tx)) tx = 0;
        if (isNaN(ty)) ty = 0;
        if (isNaN(tx2)) tx2 = 0;
        if (isNaN(ty2)) ty2 = 0;

        // bottom
        this.x = dp[0];
        this.y = dp[1];
        let width = dock.dash.width;
        let height = dock.dash.height;

        if (dock.isVertical()) {
          this.y += ty;
          height += ty2 - ty;
        } else {
          this.x += tx;
          width += tx2 - tx;
        }

        // padding
        this.x -= padding;
        width += padding * 2;
        this.y -= padding;
        height += padding * 2;

        if (Number.isFinite(width)) {
          this.width = Math.max(0, width);
        }
        if (Number.isFinite(height)) {
          this.height = Math.max(0, height);
        }

        if (!isNaN(this.x) && !isNaN(dock.x)) {
          this.x -= dock.x;
        }
        if (!isNaN(this.y) && !isNaN(dock.y)) {
          this.y -= dock.y;
        }
        this._padding = padding;

        // adjust padding
        let az = -padding;
        if (!isNaN(az)) {
          this.x += az / 2;
          this.width -= az * (1 + !vertical);
          this.y += az / 2;
          this.height -= az * (1 + vertical);
        }

        if (panel_mode) {
          if (vertical) {
            this.y = 0;
            this.height = dock.height;
          } else {
            this.x = 0;
            this.width = dock.width;
          }
        }

        const transparent = (Main.overview.visible || dock.extension._inOverview) &&
          dock.extension.overview_transparent_background;
        this.opacity = transparent ? 0 : 255;
        dock.dash.opacity = 255;
      }
    }
  }
);
