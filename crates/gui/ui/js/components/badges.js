// What a repository needs at a glance, shared by the overview cards, the tabs and the repository view.

import { describeError } from '../app/errors.js';
import { t, tn } from '../i18n/i18n.js';
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

/** Number of files with a change of any kind. */
export function changeCount(summary) {
  return summary ? summary.fileCount : 0;
}

/** Overall state of a repository, for the coloured dot of its tab and the overview filters. */
export function repoState(repo) {
  const s = repo.summary;
  if (repo.error || !s) return repo.error ? 'error' : 'unknown';
  if (s.conflicted > 0 || s.operation) return 'conflict';
  if (s.fileCount > 0) return 'dirty';
  return 'clean';
}

/** Needs to be pushed or pulled. */
export function needsSync(repo) {
  const s = repo.summary;
  return Boolean(s && (s.ahead > 0 || s.behind > 0));
}

function badge(kind, iconName, text, title) {
  return h('span', { class: `badge ${kind}`, title: title ?? text }, iconName && icon(iconName, 13, 2), h('span', { class: 'lbl' }, text));
}

/** Badges of a repository: branch, ahead / behind, operation in progress, changes, stashes. */
export function repoBadges(repo) {
  if (repo.error) return [badge('error', 'warning', t('badge.unreadable'), describeError(repo.error))];
  const s = repo.summary;
  if (!s) return [];
  const head = s.head;
  const branch = head.branch ?? t('badge.detached', { oid: (head.oid ?? '').slice(0, 7) });
  const list = [badge('branch', 'branch', branch, s.upstream ? t('badge.tracking', { upstream: s.upstream }) : t('badge.noUpstream'))];
  if (s.ahead) list.push(badge('ahead', 'arrowUp', String(s.ahead), tn('badge.ahead', s.ahead)));
  if (s.behind) list.push(badge('behind', 'arrowDown', String(s.behind), tn('badge.behind', s.behind)));
  if (s.operation) list.push(badge('op', 'warning', t(`operation.${s.operation}`)));
  if (s.conflicted) list.push(badge('conflict', null, tn('badge.conflicts', s.conflicted)));
  if (s.fileCount) list.push(badge('dirty', null, tn('badge.changes', s.fileCount)));
  else if (!s.operation) list.push(badge('clean', 'check', t('badge.clean')));
  if (s.stashes) list.push(badge('', 'stash', String(s.stashes), tn('badge.stashes', s.stashes)));
  if (head.oid === null) list.push(badge('', null, t('badge.noCommit')));
  return list;
}
