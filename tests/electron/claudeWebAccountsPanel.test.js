'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');

// Top-level functions of app.js, run in a context built for the test.
function rendererFunctions(names, context) {
  const source = names.map((name) => {
    const start = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `${name} should exist`);
    const end = app.indexOf('\n}\n', start);
    return app.slice(start, end + 2);
  }).join('\n');
  vm.runInNewContext(source, context);
  return context;
}

class FakeElement {
  constructor(tagName, document) {
    this.tagName = String(tagName).toUpperCase();
    this.document = document;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    const classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    };
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: (value) => {
        classes.clear();
        for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name);
      }
    });
  }
  set id(value) { this._id = value; this.document.register(this); }
  get id() { return this._id; }
  append(...children) { this.children.push(...children); }
  insertBefore(child, before) {
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
  }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelector(selector) {
    const className = selector.replace(/^\./, '');
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.classList?.contains(className)) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
}

function fakeDocument() {
  const byId = new Map();
  const document = {
    register: (element) => byId.set(element.id, element),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tagName) => new FakeElement(tagName, document)
  };
  return document;
}

// The part of the generated Claude panel the account list attaches to.
function claudePanel(document) {
  const details = document.createElement('div');
  details.id = 'claudeSettingsDetails';
  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  for (const id of ['claudeOpenBrowser', 'claudeLogoutButton', 'claudeRefreshButton']) {
    const button = document.createElement('button');
    button.id = id;
    actions.append(button);
  }
  const manual = document.createElement('div');
  manual.id = 'claudeManualPanel';
  const error = document.createElement('div');
  error.id = 'claudeErrorMessage';
  details.append(actions, manual, error);
  return details;
}

function rows(document) {
  return document.getElementById('claudeAccountList').children.map((row) => {
    const [main, right] = row.children;
    const [info, remove] = right.children;
    return { title: main.children[0].textContent, info: info.textContent, remove };
  });
}

function setup({ settings, providers = [], addAccount, removeAccount }) {
  const document = fakeDocument();
  const details = claudePanel(document);
  const statusEl = document.createElement('span');
  const calls = { added: [], removed: [], refreshes: 0, messages: [] };
  const context = rendererFunctions([
    'claudeWebAccountInfoText',
    'claudeWebAccountRejection',
    'renderClaudeAddAccountOrganizations',
    'submitClaudeWebAccount',
    'attachClaudeWebAccounts',
    'renderClaudeWebAccounts'
  ], {
    document,
    state: { settings },
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    limitAccountTitle: (_provider, account, index) => account.accountEmail || `Account ${index + 1}`,
    limitProviderPresentationApi: { limitProviderDisplayLabel: (label) => label },
    localProviderStatuses: () => providers,
    setCursorStatusText: (el, text) => { el.textContent = text; },
    // Messages are built inside the vm realm; copied out so they compare as plain objects.
    setAccountPanelMessage: (_provider, message) => calls.messages.push(JSON.parse(JSON.stringify(message))),
    markExternalProviderCheckPending: () => {},
    refreshStats: async () => { calls.refreshes += 1; },
    window: {
      tokenMonitor: {
        claude: {
          addAccount: async (cookie, organizationId) => {
            calls.added.push([cookie, organizationId]);
            return addAccount(cookie, organizationId);
          },
          removeAccount: async (id) => {
            calls.removed.push(id);
            return removeAccount ? removeAccount(id) : { ok: true };
          }
        }
      }
    }
  });
  let linked = true;
  context.renderExternalProviderStatus = () => context.renderClaudeWebAccounts(statusEl, linked, true);
  context.attachClaudeWebAccounts();
  return {
    document,
    details,
    statusEl,
    calls,
    context,
    setLinked: (value) => { linked = value; },
    render: () => context.renderExternalProviderStatus()
  };
}

