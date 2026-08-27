'use strict';

// A recursive filesystem watch that costs one descriptor per root instead of one
// per entry.
//
// chokidar walks the tree and installs a separate fs.watch on every directory
// *and* every file it finds. On a real ~/.claude/projects (943 dirs / 10.5k
// files) that is 11,526 handles and ~6.8s of setup, and both numbers grow with
// every session the user ever had — the "it gets slower the longer you use it"
// shape. The same tree through one recursive fs.watch is 1 handle and ~0.6ms,
// because the kernel does the recursion (ReadDirectoryChangesW / FSEvents).
//
// We take this only where the OS implements it. On Linux Node emulates the flag
// by walking the tree and adding an inotify watch per directory, which is the
// cost we are trying to avoid and would push a large tree into the per-user
// inotify budget the collector already has a polling fallback for.
//
// What is deliberately given up: chokidar's per-entry bookkeeping, so events
// arrive as the raw ('rename' | 'change') pair rather than add/unlink/addDir,
// and there is no awaitWriteFinish. Neither matters to the collector — it uses
// the path to attribute the event to a client and the event name only to build a
// log string, and it debounces before scanning anyway. What is NOT given up is
// pruning: a root that needs an `ignored` policy is never handed to this
// watcher, because a recursive watch cannot decline to descend.

const fs = require('node:fs');
const path = require('node:path');

const NATIVE_RECURSIVE_PLATFORMS = new Set(['win32', 'darwin']);

function supportsNativeRecursiveWatch(platform = process.platform) {
  return NATIVE_RECURSIVE_PLATFORMS.has(platform);
}

// Mirrors the shape the watcher hosts already expect from chokidar: an object
// with close(), driven through onEvent/onError/onReady callbacks.
function createRecursiveWatcher(dirs = [], handlers = {}, deps = {}) {
  const watch = deps.watch || fs.watch;
  const watchers = [];
  let closed = false;

  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { recursive: true, persistent: true }, (eventType, filename) => {
        if (closed) return;
        // filename is relative to the watched root, and null when the platform
        // cannot name the entry — in that case the root itself is the most
        // specific path we can honestly report.
        const target = filename ? path.join(dir, String(filename)) : dir;
        handlers.onEvent?.(eventType === 'rename' ? 'rename' : 'change', target);
      });
      // Errors arrive asynchronously here exactly as they do from chokidar, so
      // the descriptor-exhaustion fallback upstream keeps working unchanged.
      watcher.on('error', (error) => { if (!closed) handlers.onError?.(error); });
      watchers.push(watcher);
    } catch (error) {
      // A root that cannot be watched must not take the others down with it.
      // Reported on a later turn, like every asynchronous watch error, so a
      // caller still wiring up its listeners cannot miss it — or, with an
      // EventEmitter in between, be handed an 'error' that has none yet.
      setImmediate(() => { if (!closed) handlers.onError?.(error); });
    }
  }

  // Nothing to enumerate, so readiness is immediate — but stay asynchronous so
  // callers see the same "ready after the current turn" ordering chokidar gives.
  if (typeof handlers.onReady === 'function') setImmediate(() => { if (!closed) handlers.onReady(); });

  return {
    kind: 'recursive',
    watchedRootCount: watchers.length,
    close() {
      closed = true;
      for (const watcher of watchers) {
        try { watcher.close(); } catch (_) { /* teardown must not throw */ }
      }
      watchers.length = 0;
    }
  };
}

module.exports = {
  supportsNativeRecursiveWatch,
  createRecursiveWatcher
};
