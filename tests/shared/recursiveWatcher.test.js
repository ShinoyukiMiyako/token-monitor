'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { supportsNativeRecursiveWatch, createRecursiveWatcher } = require('../../src/shared/recursiveWatcher');
const { recursiveWatchCandidates, clientSourceRoots, watchIgnoreMatcher } = require('../../src/shared/collector');

const RECURSIVE_ENV = 'TOKEN_MONITOR_WATCH_RECURSIVE';

function withRecursiveEnv(value, fn) {
  const saved = process.env[RECURSIVE_ENV];
  if (value === undefined) delete process.env[RECURSIVE_ENV];
  else process.env[RECURSIVE_ENV] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[RECURSIVE_ENV];
    else process.env[RECURSIVE_ENV] = saved;
  }
}

// A fake fs.watch that records what it was asked to watch and lets a test drive
// the callback, so these assertions do not depend on real filesystem timing.
function fakeWatch() {
  const calls = [];
  const watch = (dir, options, listener) => {
    const handle = new EventEmitter();
    handle.closed = false;
    handle.close = () => { handle.closed = true; };
    calls.push({ dir, options, listener, handle });
    return handle;
  };
  return { watch, calls };
}

test('supportsNativeRecursiveWatch only claims the platforms whose kernel implements it', () => {
  // Linux is excluded on purpose: Node emulates the flag by adding an inotify
  // watch per directory, which is the cost this module exists to avoid.
  assert.equal(supportsNativeRecursiveWatch('win32'), true);
  assert.equal(supportsNativeRecursiveWatch('darwin'), true);
  assert.equal(supportsNativeRecursiveWatch('linux'), false);
  assert.equal(supportsNativeRecursiveWatch('freebsd'), false);
});

test('createRecursiveWatcher watches each root once, recursively', () => {
  const { watch, calls } = fakeWatch();
  const roots = [path.join(os.tmpdir(), 'tm-a'), path.join(os.tmpdir(), 'tm-b')];
  const watcher = createRecursiveWatcher(roots, {}, { watch });

  assert.equal(calls.length, 2, 'one watch per root, not one per entry');
  assert.deepEqual(calls.map((call) => call.dir), roots);
  for (const call of calls) assert.equal(call.options.recursive, true);
  assert.equal(watcher.watchedRootCount, 2);
});

test('createRecursiveWatcher reports absolute paths for entries inside a root', () => {
  const { watch, calls } = fakeWatch();
  const root = path.join(os.tmpdir(), 'tm-root');
  const events = [];
  createRecursiveWatcher([root], { onEvent: (event, filePath) => events.push([event, filePath]) }, { watch });

  calls[0].listener('change', path.join('deep', 'nested', 'session.jsonl'));
  calls[0].listener('rename', 'added.jsonl');
  // A platform that cannot name the entry still has to attribute to the root,
  // or the collector would drop the event instead of scanning that client.
  calls[0].listener('change', null);

  assert.deepEqual(events, [
    ['change', path.join(root, 'deep', 'nested', 'session.jsonl')],
    ['rename', path.join(root, 'added.jsonl')],
    ['change', root]
  ]);
});

test('createRecursiveWatcher stops delivering events once closed', () => {
  const { watch, calls } = fakeWatch();
  const root = path.join(os.tmpdir(), 'tm-closed');
  const events = [];
  const watcher = createRecursiveWatcher([root], { onEvent: (...args) => events.push(args) }, { watch });

  watcher.close();
  calls[0].listener('change', 'late.jsonl');

  assert.equal(calls[0].handle.closed, true);
  assert.deepEqual(events, [], 'an event after close must not reach the collector');
});

test('createRecursiveWatcher survives one unwatchable root and reports it asynchronously', async () => {
  const failing = path.join(os.tmpdir(), 'tm-missing');
  const working = path.join(os.tmpdir(), 'tm-ok');
  const errors = [];
  const watch = (dir, options, listener) => {
    if (dir === failing) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const handle = new EventEmitter();
    handle.close = () => {};
    handle.listener = listener;
    return handle;
  };

  const watcher = createRecursiveWatcher([failing, working], { onError: (error) => errors.push(error) }, { watch });
  assert.equal(watcher.watchedRootCount, 1, 'the healthy root is still watched');
  assert.deepEqual(errors, [], 'not reported synchronously — no listener could be attached yet');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ENOENT');
});