const THREE_ACCOUNTS = [
  { id: 'a', accountKey: 'sha256:a', accountEmail: 'a@example.com', accountLabel: 'Max 20x' },
  { id: 'b', accountKey: 'sha256:b', accountEmail: 'b@example.com', accountLabel: 'Pro' },
  { id: 'c', accountKey: '', accountEmail: '', accountLabel: '' }
];

test('the Claude panel lists every saved login with its plan or its failure', () => {
  const view = setup({
    settings: { claudeWebCookie: '', claudeWebAccounts: THREE_ACCOUNTS },
    providers: [
      { provider: 'claude', accountKey: 'sha256:a', status: 'unauthorized' },
      { provider: 'claude', accountKey: 'sha256:b', status: 'ok' }
    ]
  });
  view.render();

  assert.equal(view.statusEl.textContent, 'settings.claude.nAccounts:{"count":3}');
  assert.deepEqual(rows(view.document).map(({ title, info }) => [title, info]), [
    ['a@example.com', 'settings.claude.statusInvalid'],
    ['b@example.com', 'Pro'],
    // Not read successfully since it was saved.
    ['Account 3', 'settings.common.notChecked']
  ]);
  // The form's cookie moved into the list, so its paste box and clear button
  // have nothing left to hold; adding goes through the add form.
  assert.equal(view.document.getElementById('claudeManualPanel').classList.contains('hidden'), true);
  assert.equal(view.document.getElementById('claudeLogoutButton').classList.contains('hidden'), true);
  assert.equal(view.document.getElementById('claudeAddAccountButton').classList.contains('hidden'), false);
  assert.equal(view.document.getElementById('claudeAddAccountPanel').classList.contains('hidden'), true);
});

test('with only the form cookie the panel stays upstream-shaped, plus an add button once linked', () => {
  const view = setup({ settings: { claudeWebCookie: 'set', claudeWebAccounts: [] } });
  view.statusEl.textContent = 'settings.claude.statusSet';
  view.render();

  assert.equal(view.statusEl.textContent, 'settings.claude.statusSet', 'one login keeps the provider status');
  assert.deepEqual(rows(view.document), []);
  assert.equal(view.document.getElementById('claudeManualPanel').classList.contains('hidden'), false);
  assert.equal(view.document.getElementById('claudeAddAccountButton').classList.contains('hidden'), false);

  // Nothing saved and nothing linked: the form is the way in, with no add button.
  view.context.state.settings.claudeWebCookie = '';
  view.setLinked(false);
  view.render();
  assert.equal(view.document.getElementById('claudeAddAccountButton').classList.contains('hidden'), true);
});

test('adding a login asks for an organization when the account has several, then saves', async () => {
  const choices = [{ id: 'org-a', name: 'Team', plan: 'team' }, { id: 'org-b', name: 'Personal', plan: 'pro' }];
  const view = setup({
    settings: { claudeWebCookie: 'set', claudeWebAccounts: [] },
    addAccount: (_cookie, organizationId) => (organizationId
      ? { ok: true, status: 'ok' }
      : { ok: false, status: 'unavailable', errorCode: 'CLAUDE_WEB_ORGANIZATION_SELECTION_REQUIRED', organizationChoices: choices })
  });
  view.render();
  view.document.getElementById('claudeAddAccountButton').listeners.click();
  assert.equal(view.document.getElementById('claudeAddAccountPanel').classList.contains('hidden'), false);
  assert.equal(view.document.getElementById('claudeOpenBrowser').classList.contains('hidden'), false);

  const input = view.document.getElementById('claudeAddAccountCookieInput');
  const submit = view.document.getElementById('claudeAddAccountSubmit');
  input.value = 'sk-ant-second';
  await submit.listeners.click();

  const organization = view.document.getElementById('claudeAddAccountOrganizationInput');
  assert.equal(view.document.getElementById('claudeAddAccountOrganizationRow').classList.contains('hidden'), false);
  assert.deepEqual(organization.children.map((option) => [option.value, option.textContent]), [
    ['', 'settings.claude.organizationChoose'],
    ['org-a', 'Team · Team'],
    ['org-b', 'Personal · Pro']
  ]);
  assert.deepEqual(view.calls.messages.at(-1), { key: 'settings.claude.organizationRequired', tone: 'notice' });
  assert.equal(input.value, 'sk-ant-second', 'the cookie waits for the choice');

  organization.value = 'org-b';
  await submit.listeners.click();
  assert.deepEqual(view.calls.added, [['sk-ant-second', ''], ['sk-ant-second', 'org-b']]);
  assert.equal(input.value, '');
  assert.equal(view.document.getElementById('claudeAddAccountPanel').classList.contains('hidden'), true);
  assert.equal(view.calls.refreshes, 1);
});

