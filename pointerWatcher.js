import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

// GNOME 51 removed ui/pointerWatcher.js. Follow its magnifier's compositor
// cursor tracking, with idle-aware polling for older Mutter versions.
const IDLE_TIME = 1000;

class PointerWatcher {
  constructor() {
    this._watches = new Set();
    this._generation = 0;
    this._point = null;
    this._tracker = null;
    this._positionId = 0;
    this._laters = null;
    this._laterId = 0;
    this._pollId = 0;
    this._idleMonitor = null;
    this._idleId = 0;
    this._activeId = 0;
    this._idle = false;
  }

  addWatch(interval, callback) {
    if (!Number.isFinite(interval) || interval <= 0 || typeof callback !== 'function')
      throw new TypeError('Pointer watches need a positive interval and callback');
    const watch = {
      interval,
      callback,
      remove: () => this._removeWatch(watch),
    };
    this._watches.add(watch);
    if (this._watches.size === 1) this._start();
    else if (!this._positionId) this._reschedulePoll();
    return watch;
  }

  _removeWatch(watch) {
    if (!this._watches.delete(watch)) return;
    watch.callback = null;
    if (!this._watches.size) this._stop();
    else if (!this._positionId) this._reschedulePoll();
  }

  _start() {
    this._generation++;
    const generation = this._generation;
    try {
      const tracker = global.backend?.get_cursor_tracker?.() ??
        Meta.CursorTracker?.get_for_display?.(global.display);
      const laters = global.compositor?.get_laters?.();
      if (tracker?.connect && laters?.add && laters?.remove) {
        this._tracker = tracker;
        this._laters = laters;
        this._positionId = tracker.connect('position-invalidated', () => {
          if (generation === this._generation) this._queuePositionUpdate();
        });
      }
    } catch {
      // Older cursor trackers have no position-invalidated signal.
    }
    if (!this._positionId) {
      this._tracker = null;
      this._laters = null;
    }
    // Registration never invokes a subscriber. Dock callbacks retain their
    // returned watch, which is assigned only after addWatch() returns.
    this._point = this._readPointer();
    if (this._positionId) return;

    try {
      const monitor = global.backend?.get_core_idle_monitor?.() ??
        Meta.IdleMonitor?.get_core?.();
      if (monitor) {
        this._idleMonitor = monitor;
        this._idle = monitor.get_idletime() >= IDLE_TIME;
        this._idleId = monitor.add_idle_watch(IDLE_TIME, () => {
          if (generation !== this._generation || this._idleMonitor !== monitor) return;
          this._idle = true;
          this._cancelPoll();
          this._watchActive();
        });
        if (this._idle) this._watchActive();
      }
    } catch {
      // Pointer recovery remains usable if idle monitoring is unavailable.
      this._clearIdleMonitor();
    }
    this._schedulePoll();
  }

  _readPointer() {
    try {
      const point = this._tracker?.get_pointer?.();
      if (point?.[0] && typeof point[0] === 'object') {
        const { x, y } = point[0];
        if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
      } else if (point && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
        return point.slice(0, 2);
      }
    } catch {
      // A backend may be going away during teardown.
    }
    try {
      const [x, y] = global.get_pointer();
      return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
    } catch {
      return null;
    }
  }

  _dispatchPosition() {
    const point = this._readPointer();
    if (!point || (this._point && point[0] === this._point[0] && point[1] === this._point[1]))
      return;
    this._point = point;
    for (const watch of [...this._watches]) {
      if (!this._watches.has(watch)) continue;
      try {
        watch.callback(...point);
      } catch (error) {
        console.error('Pointer watcher:', error);
      }
    }
  }

  _queuePositionUpdate() {
    if (this._laterId || !this._watches.size || !this._positionId) return;
    const generation = this._generation;
    const laters = this._laters;
    let id;
    id = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
      if (generation !== this._generation || this._laterId !== id) return GLib.SOURCE_REMOVE;
      this._laterId = 0;
      this._dispatchPosition();
      return GLib.SOURCE_REMOVE;
    });
    this._laterId = id;
  }

  _watchActive() {
    if (this._activeId || !this._idleMonitor || !this._watches.size) return;
    const generation = this._generation;
    const monitor = this._idleMonitor;
    this._activeId = monitor.add_user_active_watch(() => {
      if (generation !== this._generation || this._idleMonitor !== monitor) return;
      this._activeId = 0;
      this._idle = false;
      this._schedulePoll();
    });
  }

  _schedulePoll() {
    if (this._pollId || this._idle || this._positionId || !this._watches.size) return;
    const interval = Math.max(1, Math.min(...[...this._watches].map(watch => watch.interval)));
    const generation = this._generation;
    let id;
    id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
      if (generation !== this._generation || this._pollId !== id) return GLib.SOURCE_REMOVE;
      this._pollId = 0;
      this._dispatchPosition();
      if (generation === this._generation) this._schedulePoll();
      return GLib.SOURCE_REMOVE;
    });
    this._pollId = id;
  }

  _cancelPoll() {
    if (this._pollId) GLib.source_remove(this._pollId);
    this._pollId = 0;
  }

  _reschedulePoll() {
    this._cancelPoll();
    this._schedulePoll();
  }

  _clearIdleMonitor() {
    const monitor = this._idleMonitor;
    if (this._idleId) monitor.remove_watch(this._idleId);
    if (this._activeId) monitor.remove_watch(this._activeId);
    this._idleId = this._activeId = 0;
    this._idleMonitor = null;
    this._idle = false;
  }

  _stop() {
    this._generation++;
    if (this._positionId) this._tracker.disconnect(this._positionId);
    this._positionId = 0;
    if (this._laterId) this._laters.remove(this._laterId);
    this._laterId = 0;
    this._tracker = this._laters = null;
    this._cancelPoll();
    this._clearIdleMonitor();
    this._point = null;
  }
}

let pointerWatcher;

export function getPointerWatcher() {
  if (!pointerWatcher) pointerWatcher = new PointerWatcher();
  return pointerWatcher;
}
