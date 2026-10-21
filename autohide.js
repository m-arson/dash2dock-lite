'use strict';

import Meta from 'gi://Meta';

import { DockPosition } from './dock.js';
import {
  get_distance_sqr,
  get_distance,
  isInRect,
  isOverlapRect,
} from './utils.js';

const DEBOUNCE_HIDE_TIMEOUT = 120;
const PRESSURE_SENSE_DISTANCE = 40;

// some codes lifted from dash-to-dock intellihide
const handledWindowTypes = [
  Meta.WindowType.NORMAL,
  // Meta.WindowType.DOCK,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
  // Meta.WindowType.TOOLBAR,
  // Meta.WindowType.MENU,
  Meta.WindowType.UTILITY,
  // Meta.WindowType.SPLASHSCREEN
];

export let AutoHide = class {
  enable() {
    if (this._enabled) return;
    // console.log('enable autohide');
    this._enabled = true;
    this._shown = true;
    this._dwell = 0;
    this.last_pointer = null;
    // windows may already cover the dock; nothing else checks until the
    // focus or stacking changes
    this._debounceCheckHide();
    console.log('autohide enabled');
  }

  disable() {
    if (!this._enabled) return;
    if (this.extension._hiTimer) {
      this.extension._hiTimer.cancel(this._animationSeq);
      this._animationSeq = null;
    }
    if (this.extension._loTimer && this._debounceCheckSeq) {
      this.extension._loTimer.cancel(this._debounceCheckSeq);
      this._debounceCheckSeq = null;
    }

    this._enabled = false;
    this.show();

    if (this._trackedWindows) {
      for (let w of this._trackedWindows) {
        try {
          w.disconnectObject(this);
        } catch (err) {}
      }
      this._trackedWindows.clear();
    }
    this.windows = null;
    this.last_pointer = null;

    console.log('autohide disabled');
  }

  _getScaleFactor() {
    //! use dock scale factor
    let scaleFactor = this.dock._monitor?.geometry_scale || 1;
    return scaleFactor;
  }

  _onMotionEvent() {
    if (!this._enabled || !this.dock._monitor) return;
    if (this.extension.pressure_sense && !this._shown) {
      let monitor = this.dock._monitor;
      let pointer = global.get_pointer();
      if (this.extension.simulated_pointer) {
        pointer = [...this.extension.simulated_pointer];
      }

      let sw = monitor.width;
      let sh = monitor.height;
      if (pointer[0] < monitor.x || pointer[0] >= monitor.x + sw ||
          pointer[1] < monitor.y || pointer[1] >= monitor.y + sh) {
        this._dwell = 0;
        this.last_pointer = null;
        return;
      }
      let scale = this._getScaleFactor();
      let area = scale * (PRESSURE_SENSE_DISTANCE * PRESSURE_SENSE_DISTANCE);
      let dx = 0;
      let dy = 0;

      if (this.last_pointer) {
        dx = pointer[0] - this.last_pointer[0];
        dx = dx * dx;
        dy = pointer[1] - this.last_pointer[1];
        dy = dy * dy;
      }

      let dwell_count =
        80 - 60 * (this.extension.pressure_sense_sensitivity || 0);

      if (this.dock.isVertical()) {
        if (
          // right
          (this.dock._position == DockPosition.RIGHT &&
            dy < area &&
            pointer[0] > monitor.x + sw - 4) ||
          // left
          (this.dock._position == DockPosition.LEFT &&
            dy < area &&
            pointer[0] < monitor.x + 4)
        ) {
          this._dwell++;
        } else {
          this._dwell = 0;
          this.last_pointer = pointer;
        }
      } else {
        if (
          // bottom
          (this.dock._position == DockPosition.BOTTOM &&
            dx < area &&
            pointer[1] + 4 > monitor.y + sh) ||
          // top
          (this.dock._position == DockPosition.TOP &&
            dx < area &&
            pointer[1] < monitor.y + 4)
        ) {
          this._dwell++;
        } else {
          this._dwell = 0;
          this.last_pointer = pointer;
        }
      }

      // console.log(`${this._dwell} ${dwell_count} ${this.extension.pressure_sense_sensitivity}`);

      if (this._dwell > dwell_count) {
        this.show();
      }
    }
  }

  _onEnterEvent() {
    if (this._enabled && !this.extension.pressure_sense) {
      this.show();
    }
  }

  _onLeaveEvent() {
    if (this._enabled && this._shown) {
      this._dwell = 0;
      this._debounceCheckHide();
    }
  }

  _onFocusWindow() {
    this._debounceCheckHide();
  }

  _onFullScreen() {
    this._debounceCheckHide();
  }

  show() {
    if (this.dock._destroyed || !this.dock._monitor ||
        (this._enabled && this.dock._monitor.inFullscreen && !this.extension._inOverview)) {
      return;
    }
    this._dwell = 0;
    this.frameDelay = 0;
    this._shown = true;
    this.dock.slideIn();
  }

  hide() {
    if (!this._enabled || this.dock._destroyed) return;
    this._dwell = 0;
    this.frameDelay = 10;
    this._shown = false;
    this.dock.slideOut();
  }

  _track(window) {
    if (!this._trackedWindows) {
      this._trackedWindows = new Set();
    }
    if (!this._trackedWindows.has(window)) {
      window.connectObject(
        'position-changed',
        () => {
          this._debounceCheckHide();
        },
        'size-changed',
        () => {
          this._debounceCheckHide();
        },
        'unmanaged',
        () => {
          this._untrack(window);
        },
        this
      );
      this._trackedWindows.add(window);
    }
  }

  _untrack(window) {
    if (!this._trackedWindows?.delete(window)) return;
    try {
      window.disconnectObject(this);
    } catch (err) {
      // may have been destroyed already
    }
  }

  _checkOverlap() {
    if (!this.dock._monitor || this.dock._destroyed) return false;
    // console.log("checking overlap...");
    if (this.extension._inOverview) {
      return false;
    }
    if (!this.extension.autohide_dash) return false;
    // Fullscreen takes priority over pointer proximity: show() deliberately
    // refuses to reveal a dock over a fullscreen application.
    if (this.dock._monitor.inFullscreen) return true;
    // Popup menus live outside the dock's bounds. Keep their source visible
    // while the pointer moves into a window chooser or an app context menu.
    if (this.dock._hasOpenMenu?.()) return false;
    let pointer = global.get_pointer();
    if (this.extension.simulated_pointer) {
      pointer = [...this.extension.simulated_pointer];
    }

    // console.log(pointer);

    let pos = this.dock.struts.get_transformed_position();
    let rect = {
      x: pos[0],
      y: pos[1],
      w: this.dock.struts.width,
      h: this.dock.struts.height,
    };
    //! change to struts rect
    let arect = [rect.x, rect.y, rect.w, rect.h];

    // console.log(arect);

    // console.log("checking pointer location...");

    // The visible footprint keeps a shown dock open; it must not reveal a
    // hidden dock. Animation checks continue while sliding/zooming settles,
    // and the struts still describe the old on-screen area during that time.
    // Hidden pointer reveals belong to the narrow edge dwell/pressure actor.
    if (!this.dock._hidden &&
        (this.dock._isWithinDash(pointer) || isInRect(arect, pointer))) {
      return false;
    }

    if (!this.extension.autohide_dodge) {
      return true;
    }

    // console.log("checking windows...");

    let monitor = this.dock._monitor;
    let actors = global.get_window_actors();
    // Track all managed windows, including those currently minimized, on a
    // different workspace, or on another monitor: any can later cover the dock.
    const currentWindows = new Set();
    let workspace = global.workspace_manager.get_active_workspace_index();
    let isOverlapped = false;
    for (const actor of actors) {
      const w = actor.get_meta_window();
      if (!w) continue;
      currentWindows.add(w);
      this._track(w);
      // Once overlap is known, only synchronize window ownership. Avoid
      // repeated native geometry/workspace queries for the remaining windows.
      if (isOverlapped || !w.can_close() || w.get_monitor() !== monitor.index ||
          w.get_workspace()?.index() !== workspace || !w.showing_on_its_workspace() ||
          !handledWindowTypes.includes(w.get_window_type())) continue;

      let frame = w.get_frame_rect();
      let win = [frame.x, frame.y, frame.width, frame.height];

      if (isOverlapRect(arect, win)) {
        isOverlapped = true;
      }
    }
    for (const window of this._trackedWindows ?? []) {
      if (!currentWindows.has(window)) this._untrack(window);
    }

    // console.log(isOverlapped);
    return isOverlapped;
  }

  _debounceCheckHide() {
    if (!this._enabled || this.dock._destroyed) return;
    if (this.extension._loTimer) {
      if (!this._debounceCheckSeq) {
        this._debounceCheckSeq = this.extension._loTimer.runDebounced(
          () => {
            this._debounceCheckSeq = null;
            this._checkHide();
          },
          DEBOUNCE_HIDE_TIMEOUT,
          'debounceCheckHide'
        );
      }
    }
  }

  _checkHide() {
    if (this._enabled) {
      if (this._checkOverlap()) {
        this.hide();
      } else {
        this.show();
      }
    }
  }
};