test('a rejected login says why and keeps what was pasted', async () => {
  const view = setup({
    settings: { claudeWebCookie: 'set', claudeWebAccounts: [] },
    addAccount: () => ({ ok: false, status: 'unauthorized', errorCode: '' })
  });
  view.render();
  view.document.getElementById('claudeAddAccountButton').listeners.click();
  const input = view.document.getElementById('claudeAddAccountCookieInput');

  await view.document.getElementById('claudeAddAccountSubmit').listeners.click();
  assert.deepEqual(view.calls.messages.at(-1), { key: 'settings.claude.cookieRequired' });
  assert.deepEqual(view.calls.added, [], 'an empty box is not sent');

  input.value = 'sk-ant-revoked';
  await view.document.getElementById('claudeAddAccountSubmit').listeners.click();
  assert.deepEqual(view.calls.messages.at(-1), { key: 'settings.claude.cookieRejected' });
  assert.equal(input.value, 'sk-ant-revoked');
  assert.equal(view.calls.refreshes, 0);
});

test('a login is removed only on the second click, and a refused removal says why', async () => {
  const view = setup({
    settings: { claudeWebCookie: '', claudeWebAccounts: THREE_ACCOUNTS.map((account) => ({ ...account })) },
    removeAccount: (id) => (id === 'a' ? { ok: false, error: 'disk full' } : { ok: true })
  });
  view.render();

  const removeB = rows(view.document)[1].remove;
  await removeB.listeners.click();
  assert.deepEqual(view.calls.removed, []);
  assert.equal(removeB.classList.contains('confirming'), true);
  assert.equal(removeB.title, 'settings.claude.removeConfirm:{"account":"b@example.com"}');

  await removeB.listeners.click();
  assert.deepEqual(view.calls.removed, ['b']);
  assert.deepEqual(rows(view.document).map(({ title }) => title), ['a@example.com', 'Account 2']);

  const removeA = rows(view.document)[0].remove;
  await removeA.listeners.click();
  await removeA.listeners.click();
  assert.deepEqual(view.context.state.settings.claudeWebAccounts.map(({ id }) => id), ['a', 'c']);
  assert.deepEqual(view.calls.messages.at(-1), { key: 'settings.claude.removeFailed', params: { message: 'disk full' } });
});

test('the form lists organizations only while it holds its own cookie', () => {
  const available = (settings) => rendererFunctions(['claudeFormOrganizationsAvailable'], { state: { settings } })
    .claudeFormOrganizationsAvailable();
  assert.equal(available({ claudeWebCookieConfigured: true, claudeWebCookie: 'set', claudeWebAccounts: [] }), true);
  assert.equal(available({ claudeWebCookieConfigured: true, claudeWebCookie: '', claudeWebAccounts: [] }), true, 'an env cookie still has organizations');
  assert.equal(available({ claudeWebCookieConfigured: true, claudeWebCookie: 'set', claudeWebAccounts: [{ id: 'a' }] }), true);
  // The form's cookie moved into the list; each login there keeps its own organization.
  assert.equal(available({ claudeWebCookieConfigured: true, claudeWebCookie: '', claudeWebAccounts: [{ id: 'a' }] }), false);
  assert.equal(available({ claudeWebCookieConfigured: false, claudeWebCookie: '', claudeWebAccounts: [] }), false);
});
