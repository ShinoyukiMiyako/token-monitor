'use strict';

// An install request stands the app's forced exit down, and quitAndInstall()
// never reports back whether the installer took over. If nothing gives the quit
// flags back, the user is left in an app that only a restart can close.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createUpdateInstallQuitGuard,
  observeUpdateInstallHandoff
} = require('../../src/electron/updateInstallQuit');
const { installFailureErrorKind, updateInstallQuitPolicy } = require('../../src/shared/appUpdater');

// Records the flag movements as an ordered log and hands the grace period back as
// something the test fires by hand, so every transition is observable. Defaults to
// the macOS shape, where a spent attempt can never be repeated.
function harness({ graceMs = 10_000, watchdogEnabled = true, singleUseAttempt = true } = {}) {
  const events = [];
  const timers = [];
  const handoffs = [];
  const guard = createUpdateInstallQuitGuard({
    graceMs,
    singleUseAttempt,
    watchdogEnabled: () => watchdogEnabled,
    claim: () => events.push('claim'),
    release: () => events.push('release'),
    onStalled: () => events.push('stalled'),
    onHandoff: (afterStalledReport) => handoffs.push(afterStalledReport),
    setTimeoutFn: (fn, ms) => {
      const handle = {
        fn,
        ms,
        cleared: false,
        unrefCount: 0,
        unref() { this.unrefCount += 1; }
      };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => { if (handle) handle.cleared = true; }
  });
  return { guard, events, timers, handoffs, fire: (index = timers.length - 1) => timers[index].fn() };
}

test('a request claims the flags and arms exactly one grace period', () => {
  const { guard, events, timers } = harness();
  assert.equal(guard.request(), true);
  assert.deepEqual(events, ['claim']);
  assert.equal(guard.phase(), 'requested');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10_000);
  // The fallback must never be the reason the process stays up.
  assert.equal(timers[0].unrefCount, 1);
});

test('a second request while one is outstanding changes nothing', () => {
  const { guard, events, timers } = harness();
  guard.request();
  assert.equal(guard.request(), false);
  assert.deepEqual(events, ['claim']);
  assert.equal(timers.length, 1);
  assert.equal(guard.phase(), 'requested');
});

test('an expired claim gives the flags back before it reports', () => {
  const { guard, events, fire } = harness();
  guard.request();
  fire();
  // Release first: the app has to be quittable whether or not anyone is watching
  // the error that follows.
  assert.deepEqual(events, ['claim', 'release', 'stalled']);
});

test('the hand-off cancels the grace period', () => {
  const { guard, events, timers } = harness();
  guard.request();
  assert.equal(guard.noteHandoff(), true);
  assert.equal(timers[0].cleared, true);
  assert.equal(guard.phase(), 'handoff');
  assert.deepEqual(events, ['claim', 'claim']);
});

test('an expiry that fires after the hand-off releases nothing', () => {
  const { guard, events, timers, fire } = harness();
  guard.request();
  guard.noteHandoff();
  events.length = 0;
  // The timer is cancelled, so this is the belt: releasing here would let the
  // forced exit pre-empt an installer already swapping the app out.
  fire(0);
  assert.deepEqual(events, []);
  assert.equal(guard.phase(), 'handoff');
  assert.equal(timers.length, 1);
});

test('a stray hand-off with nothing outstanding is ignored', () => {
  const { guard, events } = harness();
  // Honouring it would stand the forced exit down for the session with no install
  // running and nothing ever coming to release it.
  assert.equal(guard.noteHandoff(), false);
  assert.equal(guard.phase(), 'idle');
  assert.deepEqual(events, []);
});

test('the watchdog is not armed when the hand-off cannot be observed', () => {
  const { guard, events, timers } = harness({ watchdogEnabled: false });
  // Expiring with nothing able to re-claim would let a late hand-off race the
  // forced exit. Holding the claim is the lesser failure.
  assert.equal(guard.request(), true);
  assert.equal(timers.length, 0);
  assert.equal(guard.phase(), 'requested');
  assert.deepEqual(events, ['claim']);
});

// A single-use attempt is the macOS shape: MacUpdater attaches an anonymous
// nativeUpdater 'update-downloaded' listener before starting Squirrel and nothing
// ever detaches it, so the call cannot be repeated however it ends.

test('a spent attempt keeps the flags released and refuses another install', () => {
  const { guard, events, timers, fire } = harness();
  guard.request();
  fire();
  assert.equal(guard.phase(), 'spent');
  assert.equal(guard.request(), false);
  assert.deepEqual(events, ['claim', 'release', 'stalled']);
  assert.equal(timers.length, 1);
});

