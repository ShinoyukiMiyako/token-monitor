'use strict';

(function exposeTokenRate(root, factory) {
  const deviceBreakdownApi = typeof module === 'object' && module.exports
    ? require('./deviceBreakdown')
    : root?.TokenMonitorDeviceBreakdown;
  const api = factory(deviceBreakdownApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTokenRate = api;
})(typeof window !== 'undefined' ? window : null, function createTokenRateApi(deviceBreakdownApi) {
  const TOKEN_RATE_BOOST_DOUBLING_MS = 520;
  const TOKEN_RATE_HOLD_THRESHOLD_MS = 180;
  const TOKEN_RATE_SETTLE_MS = 720;
  const TOKEN_RATE_MAX_DISPLAY_RATE = 1e12;
  const LIVE_TOKEN_RATE_WINDOW_MS = 2 * 60 * 1000;
  const LIVE_TOKEN_RATE_MIN_WINDOW_MS = 30 * 1000;

  function positiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function cappedTokenRate(value) {
    const parsed = Number(value);
    if (Number.isNaN(parsed) || parsed <= 0) return 0;
    return Math.min(TOKEN_RATE_MAX_DISPLAY_RATE, parsed);
  }

  function tokenRateBoostValue(baseRate, elapsedMs, maxRate = TOKEN_RATE_MAX_DISPLAY_RATE) {
    const base = positiveNumber(baseRate);
    const cap = positiveNumber(maxRate) || TOKEN_RATE_MAX_DISPLAY_RATE;
    if (!base) return 0;
    if (base >= cap) return cap;
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const maxElapsed = TOKEN_RATE_BOOST_DOUBLING_MS * Math.log2(cap / base);
    const boundedElapsed = Math.min(elapsed, maxElapsed);
    return Math.min(cap, base * 2 ** (boundedElapsed / TOKEN_RATE_BOOST_DOUBLING_MS));
  }

  function tokenRateSettleValue(fromRate, toRate, elapsedMs, durationMs = TOKEN_RATE_SETTLE_MS) {
    const from = cappedTokenRate(fromRate);
    const to = cappedTokenRate(toRate);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const duration = Number(durationMs);
    const progress = duration >= 0 && Number.isFinite(duration) && duration > 0
      ? Math.min(1, elapsed / duration)
      : duration === 0 ? 1 : Math.min(1, elapsed / TOKEN_RATE_SETTLE_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    return cappedTokenRate(from + (to - from) * eased);
  }

  function tokenRatePerSecond(period) {
    const durationMs = positiveNumber(period?.timedDurationMs);
    const timedOutput = positiveNumber(period?.timedOutputTokens);
    if (!durationMs || !timedOutput) return 0;
    return cappedTokenRate(timedOutput * 1000 / durationMs);
  }

  function tokenBurnPerMinute(period) {
    const durationMs = positiveNumber(period?.timedDurationMs);
    const timed = positiveNumber(period?.timedTokens);
    if (!durationMs || !timed) return 0;
    return cappedTokenRate(timed * 60000 / durationMs);
  }

  function usageCounters(period) {
    if (period?.capabilities?.throughput === false) return null;
    const counter = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    const counters = {
      timedTokens: counter(period?.timedTokens),
      timedOutputTokens: counter(period?.timedOutputTokens),
      timedDurationMs: counter(period?.timedDurationMs)
    };
    return Object.values(counters).every((value) => value !== null) ? counters : null;
  }

  function modelCounters(period) {
    return Object.fromEntries(Object.entries(period.modelThroughput || {})
      .map(([model, counters]) => [model, usageCounters(counters)])
      .filter(([, counters]) => counters));
  }

  // A period is cumulative, so its ratio is necessarily an average. The live headline is the
  // combined throughput of every session on the device: what its counters gained over the
  // last two minutes of its own collection clock, divided by those two minutes. Dividing by
  // the summed message durations instead gives the speed of one average stream, so two
  // sessions generating side by side would read the same as one. The duration gained over
  // the same window, divided by it, is how many streams were generating at once on average.
  //
  // A transcript credits a reply only once it is written, whole duration included, so a
  // window of one snapshot would read a long reply as a burst of parallel streams. Hence the
  // two-minute window, with its start interpolated between the collections around it, and a
  // 30 s floor while the tracker is younger than the window.
  //
  // Model rows keep each model's latest active snapshot delta: they say how fast each model
  // generates, not how much of the total it carries. Without a collection clock there is no
  // window to place counters on, so the headline stays the matched ratio of those deltas (or
  // of the device delta when model attribution is unavailable): durations come from the same
  // tokscale performance entries as both token numerators, never from watcher or wall time.
  // Equal snapshots keep the last sample (limits-only and final-after-preview pushes are
  // common). A counter regression is a new baseline boundary, such as midnight or
  // reconfiguration, and so is a clock running backwards, unless it is a final repeating its
  // preview.
  function createLiveTokenRateTracker({
    now = defaultNow,
    activeMs = 8000,
    windowMs = LIVE_TOKEN_RATE_WINDOW_MS,
    minWindowMs = LIVE_TOKEN_RATE_MIN_WINDOW_MS
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    const lifetime = positiveNumber(activeMs);
    if (!lifetime) throw new TypeError('activeMs must be a positive number');
    const windowSpan = positiveNumber(windowMs);
    if (!windowSpan) throw new TypeError('windowMs must be a positive number');
    const windowFloor = positiveNumber(minWindowMs);
    if (!windowFloor || windowFloor > windowSpan) throw new TypeError('minWindowMs must be positive and no greater than windowMs');
    let history = [];
    let modelBaseline = null;
    let modelSamples = new Map();
    let unattributedSample = null;
    let throughput = null;
    let sample = null;
    let revision = 0;

    function clearSamples() {
      modelSamples = new Map();
      unattributedSample = null;
      throughput = null;
      sample = null;
    }

    function sampleAt(timestamp) {
      const activeModels = [...modelSamples.values()]
        .filter((entry) => timestamp < entry.sampledAt + lifetime);
      const activeUnattributed = unattributedSample && timestamp < unattributedSample.sampledAt + lifetime
        ? unattributedSample
        : null;
      const activeParts = [...activeModels, ...(activeUnattributed ? [activeUnattributed] : [])];
      if (!activeParts.length) return null;
      const delta = { timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 };
      for (const part of activeParts) {
        delta.timedTokens += part.timedTokens;
        delta.timedOutputTokens += part.timedOutputTokens;
        delta.timedDurationMs += part.timedDurationMs;
      }
      return {
        // Concurrency needs elapsed time, so a reading without a window leaves it unmeasured.
        ...(throughput || { speed: tokenRatePerSecond(delta), burn: tokenBurnPerMinute(delta), concurrency: 0, windowMs: 0 }),
        sampledAt: Math.max(...activeParts.map((part) => part.sampledAt)),
        expiresAt: Math.min(...activeParts.map((part) => part.sampledAt + lifetime)),
        revision,
        models: activeModels.map(({ model, speed, burn }) => ({ model, speed, burn })),
        ...delta
      };
    }

    // The device's collection time when the caller knows it. Receipt time is no stand-in: an
    // unchanged record re-pushed for another device would stretch this one's window.
    function collectionTime(observedAt) {
      return typeof observedAt === 'number' && Number.isFinite(observedAt) ? observedAt : null;
    }

    function reset(period, observedAt) {
      const counters = period ? usageCounters(period) : null;
      history = counters ? [{ at: collectionTime(observedAt), counters }] : [];
      modelBaseline = period?.modelThroughput ? modelCounters(period) : null;
      clearSamples();
    }

    // A collection only says what was credited since the previous one, so the counters at
    // an instant between two collections are taken as moving evenly between them.
    function countersAt(time) {
      let index = history.length - 1;
      while (index > 0 && history[index].at > time) index -= 1;
      const before = history[index];
      const after = history[index + 1];
      if (!after || before.at >= time) return before.counters;
      const share = (time - before.at) / (after.at - before.at);
      return Object.fromEntries(Object.keys(before.counters).map((field) =>
        [field, before.counters[field] + (after.counters[field] - before.counters[field]) * share]));
    }

    function windowThroughput(current, at) {
      const start = at - windowSpan;
      const covered = history[0].at <= start;
      const elapsedMs = covered ? windowSpan : Math.max(windowFloor, at - history[0].at);
      const base = covered ? countersAt(start) : history[0].counters;
      return {
        speed: cappedTokenRate((current.timedOutputTokens - base.timedOutputTokens) * 1000 / elapsedMs),
        burn: cappedTokenRate((current.timedTokens - base.timedTokens) * 60000 / elapsedMs),
        concurrency: Math.max(0, (current.timedDurationMs - base.timedDurationMs) / elapsedMs),
        windowMs: elapsedMs
      };
    }

    function observe(period, observedAt) {
      const current = usageCounters(period);
      const models = period?.modelThroughput ? modelCounters(period) : null;
      const previousModels = modelBaseline;
      modelBaseline = models;
      if (!current) {
        history = [];
        clearSamples();
        return null;
      }
      const at = collectionTime(observedAt);
      const last = history[history.length - 1];
      if (!last) {
        history = [{ at, counters: current }];
        return null;
      }

      const stepDelta = {
        timedTokens: current.timedTokens - last.counters.timedTokens,
        timedOutputTokens: current.timedOutputTokens - last.counters.timedOutputTokens,
        timedDurationMs: current.timedDurationMs - last.counters.timedDurationMs
      };
      const clocked = at !== null && last.at !== null;
      const unchanged = Object.values(stepDelta).every((value) => value === 0);
      // Equal counters place nothing in the window, which is how a full scan's final arrives,
      // stamped with its tick's start behind the previews it repeats. A clock set back past the
      // sample is no repeat: the sample's lifetime runs on that clock, so it would read live
      // again until the clock caught up.
      const repeats = unchanged && !(sample && Number(now()) < sample.sampledAt);

      // A clock running backwards cannot place the new counters in the window either: there
      // is no elapsed time to read them against.
      if ((clocked && at < last.at && !repeats) || Object.values(stepDelta).some((value) => value < 0)) {
        history = [{ at, counters: current }];
        clearSamples();
        return null;
      }
      if (!clocked) history = [{ at, counters: current }];
      else if (at > last.at || !unchanged) history.push({ at, counters: current });
      // Keep the last collection at or before the window start: it anchors the interpolation.
      while (history.length > 1 && history[1].at <= at - windowSpan) history.shift();
      if (!(stepDelta.timedDurationMs > 0)) return sample;

      const sampledAt = Number(now()) || 0;
      const nextModels = new Map();
      const attributed = { timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 };
      let attributionConsistent = Boolean(models && previousModels)
        && Object.entries(previousModels).every(([model, previous]) => models[model]
          && Object.keys(previous).every((field) => models[model][field] >= previous[field]));
      if (attributionConsistent) {
        for (const [model, counters] of Object.entries(models)) {
          const previous = previousModels[model] || { timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 };
          const change = Object.fromEntries(Object.keys(counters).map((field) => [field, counters[field] - previous[field]]));
          // A renamed/retroactively attributed model may appear with historical
          // counters. All model deltas together must stay within this snapshot's delta.
          if (Object.keys(change).some((field) => change[field] < 0 || change[field] > stepDelta[field])) {
            attributionConsistent = false;
            break;
          }
          if (change.timedDurationMs > 0) {
            for (const field of Object.keys(attributed)) attributed[field] += change[field];
            nextModels.set(model, {
              model,
              ...change,
              speed: tokenRatePerSecond(change),
              burn: tokenBurnPerMinute(change),
              sampledAt
            });
          } else if (Object.values(change).every((value) => value === 0)) {
            const retained = modelSamples.get(model);
            if (retained && sampledAt < retained.sampledAt + lifetime) nextModels.set(model, retained);
          } else {
            attributionConsistent = false;
            break;
          }
        }
      }
      const remainder = {
        timedTokens: stepDelta.timedTokens - attributed.timedTokens,
        timedOutputTokens: stepDelta.timedOutputTokens - attributed.timedOutputTokens,
        timedDurationMs: stepDelta.timedDurationMs - attributed.timedDurationMs
      };
      if (attributionConsistent
        && Object.values(remainder).every((value) => value >= 0)
        && (remainder.timedDurationMs > 0 || (remainder.timedTokens === 0 && remainder.timedOutputTokens === 0))) {
        modelSamples = nextModels;
        if (remainder.timedDurationMs > 0) {
          unattributedSample = { ...remainder, sampledAt, independent: true };
        } else if (!unattributedSample?.independent || sampledAt >= unattributedSample.sampledAt + lifetime) {
          // Only a consistent remainder is disjoint from the retained model samples.
          // A fallback after re-attribution may include those same models.
          unattributedSample = null;
        }
      } else {
        modelSamples = new Map();
        unattributedSample = { ...stepDelta, sampledAt };
      }
      revision += 1;
      throughput = clocked ? windowThroughput(current, at) : null;
      sample = sampleAt(sampledAt);
      return sample;
    }

    function getSample(timestamp) {
      return timestamp === undefined ? sample : sampleAt(Number(timestamp) || 0);
    }

    function value(mode) {
      if (!sample) return null;
      return mode === 'burn' ? sample.burn : sample.speed;
    }

    return { getSample, observe, reset, value };
  }

  // Hub devices publish independently. Taking one delta from the aggregate would make the
  // headline jump between whichever device happened to upload last, and dividing summed
  // tokens by summed model-busy time would be an average rather than fleet throughput. Keep
  // one matched-counter tracker per device, then add only samples that are still live.
  // `matchedCounters` drops the collection clock from every entry: the plugin liveRate
  // resource documents rates from matched deltas, not the native surfaces' window throughput.
  function createLiveTokenRateGroupTracker({
    now = defaultNow,
    activeMs = 8000,
    clearMs = 180000,
    matchedCounters = false
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    const lifetime = positiveNumber(activeMs);
    if (!lifetime) throw new TypeError('activeMs must be a positive number');
    const clearAfter = positiveNumber(clearMs);
    if (!clearAfter || clearAfter <= lifetime) throw new TypeError('clearMs must be greater than activeMs');
    const trackers = new Map();
    let revision = 0;
    let lastDisplaySample = null;

    function normalizedEntries(entries) {
      const result = [];
      const seen = new Set();
      for (const entry of Array.isArray(entries) ? entries : []) {
        const id = String(entry?.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push({ id, name: String(entry?.name || id), period: entry?.period, observedAt: matchedCounters ? null : entry?.observedAt });
      }
      return result;
    }

    function reset(entries = []) {
      trackers.clear();
      lastDisplaySample = null;
      for (const entry of normalizedEntries(entries)) {
        const tracker = createLiveTokenRateTracker({ now, activeMs: lifetime });
        tracker.reset(entry.period, entry.observedAt);
        trackers.set(entry.id, { tracker, name: entry.name });
      }
    }

    function observe(entries = []) {
      const nextEntries = normalizedEntries(entries);
      const present = new Set(nextEntries.map((entry) => entry.id));
      let changed = false;
      let fresh = false;
      let invalidated = false;

      for (const [id, { tracker }] of trackers) {
        if (present.has(id)) continue;
        if (tracker.getSample()) {
          changed = true;
        }
        trackers.delete(id);
      }

      for (const entry of nextEntries) {
        const device = trackers.get(entry.id);
        if (!device) {
          const tracker = createLiveTokenRateTracker({ now, activeMs: lifetime });
          tracker.reset(entry.period, entry.observedAt);
          trackers.set(entry.id, { tracker, name: entry.name });
          continue;
        }
        device.name = entry.name;
        const { tracker } = device;
        const previous = tracker.getSample();
        const sample = tracker.observe(entry.period, entry.observedAt);
        if (sample === previous) continue;
        changed = true;
        if (sample) fresh = true;
        else if (previous) invalidated = true;
      }

      if (invalidated) lastDisplaySample = null;
      if (fresh) revision += 1;
      return { changed, sample: getSample() };
    }

    function activeSamples() {
      const timestamp = Number(now()) || 0;
      return [...trackers.entries()]
        .map(([id, { tracker, name }]) => {
          const sample = tracker.getSample(timestamp);
          return sample ? { ...sample, id, name } : null;
        })
        .filter(Boolean);
    }

    function getSample() {
      const samples = activeSamples();
      if (samples.length) {
        lastDisplaySample = {
          speed: cappedTokenRate(samples.reduce((sum, sample) => sum + sample.speed, 0)),
          burn: cappedTokenRate(samples.reduce((sum, sample) => sum + sample.burn, 0)),
          concurrency: samples.reduce((sum, sample) => sum + sample.concurrency, 0),
          sampledAt: Math.max(...samples.map((sample) => sample.sampledAt)),
          devices: samples.filter((sample) => sample.models?.length)
            .map(({ id, name, models }) => ({ id, name, models })),
          deviceCount: samples.length,
          revision
        };
        return {
          ...lastDisplaySample,
          expiresAt: Math.min(...samples.map((sample) => sample.expiresAt)),
          idle: false
        };
      }

      // The retained aggregate is presentation-only: expired device samples no longer
      // contribute to live throughput, but the last useful reading stays visible in the
      // dimmed state until it is old enough to be genuinely unavailable.
      const timestamp = Number(now()) || 0;
      const expiresAt = lastDisplaySample?.sampledAt + clearAfter;
      if (!lastDisplaySample || timestamp >= expiresAt) return null;
      return { ...lastDisplaySample, expiresAt, idle: true };
    }

    function nextExpiryAt() {
      return getSample()?.expiresAt || null;
    }

    return { getSample, nextExpiryAt, observe, reset };
  }

  function isSharedSyncMode(hubMode) {
    return hubMode === 'client' || hubMode === 'host' || hubMode === 'icloud';
  }

  // `updatedAt` is when the device collected its usage, on its own clock; the live window
  // only ever compares a device's timestamps with each other, so clock skew between
  // devices cannot distort it.
  function collectedAt(record) {
    const parsed = Date.parse(record?.updatedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function selectLiveTokenRatePeriods(stats, deviceId, hubMode = 'local', scope = 'all') {
    const normalizedDeviceId = String(deviceId || '').trim();
    const syncMode = isSharedSyncMode(hubMode);
    const devices = Array.isArray(stats?.devices) ? stats.devices : [];

    if (syncMode && scope !== 'device') {
      return {
        entries: devices
          .filter((device) => device?.stale !== true && device?.periods?.today && typeof device.periods.today === 'object')
          .map((device) => ({
            id: `device:${String(device.deviceId || 'unknown')}`,
            name: deviceBreakdownApi.deviceLabel(device),
            period: device.periods.today,
            observedAt: collectedAt(device)
          })),
        source: 'devices:all'
      };
    }

    const localDevice = normalizedDeviceId
      ? devices.find((device) => String(device?.deviceId || '') === normalizedDeviceId)
      : null;
    // Local mode owns the aggregate snapshot, so it remains a valid same-device
    // source while startup anchors or a device-id change leave `devices` empty.
    // Sync mode must stay strict: its aggregate may contain other machines.
    const localPeriod = localDevice?.periods?.today
      || (!syncMode ? stats?.periods?.today : null);
    if (localPeriod && typeof localPeriod === 'object') {
      return {
        entries: [{
          id: `device:${normalizedDeviceId}`,
          name: deviceBreakdownApi.deviceLabel(localDevice || { deviceId: normalizedDeviceId }),
          period: localPeriod,
          observedAt: collectedAt(localDevice || stats)
        }],
        source: `device:${normalizedDeviceId}`
      };
    }
    return { entries: [], source: `device:${normalizedDeviceId || 'unavailable'}` };
  }

  function liveTokenRateTooltipEntries(sample, mode, formatRate) {
    const burn = mode === 'burn';
    const unit = burn ? 'TPM' : 'tok/s';
    const devices = sample?.devices || [];
    const grouped = (sample?.deviceCount || devices.length) > 1;
    const entries = [];
    for (const device of devices) {
      if (!device.models?.length) continue;
      if (grouped) entries.push({ full: device.name, separated: entries.length > 0 });
      const models = device.models.slice().sort((a, b) =>
        (burn ? b.burn - a.burn : b.speed - a.speed) || a.model.localeCompare(b.model));
      entries.push(...models.map((entry) => [entry.model, `${formatRate(burn ? entry.burn : entry.speed)} ${unit}`]));
    }
    return entries;
  }

  function defaultNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function defaultRequestFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 16);
  }

  function defaultCancelFrame(frameId) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
    else clearTimeout(frameId);
  }

  function createTokenRateBoostController({
    readValue,
    canStart = () => true,
    prefersReducedMotion = () => false,
    onChange = () => {},
    now = defaultNow,
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
    maxDisplayRate = TOKEN_RATE_MAX_DISPLAY_RATE
  } = {}) {
    if (typeof readValue !== 'function') throw new TypeError('readValue must be a function');
    if (typeof canStart !== 'function') throw new TypeError('canStart must be a function');
    if (typeof prefersReducedMotion !== 'function') throw new TypeError('prefersReducedMotion must be a function');
    if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof requestFrame !== 'function') throw new TypeError('requestFrame must be a function');
    if (typeof cancelFrame !== 'function') throw new TypeError('cancelFrame must be a function');

    const displayCap = positiveNumber(maxDisplayRate) || TOKEN_RATE_MAX_DISPLAY_RATE;
    let state = null;
    let frameId = null;
    let suppressNextClick = false;

    function currentTime() {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    }

    function currentValue() {
      const value = readValue() || {};
      return {
        rate: Math.min(displayCap, cappedTokenRate(value.rate)),
        mode: value.mode === 'burn' || value.burn === true ? 'burn' : 'speed'
      };
    }

    function cancelScheduledFrame() {
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    }

    function notify() {
      onChange();
    }

    function snapshot() {
      if (!state) return null;
      const timestamp = currentTime();
      const elapsed = Math.max(0, timestamp - state.startedAt);
      const settleDuration = state.settleDurationMs ?? TOKEN_RATE_SETTLE_MS;
      const displayRate = state.phase === 'settling'
        ? tokenRateSettleValue(state.settleFromRate, state.settleToRate, timestamp - state.settledAt, settleDuration)
        : tokenRateBoostValue(state.baseRate, elapsed, displayCap);
      return { ...state, displayRate, elapsedMs: elapsed };
    }

    function schedule() {
      if (!state || frameId !== null) return;
      frameId = requestFrame(step);
    }

    function step() {
      frameId = null;
      if (!state) return;
      const timestamp = currentTime();
      if (state.phase === 'settling' && timestamp - state.settledAt >= (state.settleDurationMs ?? TOKEN_RATE_SETTLE_MS)) {
        state = null;
        notify();
        return;
      }
      notify();
      schedule();
    }

    function refresh() {
      if (!state || state.phase !== 'settling') return false;
      const timestamp = currentTime();
      const elapsed = Math.max(0, timestamp - state.settledAt);
      const duration = state.settleDurationMs ?? TOKEN_RATE_SETTLE_MS;
      if (elapsed >= duration) return false;

      const value = currentValue();
      if (value.mode !== state.mode) {
        state = null;
        cancelScheduledFrame();
        suppressNextClick = false;
        return true;
      }
      if (value.rate === state.settleToRate) return false;

      state = {
        ...state,
        settleFromRate: tokenRateSettleValue(state.settleFromRate, state.settleToRate, elapsed, duration),
        settleToRate: value.rate,
        settledAt: timestamp,
        settleDurationMs: duration - elapsed
      };
      return true;
    }

    function matchesPointer(event) {
      return event?.pointerId === undefined || event.pointerId === state?.pointerId;
    }

    function start(event) {
      if (event?.button !== undefined && event.button !== 0) return false;
      const enabled = canStart();
      const reduced = prefersReducedMotion();
      // A new primary pointer sequence cannot belong to a canceled gesture. Clear a guard that
      // was left behind when blur/pointercancel produced no follow-up click; if the canceled
      // gesture does produce one, consumeClick() runs before this next pointerdown instead.
      suppressNextClick = false;
      if (!enabled || reduced) return false;
      if (state && state.phase !== 'settling') return false;
      const value = currentValue();
      if (!(value.rate > 0)) return false;
      if (state?.phase === 'settling') {
        // A second hold is a new gesture, not a mode click. Interrupt the old release animation
        // so the new pointer can own the controller immediately.
        state = null;
        cancelScheduledFrame();
      }
      state = {
        phase: 'boosting',
        baseRate: value.rate,
        mode: value.mode,
        pointerId: event?.pointerId,
        startedAt: currentTime()
      };
      notify();
      schedule();
      return true;
    }

    function release(event) {
      if (!state || state.phase !== 'boosting' || !matchesPointer(event)) return false;
      const timestamp = currentTime();
      const elapsed = Math.max(0, timestamp - state.startedAt);
      if (elapsed < TOKEN_RATE_HOLD_THRESHOLD_MS) {
        state = null;
        cancelScheduledFrame();
        notify();
        return false;
      }
      const value = currentValue();
      state = {
        ...state,
        phase: 'settling',
        settleFromRate: tokenRateBoostValue(state.baseRate, elapsed, displayCap),
        settleToRate: value.rate,
        settledAt: timestamp,
        settleDurationMs: TOKEN_RATE_SETTLE_MS
      };
      suppressNextClick = true;
      notify();
      schedule();
      return true;
    }

    function cancel(event, { preserveSettling = false, suppressClick = true } = {}) {
      if (event?.pointerId !== undefined && !matchesPointer(event)) return false;
      if (preserveSettling && state?.phase === 'settling') return false;
      const hadState = Boolean(state);
      if (!hadState) {
        if (!suppressClick) suppressNextClick = false;
        return false;
      }
      state = null;
      cancelScheduledFrame();
      if (suppressClick) suppressNextClick = true;
      else suppressNextClick = false;
      notify();
      return true;
    }

    function consumeClick() {
      if (!suppressNextClick) return false;
      suppressNextClick = false;
      return true;
    }

    return {
      cancel,
      consumeClick,
      getSnapshot: snapshot,
      refresh,
      release,
      start
    };
  }

  return {
    LIVE_TOKEN_RATE_WINDOW_MS,
    TOKEN_RATE_BOOST_DOUBLING_MS,
    TOKEN_RATE_HOLD_THRESHOLD_MS,
    TOKEN_RATE_MAX_DISPLAY_RATE,
    TOKEN_RATE_SETTLE_MS,
    cappedTokenRate,
    createLiveTokenRateGroupTracker,
    createLiveTokenRateTracker,
    createTokenRateBoostController,
    isSharedSyncMode,
    liveTokenRateTooltipEntries,
    positiveNumber,
    selectLiveTokenRatePeriods,
    tokenBurnPerMinute,
    tokenRateBoostValue,
    tokenRatePerSecond,
    tokenRateSettleValue
  };
});
