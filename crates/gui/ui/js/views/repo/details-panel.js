// Details of the selected commit: message, authorship, parents, and the files it changed.

import { t, tn } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { fullDate } from '../../lib/time.js';
import { repoStore } from '../../state/repo-store.js';
import { diffKey, fileRow } from './files.js';

export function renderDetailsPanel(container) {
  const { details, diff } = repoStore.state;
  if (!details) {
    mount(container, h('div', { class: 'loading' }, t('repo.loading')));
    return;
  }
  const [summary, ...rest] = details.message.split('\n');
  const body = rest.join('\n').trim();
  const sameCommitter = details.committer === details.author;
  mount(container, h('div', { class: 'side-scroll' },
    h('div', { class: 'details' },
      h('p', { class: 'msg-summary' }, summary),
      body && h('pre', { class: 'msg-body' }, body),
      h('dl', {},
        h('dt', {}, t('details.commit')), h('dd', { class: 'oid' }, details.oid),
        h('dt', {}, t('details.author')), h('dd', { title: details.email }, `${details.author} <${details.email}>`),
        h('dt', {}, t('details.date')), h('dd', {}, fullDate(details.time)),
        !sameCommitter && [h('dt', {}, t('details.committer')), h('dd', {}, `${details.committer} · ${fullDate(details.commitTime)}`)],
        details.parents.length > 0 && [
          h('dt', {}, tn('details.parents', details.parents.length)),
          h('dd', {}, details.parents.map((p, i) => [i > 0 && ' ', h('button', { type: 'button', class: 'link', onclick: () => repoStore.selectCommit(p) }, p.slice(0, 7))])),
        ]),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => repoStore.createBranch(details.oid) }, icon('newBranch', 14), t('details.branchHere')),
        h('button', { type: 'button', class: 'btn', onclick: () => repoStore.switchTo(details.oid) }, icon('swap', 14), t('details.checkout')))),
    h('div', { class: 'fgroup-head' }, h('span', { class: 'section-title' }, tn('details.files', details.files.length))),
    details.files.map((f) => fileRow({
      path: f.path,
      kind: f.status,
      key: diffKey({ kind: 'commit', oid: details.oid, file: f.path }),
      open: diffKey(diff) === diffKey({ kind: 'commit', oid: details.oid, file: f.path }),
      onclick: () => repoStore.openCommitDiff(f.path),
      extra: h('span', { class: 'stats' },
        f.binary ? t('diff.binaryShort') : [h('span', { class: 'add' }, `+${f.additions}`), ' ', h('span', { class: 'del' }, `−${f.deletions}`)]),
    })),
  ));
}
