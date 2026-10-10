'use strict';

// Main-process side of the additional Claude Web logins.
//
// The account form holds one cookie; this is what lets a device hold more. The
// two are kept apart on purpose. A device with a single login never reaches
// this module and behaves exactly as the form alone does. A device with several
// keeps all of them in `claudeWebAccounts`, where every login carries the
// identity it is still reported under once it stops working, which the form's
// bare cookie has nowhere to store. The step between the two is the first added
// account: it moves the form's cookie in beside the new one.
//
// Nothing here is reachable through settings:update. A cookie is stored only
// after claude.ai has accepted it, and the renderer only ever holds the
// redacted list, so a settings patch carrying one could do nothing but erase.

const crypto = require('node:crypto');
const {
  fetchClaudeLimits,
  normalizeClaudeWebAccounts,
  normalizeClaudeWebCookieInput,
  normalizeClaudeWebOrganizationId
} = require('../../../shared/providers/claude/limits');
const { providerSelectionIncluding } = require('../../limits/credentialCommands');

const IDENTITY_FIELDS = Object.freeze(['accountKey', 'accountEmail', 'accountName', 'accountLabel']);

function createClaudeWebAccounts({
  getSettings,
  saveSettings,
  applySettingsPatch,
  pushSettings,
  invalidateLimits,
  probeDeps,
  fetchLimits = fetchClaudeLimits,
  randomId = () => crypto.randomUUID()
}) {
  const list = () => normalizeClaudeWebAccounts(getSettings()?.claudeWebAccounts);

  async function add(rawCookie, rawOrganizationId) {
    let cookie;
    try {
      cookie = normalizeClaudeWebCookieInput(rawCookie);
    } catch (error) {
      return { ok: false, status: 'invalid', errorCode: error?.code || 'INVALID_CLAUDE_WEB_SESSION_KEY' };
    }
    if (!cookie) return { ok: false, status: 'notConfigured', errorCode: 'INVALID_CLAUDE_WEB_SESSION_KEY' };
    const organizationId = normalizeClaudeWebOrganizationId(rawOrganizationId);

    const renewed = {};
    let provider;
    try {
      // The probe's own deps mark it as one, so the collector reads this cookie
      // alone and none of the logins already saved.
      provider = await fetchLimits(
        { claudeWebCookie: cookie, claudeWebOrganizationId: organizationId },
        { ...probeDeps(renewed), env: {} }
      );
    } catch (error) {
      return {
        ok: false,
        status: error?.status || 'error',
        errorCode: error?.code || '',
        // An account in more than one organization has to say which one to read.
        ...(Array.isArray(error?.organizationChoices) ? { organizationChoices: error.organizationChoices } : {})
      };
    }
    if (provider?.status !== 'ok') return { ok: false, status: provider?.status || 'error' };

    const account = {
      cookie: renewed.claudeWebCookie || cookie,
      organizationId,
      ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, provider[field]]))
    };
    // Read only now, after the probe: another save or a removal may have landed
    // while this cookie was being checked. A cookie for an account that is
    // already listed replaces that account's login in place.
    const settings = getSettings();
    const accounts = list();
    const existing = accounts.find((entry) => (
      (entry.accountKey && entry.accountKey === account.accountKey) || entry.cookie === cookie
    ));
    const next = existing
      ? accounts.map((entry) => (entry === existing ? { ...account, id: existing.id } : entry))
      : [...accounts, { ...account, id: randomId() }];
    // The form's cookie joins the list ahead of the others. Its identity is not
    // known here and is recorded by the refresh that follows, through
    // rememberIdentity. An environment cookie is not ours to move.
    const formCookie = settings.claudeWebCookie;
    if (formCookie) {
      next.unshift({
        id: randomId(),
        cookie: formCookie,
        organizationId: settings.claudeWebOrganizationId
      });
    }
    try {
      // Saved on its own first: the settings write path strips this key from
      // every patch. Until the second write lands the form's cookie is in both
      // places, which reads as one login because the list is deduplicated
      // against it.
      settings.claudeWebAccounts = normalizeClaudeWebAccounts(next);
      saveSettings();
      // Through the settings write path, so the form's own bookkeeping retires
      // any probe it still has in flight for the cookie that just moved, and
      // saving a login selects Claude exactly as saving the form does.
      applySettingsPatch({
        ...(formCookie ? { claudeWebCookie: '', claudeWebOrganizationId: '' } : {}),
        limitProviders: providerSelectionIncluding(settings.limitProviders, 'claude'),
        limitsEnabled: true
      });
    } catch (error) {
      return { ok: false, status: 'error', errorCode: error?.code || '' };
    }
    pushSettings();
    invalidateLimits('login');
    return { ok: true, status: 'ok' };
  }

  function remove(id) {
    const accounts = list();
    const remaining = accounts.filter((account) => account.id !== String(id || '').trim());
    if (remaining.length === accounts.length) return { ok: false, error: 'Account not found' };
    try {
      getSettings().claudeWebAccounts = remaining;
      saveSettings();
    } catch (error) {
      return { ok: false, error: error.message };
    }
    pushSettings();
    // Provider-wide on purpose: the remaining logins report in a different shape
    // once only one is left, and removing the last one hands Claude back to
    // OAuth/CLI detection.
    invalidateLimits('credential-change');
    return { ok: true };
  }

  // A rotated sessionKey replaces the cookie of the login it was issued to.
  // False when that login is not one of ours, so the caller can try the form's.
  function renewCookie({ previousCookie, cookie } = {}) {
    let expected;
    let renewed;
    try {
      expected = normalizeClaudeWebCookieInput(previousCookie);
      renewed = normalizeClaudeWebCookieInput(cookie);
    } catch (_) {
      return false;
    }
    const accounts = list();
    const account = renewed ? accounts.find((entry) => entry.cookie === expected) : null;
    if (!account) return false;
    if (account.cookie === renewed) return true;
    account.cookie = renewed;
    getSettings().claudeWebAccounts = accounts;
    saveSettings();
    return true;
  }

  // Runs after a successful read, so the settings list can name the account and
  // a login that later stops working still reports under it.
  function rememberIdentity({ id, ...identity } = {}) {
    const accounts = list();
    if (!accounts.some((account) => account.id === id)) return;
    const next = normalizeClaudeWebAccounts(accounts.map((account) => (
      account.id === id
        ? { ...account, ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]])) }
        : account
    )));
    if (JSON.stringify(next) === JSON.stringify(accounts)) return;
    getSettings().claudeWebAccounts = next;
    saveSettings();
    pushSettings();
  }

  return { add, remove, renewCookie, rememberIdentity };
}

module.exports = { createClaudeWebAccounts };
