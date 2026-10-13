'use strict';

// Claude limits account wiring. Leaf module: no requires — see
// src/shared/limits/accounts.js for the field schema.
module.exports = {
  id: 'claude',
  fetch: 'fetchClaudeLimits',
  fields: [
    {
      key: 'claudeWebCookie',
      kind: 'credential',
      storePath: ['providers', 'claude', 'webCookie'],
      resolve: 'claudeWebCookie',
      normalize: { fn: 'normalizeClaudeWebCookieInput', style: 'value' },
      envFallback: ['CLAUDE_WEB_COOKIE'],
      project: 'set'
    },
    {
      key: 'claudeWebOrganizationId',
      kind: 'setting',
      normalize: { fn: 'normalizeClaudeWebOrganizationId', style: 'value' },
      project: 'value',
      clearWithCredential: true
    },
    {
      // Logins for further claude.ai accounts, beside the one the form holds.
      // Saved and removed through their own IPC after a successful probe, so the
      // generic settings write never carries them; the renderer sees who each
      // account is and never its cookie.
      key: 'claudeWebAccounts',
      kind: 'managed',
      storePath: ['providers', 'claude', 'webAccounts'],
      configDefault: [],
      persist: 'never',
      project: (value, limits) => limits.claudeWebAccountsForRenderer(value),
      initial: []
    }
  ],
  status: {
    credential: 'claudeWebCookie',
    configuredKey: 'claudeWebCookieConfigured',
    sourceKey: 'claudeWebCookieSource',
    pendingKey: 'claudePendingCheckSince'
  },
  // The form's own cookie and the additional logins both count as configured
  // and as stored in settings: the first added account moves the form's cookie
  // into the list, which leaves the form empty while Claude is still linked.
  accountStatus: ({ settings, env, limits }) => {
    const stored = Boolean(settings?.claudeWebCookie)
      || limits.normalizeClaudeWebAccounts(settings?.claudeWebAccounts).length > 0;
    const fromEnv = Boolean(limits.claudeWebCookie(env));
    return {
      claudeWebCookieConfigured: stored || fromEnv,
      claudeWebCookieSource: stored ? 'settings' : fromEnv ? 'env' : ''
    };
  },
  form: {
    discover: { fn: 'listClaudeWebOrganizations', credential: 'claudeWebCookie', selection: 'claudeWebOrganizationId' },
    titleKey: 'settings.claude.title',
    openKey: 'settings.claude.openBrowser',
    clearKey: 'settings.claude.clearCookie',
    saveKey: 'settings.claude.saveCookie',
    emptyKey: 'settings.claude.statusNotSet',
    failedKey: 'settings.claude.saveFailed',
    fields: [
      { key: 'claudeWebCookie', input: 'textarea', placeholderKey: 'settings.claude.cookiePlaceholder', required: true },
      { key: 'claudeWebOrganizationId', input: 'select', labelKey: 'settings.claude.organization', options: [
        { value: '', labelKey: 'settings.claude.organizationChoose' }
      ] }
    ],
    top: [{ field: 'claudeWebOrganizationId' }],
    manual: [
      { note: 'settings.claude.note' },
      { steps: ['settings.claude.step1', 'settings.claude.step2', 'settings.claude.step3', 'settings.claude.step4'] },
      { field: 'claudeWebCookie' }
    ],
    openUrl: { url: 'https://claude.ai/settings/usage' },
    messages: {
      required: 'settings.claude.cookieRequired',
      invalidFormat: 'settings.claude.cookieInvalidFormat',
      rejected: 'settings.claude.cookieRejected'
    }
  },
  urlPolicy: [
    { hosts: ['claude.ai'], pathPrefixes: ['/settings'] }
  ]
};
