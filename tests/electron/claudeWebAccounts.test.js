'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createClaudeWebAccounts } = require('../../src/electron/providers/claude/webAccounts');

// What a successful probe of each cookie resolves to.
const IDENTITIES = {
  'sessionKey=sk-ant-new': { accountKey: 'sha256:new', accountEmail: 'new@example.com', accountName: 'New Org', accountLabel: 'Pro' },
  'sessionKey=sk-ant-other': { accountKey: 'sha256:other', accountEmail: 'other@example.com', accountName: 'Other Org', accountLabel: 'Max 5x' }
};

// The main-process collaborators, recorded so each test can assert what the
// module asked for rather than only what it returned.
function harness(initialSettings = {}, { fetchLimits } = {}) {
  let settings = { limitProviders: 'codex', ...initialSettings };
  const calls = { saves: 0, patches: [], pushes: 0, invalidations: [], probes: [] };
  const ids = ['id-1', 'id-2', 'id-3', 'id-4'];
  const store = createClaudeWebAccounts({
    getSettings: () => settings,
    saveSettings: () => { calls.saves += 1; },
    applySettingsPatch: (patch) => {
      calls.patches.push(patch);
      settings = { ...settings, ...patch };
      return settings;
    },
    pushSettings: () => { calls.pushes += 1; },
    invalidateLimits: (reason) => calls.invalidations.push(reason),
    probeDeps: (renewed) => ({ renewed }),
    fetchLimits: fetchLimits || (async (options, deps) => {
      calls.probes.push({ options, env: deps.env });
      const identity = IDENTITIES[options.claudeWebCookie];
      if (!identity) {
        const error = new Error('unauthorized');
        error.status = 'unauthorized';
        throw error;
      }
      return { provider: 'claude', status: 'ok', ...identity };
    }),
    randomId: () => ids.shift()
  });
  return { store, calls, settings: () => settings };
}

test('adding a login probes that cookie alone, then stores it with its identity and selects Claude', async () => {
  const { store, calls, settings } = harness();

  assert.deepEqual(await store.add('sk-ant-new', ''), { ok: true, status: 'ok' });

  assert.deepEqual(calls.probes, [{
    options: { claudeWebCookie: 'sessionKey=sk-ant-new', claudeWebOrganizationId: '' },
    env: {}
  }]);
  assert.deepEqual(settings().claudeWebAccounts, [{
    id: 'id-1',
    cookie: 'sessionKey=sk-ant-new',
    organizationId: '',
    ...IDENTITIES['sessionKey=sk-ant-new']
  }]);
  assert.equal(calls.saves, 1);
  assert.deepEqual(calls.patches, [{ limitProviders: 'claude,codex', limitsEnabled: true }]);
  assert.equal(calls.pushes, 1);
  assert.deepEqual(calls.invalidations, ['login']);
});

test('the first added login moves the form cookie into the list beside it', async () => {
  const { store, calls, settings } = harness({
    claudeWebCookie: 'sessionKey=sk-ant-form',
    claudeWebOrganizationId: 'org-form'
  });

  assert.equal((await store.add('sessionKey=sk-ant-new')).ok, true);

  // The form's login has no identity yet: the refresh that follows records it.
  assert.deepEqual(settings().claudeWebAccounts.map(({ id, cookie, organizationId, accountKey }) => (
    { id, cookie, organizationId, accountKey }
  )), [
    { id: 'id-2', cookie: 'sessionKey=sk-ant-form', organizationId: 'org-form', accountKey: '' },
    { id: 'id-1', cookie: 'sessionKey=sk-ant-new', organizationId: '', accountKey: 'sha256:new' }
  ]);
  assert.deepEqual(calls.patches, [{
    claudeWebCookie: '',
    claudeWebOrganizationId: '',
    limitProviders: 'claude,codex',
    limitsEnabled: true
  }]);
  assert.equal(settings().claudeWebCookie, '');
});

test('a cookie claude.ai rejects, or that is not a session key, is never stored', async () => {
  const { store, calls, settings } = harness({ claudeWebCookie: 'sessionKey=sk-ant-form' });

  assert.deepEqual(await store.add('sk-ant-revoked'), { ok: false, status: 'unauthorized', errorCode: '' });
  assert.deepEqual(await store.add('sessionKey=abc; other=1'), {
    ok: false,
    status: 'invalid',
    errorCode: 'INVALID_CLAUDE_WEB_SESSION_KEY'
  });
  assert.deepEqual(await store.add('   '), { ok: false, status: 'notConfigured', errorCode: 'INVALID_CLAUDE_WEB_SESSION_KEY' });

  assert.equal(calls.probes.length, 1, 'only the well-formed cookie reaches claude.ai');
  assert.equal(settings().claudeWebAccounts, undefined);
  assert.equal(settings().claudeWebCookie, 'sessionKey=sk-ant-form', 'a failed add leaves the form cookie where it was');
  assert.deepEqual([calls.saves, calls.patches.length, calls.invalidations.length], [0, 0, 0]);
});

