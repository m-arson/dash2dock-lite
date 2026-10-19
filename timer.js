'use strict';

import GLib from 'gi://GLib';

export const Timer = class {
  constructor(name) {
    this._name = name;
    this._subscribers = [];
    this._subscriberId = 0xff;
  }

  initialize(resolution) {
    this._resolution = Math.max(1, resolution || 1000);
    this._enabled = true;
    this._paused = false;
    this._autoStart = true;
    this._autoHibernate = true;

    this._hibernating = false;
  }

  shutdown() {
    this._enabled = false;
    this._autoStart = false;
    this._hibernating = false;
    this.stop();
    this._subscribers = [];
  }

  start(resolution) {
    if (!this._enabled) return;
    if (this.is_running()) {
      // print('already running');
      return;
    }
    this._resolution = Math.max(1, resolution || this._resolution || 1000);
    this._time = 0;
    this._paused = false;
    this._timeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._resolution,
      this.onUpdate.bind(this)
    );
    this._hibernating = false;
    this.onStart();
  }

  stop() {
    if (!this.is_running()) {
      // print('already stopped');
      return;
    }
    const timeoutId = this._timeoutId;
    this._timeoutId = null;
    GLib.source_remove(timeoutId);
    this.onStop();
  }

  restart(resolution) {
    this.stop();
    this.start(resolution || this._resolution || 1000);
  }

  pause() {
    if (!this.is_running()) {
      return;
    }
    this._paused = true;
    this.onPause();
  }

  resume() {
    if (!this.is_running()) {
      return;
    }
    this._paused = false;
    this.onResume();
  }

  hibernate() {
    if (!this.is_running()) {
      return;
    }

    this.stop();
    this._hibernating = true;
  }

  is_running() {
    return this._timeoutId != null;
  }

  toggle_pause() {
    if (!this.is_running()) {
      return;
    }
    if (!this._paused) {
      this.pause();
    } else {
      this.resume();
    }
  }

  onStart() {
    this._dispatch('onStart');
  }

  onStop() {
    this._dispatch('onStop');
  }

  onPause() {
    this._dispatch('onPause');
  }

  onResume() {
    this._dispatch('onResume');
  }

  _dispatch(method, ...args) {
    const timeoutId = this._timeoutId;
    // Callbacks can cancel each other, add work, or disable the extension.
    // New subscriptions belong to the next tick, and cancelled ones must not run.
    for (const subscriber of [...this._subscribers]) {
      if (method === 'onUpdate' && this._timeoutId !== timeoutId) break;
      if (!this._subscribers.includes(subscriber)) continue;
      try {
        subscriber[method]?.(subscriber, ...args);
      } catch (error) {
        this.unsubscribe(subscriber);
        // Letting an exception escape removes the GLib source while leaving
        // is_running() true, permanently stalling every animation on the timer.
        console.error(`${this._name}: ${subscriber._name ?? subscriber._id}: ${error.message ?? error}\n${error.stack ?? ''}`);
      }
    }
  }

  onUpdate() {
    if (!this._timeoutId) return GLib.SOURCE_REMOVE;
    if (this._paused) return GLib.SOURCE_CONTINUE;
    const timeoutId = this._timeoutId;
    this._dispatch('onUpdate', this._resolution);
    if (this._timeoutId !== timeoutId) return GLib.SOURCE_REMOVE;

    this._time += this._resolution;

    if (this._autoHibernate) {
      if (!this._subscribers.length) {
        this.hibernate();
      }
    }

    // print(`${this._time/1000} subs:${this._subscribers.length}`);
    return this._timeoutId === timeoutId ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
  }

  runningTime() {
    return this._time;
  }

  subscribe(obj) {
    if (!this._enabled || !obj) return obj;
    if (!obj._id) {
      obj._id = this._subscriberId++;
    }
    let idx = this._subscribers.findIndex((s) => s._id == obj._id);
    if (idx == -1) {
      this._subscribers.push(obj);
    } else {
      Object.assign(this._subscribers[idx], obj);
      obj = this._subscribers[idx];
    }

    if (
      (this._hibernating || this._autoStart) &&
      this._subscribers.length == 1
    ) {
      this.start(this._resolution);
    }

    // log(`subscribers: ${this.subscriberNames().join(',')}`);
    return obj;
  }

  unsubscribe(obj) {
    if (!obj) return;
    let idx = this._subscribers.findIndex((s) => s._id == obj._id);
    if (idx != -1) {
      if (this._subscribers.length == 1) {
        this._subscribers = [];
      } else {
        this._subscribers.splice(idx, 1);
      }
      if (!this._subscribers.length && this._autoHibernate) this.hibernate();
    }
  }

  subscriberNames() {
    return this._subscribers.map((s) => {
      if (s._name) {
        return s._name;
      }
      return `${s._id}`;
    });
  }

  dumpSubscribers() {
    if (this._name) {
      print('--------');
      print(this._name);
    }
    this._subscribers.forEach((s) => {
      print('--------');
      Object.keys(s).forEach((k) => {
        print(`${k}: ${s[k]}`);
      });
    });
  }

  runLoop(func, delay, name) {
    if (typeof func === 'object') {
      func._time = 0;
      return this.subscribe(func);
    }
    let obj = {
      _name: name,
      _type: 'loop',
      _time: 0,
      _delay: delay,
      _func: func,
      onUpdate: (s, dt) => {
        s._time += dt;
        if (s._time >= s._delay) {
          s._func(s);
          s._time -= s._delay;
        }
      },
    };
    return this.subscribe(obj);
  }

  runUntil(func, delay, name) {
    if (typeof func === 'object') {
      func._time = 0;
      return this.subscribe(func);
    }
    let obj = {
      _name: name,
      _type: 'until',
      _time: 0,
      _delay: delay,
      _func: func,
      onUpdate: (s, dt) => {
        s._time += dt;
        if (s._time >= s._delay) {
          if (s._func(s)) {
            this.unsubscribe(s);
          }
          s._time -= s._delay;
        }
      },
    };
    return this.subscribe(obj);
  }

  runOnce(func, delay, name) {
    if (typeof func === 'object') {
      func._time = 0;
      return this.subscribe(func);
    }
    let obj = {
      _name: name,
      _type: 'once',
      _time: 0,
      _delay: delay,
      _func: func,
      onUpdate: (s, dt) => {
        s._time += dt;
        if (s._time >= s._delay) {
          this.unsubscribe(s);
          s._func(s);
        }
      },
    };
    return this.subscribe(obj);
  }

  runDebounced(func, delay, name) {
    if (typeof func === 'object') {
      func._time = 0;
      return this.subscribe(func);
    }
    let obj = {
      _name: name,
      _type: 'debounced',
      _time: 0,
      _delay: delay,
      _func: func,
      onUpdate: (s, dt) => {
        s._time += dt;
        if (s._time >= s._delay) {
          this.unsubscribe(s);
          s._func(s);
        }
      },
    };
    return this.subscribe(obj);
  }

  runSequence(array, settings) {
    if (array && !Array.isArray(array)) {
      array._time = 0;
      array._currentIdx = 0;
      return this.subscribe(array);
    }
    let obj = {
      _time: 0,
      _currentIdx: 0,
      _sequences: [...array],
      ...settings,
      onUpdate: (s, dt) => {
        let current = s._sequences[s._currentIdx];
        if (!current) {
          this.unsubscribe(s);
          return;
        }
        s._time += dt;
        if (s._time >= current.delay) {
          current.func(current);
          s._time -= current.delay;
          s._currentIdx++;
          if (s._currentIdx >= s._sequences.length && s._loop) {
            s._currentIdx = 0;
          } else if (s._currentIdx >= s._sequences.length) {
            this.unsubscribe(s);
          }
        }
      },
    };
    return this.subscribe(obj);
  }

  runAnimation(array, settings) {
    if (array && !Array.isArray(array)) {
      array._time = 0;
      return this.subscribe(array);
    }

    let duration = 0;
    const animationFrames = array.map((frame) => {
      const result = { ...frame, _start: frame._start ?? duration };
      duration = Math.max(duration, result._start + result._duration);
      return result;
    });

    let obj = {
      _time: 0,
      _duration: duration,
      _loop: false,
      _frames: animationFrames,
      ...(settings || {}),
      onUpdate: (s, dt) => {
        const previousTime = s._time;
        s._time = Math.min(s._time + dt, s._duration);

        let frames = [];
        if (s._frames) {
          frames = s._frames.filter((f) => {
            // Also finish frames crossed by a slow tick. Short cleanup frames
            // otherwise never run and can leave an icon stuck mid-bounce.
            return f._start <= s._time && previousTime < f._start + f._duration;
          });
        }
        s._currentFrames = frames;

        if (!s._func) {
          s._func = (s) => {
            s._currentFrames.forEach((f) => {
              f._time = Math.min(s._time - f._start, f._duration);
              f._func(f, s);
            });
          };
        }

        if (s._time >= s._duration) {
          this.unsubscribe(s);
          s._func(s);
          return;
        }
        s._func(s);
      },
    };
    return this.subscribe(obj);
  }

  cancel(obj) {
    if (obj) {
      this.unsubscribe(obj);
    }
  }
};
