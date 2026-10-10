'use strict';

// minScanIntervalMs: the floor between the starts of two watch-triggered scans.
// The debounce collapses a burst, but a steady write cadence slower than the
// debounce passes every write through to a scan; the floor is what bounds that.

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { installSourceEnvGuard } = require('../helpers/sourceEnv');
const { installInProcessWatchHost } = require('../helpers/watchHost');

const collectorPath = require.resolve('../../src/shared/collector');

installSourceEnvGuard(test);
installInProcessWatchHost(test);

function waitForCondition(predicate, timeoutMs = 3000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (performance.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Timed out waiting for condition'));
      }
    }, 5);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A collector over a temp home, with chokidar and tokscale stubbed. `run`
// receives the watch handler and the list of tick reasons.
async function withCollector(options, run) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'token-monitor-floor-'));
  fs.mkdirSync(path.join(tmp, '.claude', 'projects'), { recursive: true });
  const originalHomedir = os.homedir;
  os.homedir = () => tmp;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => ({
    on: (event, handler) => { if (event === 'all') watchHandler = handler; },
    close: () => {}
  });
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    }, 5);
    return child;
  };

  let handle = null;
  try {
    delete require.cache[collectorPath];
    const { startCollector } = require(collectorPath);
    const updates = [];
    const startedAt = performance.now();
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 5000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchDebounceMs: 10,
      limitsEnabled: false,
      historyEnabled: false,
      ...options,
      onUpdate: (_summary, reason) => updates.push({ reason, at: performance.now() })
    });
    await waitForCondition(() => updates.length === 1);
    assert.ok(watchHandler, 'watcher handler captured');
    await run({ fire: () => watchHandler('change', path.join(tmp, '.claude', 'projects', 'p', 's.jsonl')), updates, startedAt });
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const watchTicks = (updates) => updates.filter(({ reason }) => reason.startsWith('watch:'));

test('a watch event right after a scan waits out the floor, then scans once', async () => {
  await withCollector({ minScanIntervalMs: 1500 }, async ({ fire, updates, startedAt }) => {
    // A burst inside the floor: every event re-arms, none of them scans early.
    for (let index = 0; index < 5; index += 1) {
      fire();
      await delay(20);
    }
    await delay(200);
    assert.deepEqual(watchTicks(updates).map(({ reason }) => reason), [], 'nothing scans inside the floor');

    await waitForCondition(() => watchTicks(updates).length === 1);
    const [tick] = watchTicks(updates);
    // The startup scan began after startCollector was called and the watch
    // tick is reported after its own scan began, so this can only understate
    // the real gap between the two scan starts.
    assert.ok(tick.at - startedAt >= 1500, `scanned ${Math.round(tick.at - startedAt)}ms after the collector started`);
    await delay(100);
    assert.equal(watchTicks(updates).length, 1, 'the burst cost one scan');
  });
});

test('a floor of 0, or none given, leaves the debounce cadence alone', async () => {
  for (const options of [{ minScanIntervalMs: 0 }, {}]) {
    await withCollector(options, async ({ fire, updates }) => {
      fire();
      await waitForCondition(() => watchTicks(updates).length === 1, 400);
    });
  }
});
