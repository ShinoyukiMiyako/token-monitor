'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { claudeSessionRoots } = require('./providers/claude/paths');
const { codebuddyProjectsRoot } = require('./providers/codebuddy/paths');

// 5.5 moved the WorkBuddy home to ~/.workbuddy-ai and tokscale still scans
// both, so a session reported from either root resolves from either.
function workbuddyProjectsRoots(home) {
  return [path.join(home, '.workbuddy', 'projects'), path.join(home, '.workbuddy-ai', 'projects')];
}

function isSafeSessionId(sessionId) {
  const id = String(sessionId || '');
  if (!id || id === '.' || id === '..') return false;
  if (id.includes('\0')) return false;
  // A single path segment only — separators would let path.join walk out.
  if (/[\\/]/.test(id)) return false;
  return path.basename(id) === id;
}

function isPathInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// `root` + separator + `<sessionId>.jsonl` -> the transcript's path.
//
// Session metadata is resolved again on every tick, and without this each of
// those ticks re-walked the whole tree to find files it had already found:
// 56ms of synchronous readdirSync over a real ~/.claude/projects (943 dirs /
// 10.5k files), growing with every session ever recorded. A transcript does not
// move once written, so remembering where it was turns the walk into a stat.
// Keyed by root rather than by client so the callers' own precedence between
// roots (projects before transcripts) is still decided by which root they ask.
//
// Module-level because it has to outlive a single collection to do anything.
const sessionFilePathCache = new Map();
// A character that cannot occur in a path or a file name, built rather than
// written as a literal so the source keeps no raw NUL byte.
const SESSION_FILE_KEY_SEPARATOR = String.fromCharCode(0);

function findSessionFiles(root, sessionIds) {
  const wanted = new Set();
  const found = new Map();
  for (const sessionId of sessionIds) {
    if (!isSafeSessionId(sessionId)) continue;
    const key = [root, sessionId].join(SESSION_FILE_KEY_SEPARATOR);
    const cached = sessionFilePathCache.get(key);
    if (cached) {
      // A remembered path that no longer reads is looked up again instead of
      // being trusted: the session may have been deleted, or moved with its
      // project directory.
      let isFile = false;
      try { isFile = fs.statSync(cached).isFile(); } catch (_) { /* gone */ }
      if (isFile) { found.set(sessionId, cached); continue; }
      sessionFilePathCache.delete(key);
    }
    wanted.add(`${sessionId}.jsonl`);
  }
  if (wanted.size === 0) return found;
  const remembered = found.size;
  const remember = (sessionId, filePath) => {
    found.set(sessionId, filePath);
    sessionFilePathCache.set([root, sessionId].join(SESSION_FILE_KEY_SEPARATOR), filePath);
  };

  function walk(dir) {
    if (found.size - remembered >= wanted.size) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found.size - remembered >= wanted.size) return;
      const nextPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath);
      } else if (entry.isFile() && wanted.has(entry.name)) {
        remember(entry.name.slice(0, -'.jsonl'.length), nextPath);
      }
    }
  }

  walk(root);
  return found;
}

function codexHomeDir(home, options = {}) {
  const env = options.env || process.env;
  const configured = options.useEnvRoots !== false ? String(env.CODEX_HOME || '').trim() : '';
  return configured ? path.resolve(configured) : path.join(home, '.codex');
}

function codexSessionFile(home, sessionId, options = {}) {
  if (!isSafeSessionId(sessionId)) return '';
  const match = String(sessionId).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) return '';
  const codexHome = options.codexHome || codexHomeDir(home, options);
  const sessionsRoot = path.join(codexHome, 'sessions');
  const filePath = path.join(sessionsRoot, match[1], match[2], match[3], `${sessionId}.jsonl`);
  if (!isPathInside(sessionsRoot, filePath)) return '';
  try { return fs.statSync(filePath).isFile() ? filePath : ''; } catch (_) { return ''; }
}

function resolveSessionFile(client, sessionId, home, options = {}) {
  const id = String(sessionId || '');
  if (!isSafeSessionId(id)) return '';
  if (client === 'claude') {
    const { projects, transcripts } = claudeSessionRoots({
      homeDir: home,
      env: options.env,
      useEnvRoots: options.useEnvRoots
    });
    const projectFile = findSessionFiles(projects, [id]).get(id);
    if (projectFile) return projectFile;
    return findSessionFiles(transcripts, [id]).get(id) || '';
  }
  if (client === 'codebuddy') {
    return findSessionFiles(codebuddyProjectsRoot({ homeDir: home }), [id]).get(id) || '';
  }
  if (client === 'workbuddy') {
    for (const root of workbuddyProjectsRoots(home)) {
      const found = findSessionFiles(root, [id]).get(id);
      if (found) return found;
    }
    return '';
  }
  if (client === 'codex') {
    const codexHome = options.codexHome || codexHomeDir(home, options);
    const direct = codexSessionFile(home, id, { codexHome });
    if (direct) return direct;
    return findSessionFiles(path.join(codexHome, 'sessions'), [id]).get(id) || '';
  }
  return '';
}

module.exports = { findSessionFiles, codexSessionFile, resolveSessionFile, isSafeSessionId };