test('an error spends the attempt too, so a retry cannot stack a listener', () => {
  const { guard, events, timers } = harness();
  guard.request();
  // The error path used to return straight to idle, which reopened exactly the
  // hole the expiry path had just been fixed for.
  assert.equal(guard.abort(), true);
  assert.equal(guard.phase(), 'spent');
  assert.equal(guard.request(), false);
  assert.deepEqual(events, ['claim', 'release']);
  assert.equal(timers.length, 1);
});

test('a hand-off still lands on a spent attempt, and says the report was wrong', () => {
  const { guard, events, handoffs, fire } = harness();
  guard.request();
  fire();
  // Squirrel finishing after we stopped waiting still has to win: the installer is
  // about to swap the app out.
  assert.equal(guard.noteHandoff(), true);
  assert.equal(guard.phase(), 'handoff');
  assert.deepEqual(events, ['claim', 'release', 'stalled', 'claim']);
  // The bound was a decision to stop waiting, not proof the installer was dead, so
  // whoever reported the stall has to be told it was withdrawn.
  assert.deepEqual(handoffs, [true]);
});

test('a hand-off within the grace period withdraws nothing', () => {
  const { guard, handoffs } = harness();
  guard.request();
  guard.noteHandoff();
  assert.deepEqual(handoffs, [false]);
});

test('a refused hand-off reports nothing at all', () => {
  const { guard, handoffs } = harness();
  assert.equal(guard.noteHandoff(), false);
  assert.deepEqual(handoffs, []);
});

test('a second error on a spent attempt is not reported again', () => {
  const { guard, events, fire } = harness();
  guard.request();
  fire();
  events.length = 0;
  // The stall was already reported; a late error must not surface a second time.
  assert.equal(guard.abort(), false);
  assert.equal(guard.phase(), 'spent');
  assert.deepEqual(events, []);
});

// Where the request leaves nothing behind, a failed attempt may be retried:
// BaseUpdater resets quitAndInstallCalled whenever install() returns false.

test('a repeatable attempt returns to idle on expiry and allows a retry', () => {
  const { guard, events, timers, fire } = harness({ singleUseAttempt: false });
  guard.request();
  fire();
  assert.equal(guard.phase(), 'idle');
  assert.deepEqual(events, ['claim', 'release', 'stalled']);
  assert.equal(guard.request(), true);
  assert.equal(timers.length, 2);
});

test('a repeatable attempt returns to idle on an error and allows a retry', () => {
  const { guard, timers } = harness({ singleUseAttempt: false });
  guard.request();
  assert.equal(guard.abort(), true);
  assert.equal(guard.phase(), 'idle');
  assert.equal(guard.request(), true);
  assert.equal(timers.length, 2);
});

test('abort reports whether anything was outstanding', () => {
  const { guard, events, timers } = harness();
  // An updater error with no install pending belongs to a check, not an install.
  assert.equal(guard.abort(), false);
  assert.deepEqual(events, []);

  guard.request();
  assert.equal(guard.abort(), true);
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(events, ['claim', 'release']);
});

test('abort releases from the hand-off too', () => {
  const { guard, events } = harness();
  guard.request();
  guard.noteHandoff();
  // An error after the hand-off means the installer reported failure instead of
  // restarting us, so the app has to be quittable again.
  assert.equal(guard.abort(), true);
  assert.deepEqual(events, ['claim', 'claim', 'release']);
});

test('a spent attempt is reported as blocked, and nothing else is', () => {
  const { guard, fire } = harness();
  assert.equal(guard.isSpent(), false);
  guard.request();
  assert.equal(guard.isSpent(), false);
  fire();
  assert.equal(guard.isSpent(), true);

  const handed = harness();
  handed.guard.request();
  handed.guard.noteHandoff();
  assert.equal(handed.guard.isSpent(), false);

  // A platform that can retry never reaches it at all.
  const retryable = harness({ singleUseAttempt: false });
  retryable.guard.request();
  retryable.fire();
  assert.equal(retryable.guard.isSpent(), false);
});

test('only an install this process can still finish counts as busy', () => {
  const { guard } = harness();
  assert.equal(guard.isInstalling(), false);
  guard.request();
  assert.equal(guard.isInstalling(), true);
  guard.noteHandoff();
  assert.equal(guard.isInstalling(), true);

  const stalled = harness();
  stalled.guard.request();
  stalled.fire();
  // Spent is over, not busy: treating it as busy would disable checking for
  // updates for the rest of the session.
  assert.equal(stalled.guard.phase(), 'spent');
  assert.equal(stalled.guard.isInstalling(), false);
  // But still outstanding, which is what the download boundary asks: nothing this
  // process downloads can be installed now, and starting the lifecycle again is
  // what re-enters MacUpdater against a listener that never came off.
  assert.equal(stalled.guard.isOutstanding(), true);
});

