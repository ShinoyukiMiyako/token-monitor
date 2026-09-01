'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { decideResolver, kimiWorkSessionsRoots, tokscaleThreadEnv } = require('../../src/shared/collector');

test('decideResolver prefers downloaded binary only when it is newer than bundled', () => {
  const bundled = { source: 'bundled', version: '2.1.3', path: '/bundled/tokscale' };
  const downloaded = { source: 'downloaded', version: '2.3.0', path: '/downloaded/tokscale' };

  assert.equal(decideResolver({ downloaded, bundled }), downloaded);
});

test('decideResolver keeps bundled as floor when bundled is same or newer', () => {
  const bundled = { source: 'bundled', version: '2.5.0', path: '/bundled/tokscale' };
  const downloaded = { source: 'downloaded', version: '2.3.0', path: '/downloaded/tokscale' };

  assert.equal(decideResolver({ downloaded, bundled }), bundled);
  assert.equal(decideResolver({ downloaded: { ...downloaded, version: '2.5.0' }, bundled }), bundled);
});

test('decideResolver falls back to JS shim when no bundled binary exists', () => {
  const shim = { source: 'shim', version: '2.1.3', path: '/shim/bin.js' };

  assert.equal(decideResolver({ downloaded: null, bundled: null, shim }), shim);
});

test('kimiWorkSessionsRoots mirrors platform paths and relocated Windows shares', () => {
  const home = '/tmp/token-monitor-home';
  const workSuffix = path.join('kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home', 'sessions');
  const homeAppData = path.join(home, 'AppData', 'Roaming');
  const envAppData = 'C:\\Users\\tester\\AppData\\Roaming';
  assert.deepEqual(kimiWorkSessionsRoots(home, 'darwin'), [path.join(home, 'Library', 'Application Support', workSuffix)]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', { APPDATA: envAppData }), [
    path.join(homeAppData, workSuffix),
    path.join(envAppData, workSuffix)
  ]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', {}), [
    path.join(homeAppData, workSuffix)
  ]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', { APPDATA: '' }), [
    path.join(homeAppData, workSuffix)
  ]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', { APPDATA: '   ' }), [
    path.join(homeAppData, workSuffix),
    path.join('   ', workSuffix)
  ]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', { APPDATA: envAppData }, { useEnvRoots: false }), [
    path.join(homeAppData, workSuffix)
  ]);
  assert.deepEqual(
    kimiWorkSessionsRoots(home, 'win32', { APPDATA: envAppData }, {
      readFileSync: () => JSON.stringify({ shareDir: 'D:\\KimiShare' })
    }),
    [path.join(homeAppData, workSuffix), path.join('D:\\KimiShare', 'daimon', 'runtime', 'kimi-code', 'home', 'sessions')]
  );
  assert.deepEqual(kimiWorkSessionsRoots(home, 'linux'), []);
});

// tokscale sizes its rayon pool to every logical core by default. On a large
// session tree that is dominated by contention, so the cap both cuts CPU and
// removes the whole-machine spike the user actually feels.
test('tokscaleThreadEnv caps the rayon pool by default', () => {
  assert.deepEqual(tokscaleThreadEnv({}), { RAYON_NUM_THREADS: '4' });
  assert.deepEqual(tokscaleThreadEnv({ TOKEN_MONITOR_TOKSCALE_THREADS: '' }), { RAYON_NUM_THREADS: '4' });
  assert.deepEqual(tokscaleThreadEnv({ TOKEN_MONITOR_TOKSCALE_THREADS: '   ' }), { RAYON_NUM_THREADS: '4' });
});

test('tokscaleThreadEnv honours an explicit thread count', () => {
  assert.deepEqual(tokscaleThreadEnv({ TOKEN_MONITOR_TOKSCALE_THREADS: '8' }), { RAYON_NUM_THREADS: '8' });
  assert.deepEqual(tokscaleThreadEnv({ TOKEN_MONITOR_TOKSCALE_THREADS: '1' }), { RAYON_NUM_THREADS: '1' });
  // Fractional input still has to reach rayon as an integer.
  assert.deepEqual(tokscaleThreadEnv({ TOKEN_MONITOR_TOKSCALE_THREADS: '2.9' }), { RAYON_NUM_THREADS: '2' });
});

test('tokscaleThreadEnv expresses "no cap" by leaving the variable unset', () => {
  // rayon rejects an explicit 0, so the opt-out cannot be passed through as one:
  // it has to be the absence of the variable.
  assert.deepEqual(tokscaleThreadEnv({ TOKEN_MONITOR_TOKSCALE_THREADS: '0' }), {});
  assert.deepEqual(tokscaleThreadEnv({ TOKEN_MONITOR_TOKSCALE_THREADS: '-2' }), {});
  assert.deepEqual(tokscaleThreadEnv({ TOKEN_MONITOR_TOKSCALE_THREADS: 'off' }), {});
});
