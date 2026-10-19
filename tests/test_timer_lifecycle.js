// Run with: gjs -m tests/test_timer_lifecycle.js
import GLib from 'gi://GLib';
import { Timer } from '../timer.js';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function test(name, callback) {
  const timer = new Timer(name);
  timer.initialize(15);
  try {
    callback(timer);
    print(`PASS ${name}`);
  } finally {
    timer.shutdown();
  }
}

test('a failing subscriber cannot freeze the shared timer', (timer) => {
  let calls = 0;
  timer.runLoop(() => { throw new Error('disposed actor (expected test error)'); }, 1);
  timer.runLoop(() => calls++, 1);
  assert(timer.onUpdate() === GLib.SOURCE_CONTINUE, 'GLib source must continue');
  timer.onUpdate();
  assert(calls === 2, 'healthy callbacks must still run');
  assert(timer._subscribers.length === 1, 'failed work must be removed');
  assert(timer.is_running(), 'timer remains usable after a callback throws');
});

test('cancelled callbacks are skipped and new callbacks wait for the next tick', (timer) => {
  let cancelledCalls = 0;
  let addedCalls = 0;
  let cancelled;
  timer.runOnce(() => {
    timer.cancel(cancelled);
    timer.runOnce(() => addedCalls++, 1);
  }, 1);
  cancelled = timer.runOnce(() => cancelledCalls++, 1);
  timer.onUpdate();
  assert(cancelledCalls === 0 && addedCalls === 0, 'tick must use its original live subscribers');
  timer.onUpdate();
  assert(addedCalls === 1, 'new callback must run on the next tick');
});

test('one-shot callbacks can rearm themselves', (timer) => {
  let calls = 0;
  let sequence;
  sequence = timer.runDebounced(() => {
    calls++;
    if (calls === 1) timer.runDebounced(sequence);
  }, 1);
  timer.onUpdate();
  timer.onUpdate();
  assert(calls === 2 && timer._subscribers.length === 0, 'rearmed callback must survive its first invocation');
});

test('shutdown during dispatch cancels remaining work and cannot be revived', (timer) => {
  let calls = 0;
  timer.runOnce(() => timer.shutdown(), 1);
  timer.runOnce(() => calls++, 1);
  assert(timer.onUpdate() === GLib.SOURCE_REMOVE, 'stopped GLib callback must be removed');
  timer.runOnce(() => calls++, 1);
  assert(!timer.is_running() && timer._subscribers.length === 0 && calls === 0, 'disabled timer must remain shut down');
});

test('restart clears pause and does not run a second old subscriber', (timer) => {
  let calls = 0;
  timer.runOnce(() => timer.restart(), 1);
  timer.runOnce(() => calls++, 1);
  timer.onUpdate();
  assert(calls === 0, 'callbacks after restart belong to the new source');
  timer.pause();
  timer.restart();
  timer.onUpdate();
  assert(calls === 1, 'restarted timer must not inherit its paused state');
});

test('slow animation ticks complete every short cleanup frame', (timer) => {
  const frames = [];
  let bouncing = true;
  const source = [
    { _duration: 10, _func: (frame) => frames.push(frame._time) },
    { _duration: 10, _func: () => { bouncing = false; } },
  ];
  timer.runAnimation(source);
  timer.onUpdate();
  timer.onUpdate();
  assert(frames[0] === 10 && !bouncing, 'animation must reach its terminal state');
  assert(timer._subscribers.length === 0, 'finished animation must unsubscribe');
  assert(source[0]._start === undefined, 'running an animation must not mutate reusable input frames');
});

test('sequences retain elapsed time and empty sequences finish', (timer) => {
  const calls = [];
  timer.runSequence([
    { delay: 10, func: () => calls.push(1) },
    { delay: 10, func: () => calls.push(2) },
  ]);
  timer.runSequence([]);
  timer.onUpdate();
  timer.onUpdate();
  assert(calls.join(',') === '1,2', 'sequence must not double each step delay');
  assert(timer._subscribers.length === 0, 'finished and empty sequences must release subscriptions');
});

test('idle timers hibernate and wake for new subscriptions', (timer) => {
  timer.runOnce(() => {}, 1);
  timer.onUpdate();
  assert(!timer.is_running(), 'the final callback must release its source without extra idle ticks');
  for (let i = 0; i < 25; i++) timer.onUpdate();
  assert(!timer.is_running(), 'empty timer must release its source');
  let calls = 0;
  timer.runOnce(() => calls++, 1);
  timer.onUpdate();
  assert(calls === 1, 'hibernating timer must restart on demand');
});

test('cancelling the final subscriber removes its GLib source immediately', (timer) => {
  const job = timer.runLoop(() => {}, 1000);
  timer.cancel(job);
  assert(!timer.is_running() && timer._subscribers.length === 0,
    'cancellation must not leave an empty timer waking in the background');
});
