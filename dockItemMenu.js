'use strict';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { trySpawnCommandLine } from './utils.js';
// import { trySpawnCommandLine } from 'resource:///org/gnome/shell/misc/util.js';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Graphene from 'gi://Graphene';
const Point = Graphene.Point;

import { DockPosition } from './dock.js';

const ANIM_POSITION_PER_SEC = 450 / 1000;

export const DockItemList = GObject.registerClass(
  {},
  class DockItemList extends St.Widget {
    _init(renderer, params) {
      super._init({
        name: 'DockItemList',
        reactive: true,
        // style_class: 'hi',
        ...params,
      });

      this._box = null;
      this._labels = null;
      this._items = null;

      this.connect('button-press-event', (obj, evt) => {
        if (!this._box || !this._box.get_children().length) {
          return Clutter.EVENT_PROPAGATE;
        }
        this.slideOut();
        return Clutter.EVENT_PROPAGATE;
      });

      this.connect('destroy', () => {
        this._items = null;
        if (this._targetDestroyId) {
          this._target.disconnect(this._targetDestroyId);
          this._targetDestroyId = null;
        }
        if (this._box) {
          this._box.destroy();
          this._box = null;
        }
        if (this._labels) {
          this._labels.destroy();
          this._labels = null;
        }
        this._target = null;
        this.dock = null;
      });
    }

    static createItem(dock, f) {
      let file_explorer = dock.extension.file_explorer();
      let target = dock.createItem(f.path);
      target._onClick = () => {
        if (
          dock._position != DockPosition.BOTTOM &&
          dock._position != DockPosition.TOP
        ) {
          target.activateNewWindow();
          return;
        }
        if (!dock.extension.services[f.items]) {
          f.prepare();
        }
        let files = [...(dock.extension.services[f.items] || [])];
        if (!files.length) return;
        if (files.length < dock.extension.services[f.itemsLength]) {
          files = [
            {
              index: -1,
              name: 'More...',
              exec: `${file_explorer} ${GLib.shell_quote(f.folder)}`,
              icon: target._icon.icon_name,
              type: 'exec',
            },
            ...files,
          ];
        }
        files = files.sort(function (a, b) {
          return a.index > b.index ? 1 : -1;
        });

        if (!dock._list) {
          dock._list = new DockItemList();
          dock._list.dock = dock;
          Main.uiGroup.add_child(dock._list);
        } else if (dock._list.visible) {
          dock._list.slideOut();
        } else {
          // remove and re-add so that it is repositioned to topmost
          Main.uiGroup.remove_child(dock._list);
          Main.uiGroup.add_child(dock._list);
          dock._list.visible = true;
        }

        if (dock._list && dock._list.visible && !dock._list._hidden) {
          dock._list.slideIn(target, files);
        }
      };

      return target;
    }

    slideIn(target, list) {
      this._items = null;
      if (this._targetDestroyId) {
        this._target.disconnect(this._targetDestroyId);
        this._targetDestroyId = null;
      }
      if (this._box) {
        this._box.destroy();
        this._box = null;
      }
      if (this._labels) {
        this._labels.destroy();
        this._labels = null;
      }

      if (!list.length) {
        this._target = null;
        this.visible = false;
        return;
      }

      this.opacity = 0;

      let dock = this.dock;
      this.x = dock._monitor.x;
      this.y = dock._monitor.y;
      this.width = dock._monitor.width;
      this.height = dock._monitor.height;

      this._hidden = false;
      this._hiddenFrames = 0;

      this._target = target;
      this._targetDestroyId = target.connect('destroy', () => {
        this._targetDestroyId = null;
        this._target = null;
        this.dock?._destroyList();
      });

      this._box = new St.Widget({});
      this.add_child(this._box);
      this._labels = new St.Widget({});
      this.add_child(this._labels);

      dock._updateIconEffect();

      let iconSize = dock._iconSizeScaledDown * dock._monitor.geometry_scale;
      // dock.dash._box.first_child._icon.width;

      // scaling hack - temporary
      let iconAdjust = 1;
      // if (dock._scaleFactor != 1 && dock._scaleFactor != 2) {
      //   iconAdjust += 0.5;
      // }

      let file_explorer = dock.extension.file_explorer();

      let icon_size = iconSize * iconAdjust;
      list.forEach((l) => {
        let w = new St.Widget({});
        let wl = new St.Widget({});
        let icon = new St.Widget({
          name: 'icon_placeholder',
          reactive: true,
          track_hover: true,
        });
        icon.set_size(icon_size, icon_size);

        this._box.add_child(w);
        this._labels.add_child(wl);

        let short = (l.name ?? '').replace(/(.{32})..+/, '$1...');
        let label = new St.Label({ style_class: 'dash-label', text: short });
        w.add_child(icon);
        w._label_container = wl;
        wl.add_child(label);
        w._icon = icon;
        w._label = label;
        w.createActualIcon = () => {
          let _icon = new St.Icon({
            name: 'icon',
            icon_name: l.icon,
            icon_size: icon_size,
          });
          w._icon.add_child(_icon);
        };
        label.opacity = 0;

        // label.style = 'font-size: 32pt';
        // label.set_scale(0.5, 0.5);

        icon.connect('button-press-event', () => {
          // let path = Gio.File.new_for_path(`Downloads/${l.name}`).get_path();
          let path = GLib.shell_quote(l.path ?? '');
          let cmd = `${dock.extension.file_opener()} ${path}`;

          if (l.type?.includes('directory')) {
            cmd = `${file_explorer} ${path}`;
          }
          if (l.type?.includes('exec')) {
            cmd = l.exec;
          }

          // A launched menu no longer needs its icon textures, labels, file
          // callbacks or the target's destroy handler.
          dock._maybeBounce(this._target);
          dock._destroyList();

          trySpawnCommandLine(cmd).catch((err) => {
            console.log(err);
          });
          return Clutter.EVENT_STOP;
        });
      });

      let tp = this._target.get_transformed_position();
      let angleInc = 0 + 2.5 * dock.extension.items_pullout_angle;
      let startAngle = 270 + 1 * angleInc;
      let angle = startAngle;
      let rad = iconSize; // * dock._scaleFactor;

      if (
        dock._position == DockPosition.TOP ||
        dock._position == DockPosition.RIGHT
      ) {
        rad = -iconSize;
      }

      let ox = 0;
      let oy = 0;

      this._iconSize = icon_size;
      let dir_angle = 0;

      switch (dock._position) {
        case DockPosition.BOTTOM:
          ox = 0;
          oy = -icon_size / 4;
          break;
        case DockPosition.TOP:
          ox = 0;
          oy = icon_size * 2;
          break;
        case DockPosition.LEFT:
          oy = icon_size / 4;
          ox = icon_size;
          dir_angle = 90;
          break;
        case DockPosition.RIGHT:
          oy = icon_size / 4;
          ox = -icon_size;
          dir_angle = 90;
          break;
      }

      let children = this._box.get_children();
      children.reverse();
      this._items = children;
      children.forEach((l) => {
        let hX = Math.cos((angle + dir_angle) * 0.0174533);
        let hY = Math.sin((angle + dir_angle) * 0.0174533);
        let hl = Math.sqrt(hX * hX + hY * hY);
        hX /= hl;
        hY /= hl;
        hX *= rad;
        hY *= rad;

        l.x = tp[0] - this.x + ox;
        l.y = tp[1] - this.y + oy;

        ox += hX;
        oy += hY;

        if (
          dock._position == DockPosition.TOP ||
          dock._position == DockPosition.LEFT
        ) {
          angle -= angleInc;
        } else {
          angle += angleInc;
        }

        l.rotation_angle_z = angle - startAngle;

        l._label_container.x = l.x;
        l._label_container.y = l.y;
        if (dock._position == DockPosition.TOP) {
          l._label_container.y = l.y + -rad / 4;
        }
      });

      if (children.length == 0) return;

      let first = children[0];
      let fx = first.x;
      let fy = first.y;
      children.forEach((l) => {
        l._ox = first.x;
        l._oy = first.y;
        l._oz = 0;
        l._label.opacity = 0;
        l._x = l.x;
        l._y = l.y;

        switch (dock._position) {
          case DockPosition.BOTTOM:
            l._y = l.y - rad * 0.9;
            break;
        }

        l._rotation_angle_z = l.rotation_angle_z;
        l.x = first.x;
        l.y = first.y;
        l._label_container.x = l.x;
        l._label_container.y = l.y;
        l.rotation_angle_z = 0;
      });

      // Share immutable positions between paths instead of allocating a
      // Vector (and its component array) for every item/waypoint pair.
      const positions = children.map((child) => ({
        x: child._x, y: child._y, rotation_angle_z: child._rotation_angle_z,
      }));
      const start = { x: tp[0] - this.x, y: tp[1] - this.y, rotation_angle_z: 0 };
      for (let i = 0; i < children.length; i++) {
        let target = children[i];
        let wp = { x: first._x, y: first._y,
          rotation_angle_z: target._rotation_angle_z };
        target._waypointsIn = [wp];
        target._waypointsOut = [wp];
        for (let j = 0; j <= i; j++) {
          const wp = positions[j];
          target._waypointsIn.push(wp);
          target._waypointsOut.unshift(wp);
        }

        target._waypointsIn.unshift(start);
        target._waypointsOut.push(start);
      }
      dock._beginAnimation();
    }

    slideOut() {
      if (!this._hidden) {
        this._hidden = true;
        this._hiddenFrames = 80;
        this.dock?._beginAnimation();
      }
    }

    animate(dt) {
      return this._animate(dt);
    }

    _animate(dt) {
      let dock = this.dock;
      if (!dock || dock._list !== this) return false;
      let list = dock._list;
      if (!Number.isFinite(dt) || dt <= 0) return false;

      // list.opacity = 255;

      let target = list._target;
      if (!target?._icon) {
        dock._destroyList();
        return false;
      }
      let speed = 3 * ANIM_POSITION_PER_SEC;
      let didAnimate = false;

      if (dock.isVertical()) {
        list.translation_y = target._icon.translation_y;
        list.translation_x =
          -((dock._iconSizeScaledDown / 4) * (target._scale ?? 1)) *
            (dock._position == 'left' ? -1 : 1) +
          target._icon.translation_x;
      } else {
        list.translation_x = target._icon.translation_x;
        list.translation_y =
          -((dock._iconSizeScaledDown / 4) * (target._scale ?? 1)) +
          target._icon.translation_y;
      }

      if (list._box) {
        list._labels.x = list._box.x;
        list._labels.y = list._box.y;
      }

      (this._items ?? []).forEach((c) => {
        let waypoints = list._hidden ? c._waypointsOut : c._waypointsIn;
        if (!waypoints || !waypoints.length) {
          return;
        }

        if (list._hidden) {
          c._icon.reactive = false;
        }

        didAnimate = true;
        let x = c.x;
        let y = c.y;
        let rotation = c.rotation_angle_z;
        // Preserve the six numerical steps of the original animation while
        // reading/writing actors, creating icons and measuring labels once.
        for (let step = 0; step < 6 && waypoints.length; step++) {
          const wp = waypoints[0];
          const dx = wp.x - x;
          const dy = wp.y - y;
          const magnitude = Math.hypot(dx, dy);
          const distance = speed * dt / 2;
          if (distance >= magnitude) {
            waypoints.shift();
            x = wp.x;
            y = wp.y;
          } else {
            x += dx * distance / magnitude;
            y += dy * distance / magnitude;
          }
          rotation = (rotation + (wp.rotation_angle_z || 0)) / 2;
        }
        c.x = x;
        c.y = y;

        c._label_container.x = c.x;
        c._label_container.y = c.y;

        switch (dock._position) {
          case DockPosition.BOTTOM:
            c._label_container.y = c.y;
            break;
          case DockPosition.TOP:
            c._label_container.y = c.y + -this._iconSize / 4;
            break;
          case DockPosition.RIGHT:
            c._label_container.x = c.x;
            break;
          case DockPosition.LEFT:
            c._label_container.x = c.x + -this._iconSize / 4;
            break;
        }

        let lsz = c._label.get_transformed_size();

        if (dock.isVertical()) {
          // c._label.translation_y = -lsz[1]; // c._label.height;
          c._label.translation_x = -lsz[0]; // c._label.width;
        } else {
          c._label.translation_x = -lsz[0]; // c._label.width;
        }

        if (list._hidden) {
          // let opacity = c._label.opacity - dt;
          // if (opacity < 50) opacity = 0;
          // c._label.opacity = opacity;
          c._label.opacity = 0;
        } else {
          c._label.opacity = 255;
        }
        c.rotation_angle_z = rotation;

        if (dock.extension.downloads_icon_rotate_labels) {
          c._label_container.rotation_angle_z = c.rotation_angle_z;
          if (dock.isVertical()) {
            c._label_container.rotation_angle_z += 90;
          }
        }

        if (!c._icon.first_child) {
          c.createActualIcon();
        }
      });

      if (list._hidden) {
        let opacity = list.opacity - 12;
        if (opacity < 0) opacity = 0;
        list.opacity = opacity;
      } else {
        list.opacity = 255;
      }

      if (!didAnimate && list._hidden) {
        // console.log('destroy');
        dock._destroyList();
        return false;
      }

      target._label.hide();
      return didAnimate;
    }
  }
);