test('recursiveWatchCandidates keeps every root on the walk when polling', () => {
  const dirs = [path.join(os.tmpdir(), 'tm-poll')];
  const split = withRecursiveEnv('1', () => recursiveWatchCandidates(dirs, 'claude', { usePolling: true }));
  // Polling exists for filesystems that never deliver native events, and is also
  // the descriptor-exhaustion fallback — handing out native watches there is
  // exactly wrong.
  assert.deepEqual(split.recursive, []);
  assert.deepEqual(split.walked, dirs);
});

test('recursiveWatchCandidates honours the env override in both directions', () => {
  const dirs = [path.join(os.tmpdir(), 'tm-override')];

  const off = withRecursiveEnv('0', () => recursiveWatchCandidates(dirs, 'claude', { platform: 'win32' }));
  assert.deepEqual(off.recursive, [], 'an explicit 0 forces the per-directory walk');
  assert.deepEqual(off.walked, dirs);

  const on = withRecursiveEnv('1', () => recursiveWatchCandidates(dirs, 'claude', { platform: 'linux' }));
  assert.deepEqual(on.recursive, dirs, 'an explicit 1 opts in even where it is not the default');
});

test('recursiveWatchCandidates follows the platform default when unset', () => {
  const dirs = [path.join(os.tmpdir(), 'tm-default')];

  const linux = withRecursiveEnv(undefined, () => recursiveWatchCandidates(dirs, 'claude', { platform: 'linux' }));
  assert.deepEqual(linux.recursive, []);

  const windows = withRecursiveEnv(undefined, () => recursiveWatchCandidates(dirs, 'claude', { platform: 'win32' }));
  assert.deepEqual(windows.recursive, dirs);
});

test('recursiveWatchCandidates never hands a pruned root to the kernel', () => {
  // Copilot's workspaceStorage is watched but pruned to chatSessions +
  // workspace.json; Hermes and MiMo are the same shape. A recursive watch cannot
  // decline to descend, so routing one there would make every unrelated write
  // under it a scan trigger — the issue #38 runaway.
  const clients = 'claude,copilot,hermes,micode';
  const roots = clientSourceRoots(clients);
  const isPruned = watchIgnoreMatcher(clients);
  assert.ok(typeof isPruned === 'function', 'this client set must actually have pruning policies');

  const prunedRoots = [];
  for (const clientRoots of Object.values(roots)) {
    for (const root of clientRoots) {
      // A root whose own child is ignored is a pruned root.
      if (isPruned(path.join(root.dir, 'zzz-unrelated-runtime-file'))) prunedRoots.push(root.dir);
    }
  }
  assert.ok(prunedRoots.length > 0, 'expected at least one pruned root in this client set');

  const split = withRecursiveEnv('1', () => recursiveWatchCandidates(prunedRoots, clients, { platform: 'win32' }));
  assert.deepEqual(split.recursive, [], 'no pruned root may be watched recursively');
  assert.deepEqual(new Set(split.walked), new Set(prunedRoots));
});

test('recursiveWatchCandidates refuses a root that merely contains a pruned one', () => {
  const clients = 'claude,copilot,hermes,micode';
  const roots = clientSourceRoots(clients);
  const isPruned = watchIgnoreMatcher(clients);
  let prunedRoot = '';
  for (const clientRoots of Object.values(roots)) {
    for (const root of clientRoots) {
      if (!prunedRoot && isPruned(path.join(root.dir, 'zzz-unrelated-runtime-file'))) prunedRoot = root.dir;
    }
  }
  assert.ok(prunedRoot, 'expected a pruned root to build the parent case from');

  // Watching the parent recursively would silently re-cover the pruned child and
  // undo its policy, so containment has to be rejected in this direction too.
  const parent = path.dirname(prunedRoot);
  const split = withRecursiveEnv('1', () => recursiveWatchCandidates([parent], clients, { platform: 'win32' }));
  assert.deepEqual(split.recursive, [], 'a parent of a pruned root must keep the walk');
  assert.deepEqual(split.walked, [parent]);
});

test('recursiveWatchCandidates sends an unpruned session tree to the kernel', () => {
  // The whole point: ~/.claude/projects is the tree with tens of thousands of
  // entries and no pruning policy, so it must be the one that gets a single
  // recursive watch.
  const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
  const split = withRecursiveEnv('1', () => recursiveWatchCandidates([claudeProjects], 'claude', { platform: 'win32' }));
  assert.deepEqual(split.recursive, [claudeProjects]);
  assert.deepEqual(split.walked, []);
});