test('a spent attempt still holds the updater, because it can come back', () => {
  // The sequence this rules out, all of it reachable: an install stalls past the
  // bound and goes `spent`, a check starts because the install looks over, the slow
  // Squirrel finally answers and the late hand-off re-claims the flags, and then
  // the check fails. Its failure arrives on the same event an install failure does,
  // so it aborts a hand-off that was real and releases skipForcedQuit with the
  // installer owning the exit.
  const { guard, events, fire } = harness();
  guard.request();
  fire();
  assert.equal(guard.phase(), 'spent');
  assert.equal(guard.isInstalling(), false, 'the install is over as far as the UI goes');
  // But not as far as the updater goes, which is the distinction the gate needs.
  assert.equal(guard.isOutstanding(), true, 'a check must not start here');

  guard.noteHandoff();
  assert.equal(guard.phase(), 'handoff');
  assert.deepEqual(events.slice(-1), ['claim'], 'the late hand-off takes the flags back');

  // And this is what a check error would have done to it.
  assert.equal(guard.abort(), true);
  assert.deepEqual(events.slice(-1), ['release']);
});

test('the same-tick install paths get a short bound and stay retryable', () => {
  // NsisUpdater and AppImageUpdater run install() synchronously and emit the
  // hand-off from a setImmediate, so a working install is gone within a tick, and
  // a failed one leaves electron-updater reset.
  for (const platform of ['win32', 'linux']) {
    const policy = updateInstallQuitPolicy(platform);
    assert.equal(policy.singleUseAttempt, false, platform);
    assert.ok(policy.graceMs >= 5_000, `${platform} must not race a next-tick quit`);
    assert.ok(policy.graceMs <= 60_000, `${platform} must not leave an unquittable app sitting`);
  }
});

test('macOS gets a long bound and a single-use attempt', () => {
  // With autoInstallOnAppQuit off, quitAndInstall() is where Squirrel starts from
  // scratch: pull the zip back through the local proxy, validate the signature,
  // stage the swap. Seconds to tens of seconds is normal, so a bound anywhere near
  // the same-tick one would expire on working installs. And the call attaches a
  // listener nothing can detach, so it may not be repeated.
  const policy = updateInstallQuitPolicy('darwin');
  assert.equal(policy.singleUseAttempt, true);
  assert.ok(policy.graceMs >= 2 * 60 * 1000, 'a normal install must never reach the bound');
  assert.ok(policy.graceMs > updateInstallQuitPolicy('win32').graceMs * 10);
});

test('a terminal failure advises a restart only where nothing else is left', () => {
  // Restarting is the recovery of last resort. An attempt the guard handed back is
  // one press from another install, and sending that user through a restart is the
  // long way round to the same place.
  assert.equal(installFailureErrorKind({ spent: false, stalled: true }), 'installer-did-not-start');
  assert.equal(installFailureErrorKind({ spent: true, stalled: true }), 'installer-did-not-start-spent');
  assert.equal(installFailureErrorKind({ spent: true }), 'install-spent-by-failure');
  // A reported failure that left the attempt intact has nothing to add: the panel
  // still offers the update, so the updater's own message is the whole story.
  assert.equal(installFailureErrorKind({ spent: false }), null);
  assert.equal(installFailureErrorKind(), null);
});

// The observer has to report a listener that is genuinely attached. Optional
// chaining over a missing emitter no-ops in silence, and a watchdog armed on that
// would release the quit flags with nothing able to reclaim them.

test('the observer refuses anything that is not an event emitter', () => {
  const onHandoff = () => {};
  assert.equal(observeUpdateInstallHandoff(undefined, onHandoff), false);
  assert.equal(observeUpdateInstallHandoff(null, onHandoff), false);
  assert.equal(observeUpdateInstallHandoff({}, onHandoff), false);
  assert.equal(observeUpdateInstallHandoff({ on: 'not a function' }, onHandoff), false);
});

test('the observer reports a registration that threw as a failure', () => {
  const emitter = { on() { throw new Error('unsupported platform'); } };
  assert.equal(observeUpdateInstallHandoff(emitter, () => {}), false);
});

test('the observer attaches the hand-off event and reports success', () => {
  const attached = [];
  const emitter = { on: (event, listener) => attached.push([event, listener]) };
  const onHandoff = () => {};
  assert.equal(observeUpdateInstallHandoff(emitter, onHandoff), true);
  assert.deepEqual(attached, [['before-quit-for-update', onHandoff]]);
});
