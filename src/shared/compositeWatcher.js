'use strict';

// One watcher object over two watch strategies.
//
// Watch roots are not interchangeable. A root that needs pruning (Hermes'
// runtime tree, MiMo's logs, Copilot's workspaceStorage) must keep chokidar,
// which can refuse to descend into an ignored directory. A root with nothing to
// prune — the session trees, which are the ones with tens of thousands of
// entries — is far better served by a single recursive kernel watch.
// recursiveWatchCandidates() draws that line and openWatch() applies it; this
// joins the two halves back into something the hosts can treat as one watcher.
//
// The surface is deliberately the subset of chokidar's that the hosts already
// use — on/once('all'|'error'|'ready') and an awaitable close() — so the watch
// process keeps its revision fencing and close serialisation untouched.

const { EventEmitter } = require('node:events');

// `walked` and `options` are what chokidar.watch would have been handed for the
// roots that keep the per-directory walk; `recursive` are the roots that go to
// the kernel. The caller decides the split, so this module needs nothing from
// the collector and the two can be required in either order.
function createCompositeWatcher({ chokidar, recursive = [], walked = [], options = {} }, deps = {}) {
  const { createRecursiveWatcher } = deps.recursiveWatcher || require('./recursiveWatcher');

  const emitter = new EventEmitter();
  const closers = [];

  // Ready means every half is up. Firing on the first one would let a caller
  // treat a partially armed watch as complete.
  let pendingReady = (recursive.length > 0 ? 1 : 0) + (walked.length > 0 ? 1 : 0);
  const settleReady = () => {
    pendingReady -= 1;
    if (pendingReady <= 0) emitter.emit('ready');
  };

  if (recursive.length > 0) {
    const recursiveWatcher = createRecursiveWatcher(recursive, {
      onEvent: (event, filePath) => emitter.emit('all', event, filePath),
      onError: (error) => emitter.emit('error', error),
      onReady: settleReady
    });
    closers.push(() => recursiveWatcher.close());
  }

  if (walked.length > 0) {
    const watcher = chokidar.watch(walked, options);
    watcher.on('all', (event, filePath) => emitter.emit('all', event, filePath));
    watcher.on('error', (error) => emitter.emit('error', error));
    watcher.on('ready', settleReady);
    closers.push(() => watcher.close());
  }

  // No roots at all still has to reach ready, or a caller waiting on it hangs.
  if (pendingReady === 0) setImmediate(() => emitter.emit('ready'));

  // Awaited by the watch process before it opens the next watcher, so a
  // chokidar close (the async, descriptor-owning one) must be awaited here too.
  emitter.close = async () => {
    const pending = closers.splice(0, closers.length);
    for (const closeOne of pending) {
      try { await closeOne(); } catch (_) { /* teardown must not throw */ }
    }
  };
  emitter.watchedRootCounts = { recursive: recursive.length, walked: walked.length };
  return emitter;
}

module.exports = { createCompositeWatcher };
