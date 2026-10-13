'use strict';

// The collector's default watch host is a child process, because chokidar's
// close() is synchronous and superlinear in watched-directory count, and its
// per-file descriptors would otherwise fill the app's own table (#520).
//
// A child process has its own module registry, so the `chokidar.watch` stubs these
// tests install cannot reach it — an unpinned test would silently watch the
// real filesystem and hold the process open. What those tests actually cover is
// the collector's reaction to watch events (debounce, targeted scope, self-sync
// throttling), and that logic is identical on both hosts, so pinning them to
// the in-process host keeps the coverage exact.
//
// Applied per file rather than per case for the same reason as the source-env
// guard: a test added later should be hermetic by default, not by remembering.
// Worker transport itself is covered separately, in watcherHost.test.js.
const WATCH_HOST_ENV = 'TOKEN_MONITOR_WATCH_IN_PROCESS';
// Pinning the host is no longer enough on its own: roots with nothing to prune
// are handed to a recursive kernel watch, which is not `chokidar.watch` and so
// would slip past these stubs onto the real filesystem — the same "silently
// watch the real tree and hold the process open" failure the host pin exists to
// prevent. Recursive watching has its own tests, in recursiveWatcher.test.js.
const WATCH_RECURSIVE_ENV = 'TOKEN_MONITOR_WATCH_RECURSIVE';

function installInProcessWatchHost(test) {
  let savedHost = null;
  let savedRecursive = null;
  test.beforeEach(() => {
    savedHost = process.env[WATCH_HOST_ENV];
    savedRecursive = process.env[WATCH_RECURSIVE_ENV];
    process.env[WATCH_HOST_ENV] = '1';
    process.env[WATCH_RECURSIVE_ENV] = '0';
  });
  test.afterEach(() => {
    if (savedHost === undefined) delete process.env[WATCH_HOST_ENV];
    else process.env[WATCH_HOST_ENV] = savedHost;
    if (savedRecursive === undefined) delete process.env[WATCH_RECURSIVE_ENV];
    else process.env[WATCH_RECURSIVE_ENV] = savedRecursive;
  });
}

module.exports = { WATCH_HOST_ENV, WATCH_RECURSIVE_ENV, installInProcessWatchHost };