test('an account in several organizations is offered them instead of being stored', async () => {
  const choices = [{ id: 'org-a', name: 'A', plan: 'pro' }, { id: 'org-b', name: 'B', plan: 'team' }];
  const { store, settings } = harness({}, {
    fetchLimits: async (options) => {
      if (options.claudeWebOrganizationId) return { provider: 'claude', status: 'ok', ...IDENTITIES['sessionKey=sk-ant-new'] };
      const error = new Error('Choose a Claude Web organization');
      error.status = 'unavailable';
      error.code = 'CLAUDE_WEB_ORGANIZATION_SELECTION_REQUIRED';
      error.organizationChoices = choices;
      throw error;
    }
  });

  assert.deepEqual(await store.add('sk-ant-new'), {
    ok: false,
    status: 'unavailable',
    errorCode: 'CLAUDE_WEB_ORGANIZATION_SELECTION_REQUIRED',
    organizationChoices: choices
  });
  assert.equal(settings().claudeWebAccounts, undefined);

  assert.equal((await store.add('sk-ant-new', 'org-b')).ok, true);
  assert.equal(settings().claudeWebAccounts[0].organizationId, 'org-b');
});

test('a cookie for an account already listed replaces that login instead of adding a row', async () => {
  const { store, settings } = harness({
    claudeWebAccounts: [
      { id: 'kept', cookie: 'sessionKey=sk-ant-expired', ...IDENTITIES['sessionKey=sk-ant-new'] },
      { id: 'other', cookie: 'sessionKey=sk-ant-other', ...IDENTITIES['sessionKey=sk-ant-other'] }
    ]
  });

  assert.equal((await store.add('sk-ant-new')).ok, true);

  assert.deepEqual(settings().claudeWebAccounts.map(({ id, cookie }) => [id, cookie]), [
    ['kept', 'sessionKey=sk-ant-new'],
    ['other', 'sessionKey=sk-ant-other']
  ]);
});

test('a session key rotated during the probe is what gets stored', async () => {
  const { store, settings } = harness({}, {
    fetchLimits: async (_options, deps) => {
      deps.renewed.claudeWebCookie = 'sessionKey=sk-ant-rotated';
      return { provider: 'claude', status: 'ok', ...IDENTITIES['sessionKey=sk-ant-new'] };
    }
  });

  await store.add('sk-ant-new');

  assert.equal(settings().claudeWebAccounts[0].cookie, 'sessionKey=sk-ant-rotated');
});

test('removing a login drops only that one and refreshes Claude as a whole', () => {
  const { store, calls, settings } = harness({
    claudeWebAccounts: [
      { id: 'a', cookie: 'sessionKey=sk-ant-a' },
      { id: 'b', cookie: 'sessionKey=sk-ant-b' }
    ]
  });

  assert.deepEqual(store.remove('missing'), { ok: false, error: 'Account not found' });
  assert.deepEqual(store.remove('a'), { ok: true });

  assert.deepEqual(settings().claudeWebAccounts.map(({ id }) => id), ['b']);
  assert.deepEqual([calls.saves, calls.pushes], [1, 1]);
  assert.deepEqual(calls.invalidations, ['credential-change']);
});

test('a rotated session key follows the login it was issued to, and only ours', () => {
  const { store, calls, settings } = harness({
    claudeWebAccounts: [
      { id: 'a', cookie: 'sessionKey=sk-ant-a' },
      { id: 'b', cookie: 'sessionKey=sk-ant-b' }
    ]
  });

  assert.equal(store.renewCookie({ previousCookie: 'sessionKey=sk-ant-b', cookie: 'sessionKey=sk-ant-b2' }), true);
  assert.deepEqual(settings().claudeWebAccounts.map(({ cookie }) => cookie), ['sessionKey=sk-ant-a', 'sessionKey=sk-ant-b2']);
  assert.equal(calls.saves, 1);

  // The form's cookie is not in the list, so its rotation is left to the caller.
  assert.equal(store.renewCookie({ previousCookie: 'sessionKey=sk-ant-form', cookie: 'sessionKey=sk-ant-form2' }), false);
  assert.equal(store.renewCookie({ previousCookie: 'sessionKey=sk-ant-a', cookie: 'not a key' }), false);
  assert.equal(calls.saves, 1);
});

test('a resolved identity is recorded once, and only for a saved login', () => {
  const { store, calls, settings } = harness({
    claudeWebAccounts: [{ id: 'a', cookie: 'sessionKey=sk-ant-a' }]
  });
  const identity = { id: 'a', ...IDENTITIES['sessionKey=sk-ant-new'] };

  store.rememberIdentity(identity);
  assert.deepEqual(settings().claudeWebAccounts[0], {
    id: 'a',
    cookie: 'sessionKey=sk-ant-a',
    organizationId: '',
    ...IDENTITIES['sessionKey=sk-ant-new']
  });
  assert.deepEqual([calls.saves, calls.pushes], [1, 1]);

  store.rememberIdentity(identity);
  store.rememberIdentity({ ...identity, id: 'gone' });
  assert.deepEqual([calls.saves, calls.pushes], [1, 1]);
});
