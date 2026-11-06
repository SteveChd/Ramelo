// Conflict editor, in place of the diff: the two sides of each conflict next to each other, each
// settled in one click (one side, or both in either order), and below the file that results, which
// can also be edited by hand before marking the file resolved.

import { t, tn } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { repoStore } from '../../state/repo-store.js';

/** Common parts longer than this are shown folded, with their first and last lines. */
const FOLD_LINES = 8;
const EDGE_LINES = 3;

const kindOf = (operation) => (['am', 'merge', 'rebase', 'cherryPick', 'revert'].includes(operation) ? operation : 'other');

function sideHead(which, sides) {
  const side = sides[which];
  const details = [side.name, side.oid?.slice(0, 7), side.summary].filter(Boolean);
  return h('div', { class: `conflict-side ${which}` },
    h('span', { class: 'role' }, t(`conflict.side.${which}.${kindOf(sides.operation)}`)),
    details.length > 0 && h('span', { class: 'what', title: details.join(' · ') }, details.join(' · ')));
}

/** Lines of a common part, folded in the middle when it is long. */
function commonPart(text, index, expanded, redraw) {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length <= FOLD_LINES || expanded.has(index)) return h('pre', { class: 'common' }, lines.join('\n'));
  const hidden = lines.length - 2 * EDGE_LINES;
  return h('div', { class: 'common folded' },
    h('pre', {}, lines.slice(0, EDGE_LINES).join('\n')),
    h('button', { type: 'button', class: 'unfold', onclick: () => { expanded.add(index); redraw(); } }, tn('conflict.hiddenLines', hidden)),
    h('pre', {}, lines.slice(-EDGE_LINES).join('\n')));
}

function choiceButton(index, choice, current, label) {
  return h('button', {
    type: 'button',
    class: `btn${current === choice ? ' chosen' : ''}`,
    'aria-pressed': String(current === choice),
    onclick: () => repoStore.chooseConflict(index, current === choice ? null : choice),
  }, current === choice && icon('check', 13), label);
}

function conflictPart(segment, index, number, current) {
  const text = (value) => (value ? value.replace(/\n$/, '') : '');
  const empty = (value) => !value && h('span', { class: 'nothing' }, t('conflict.nothing'));
  return h('div', { class: `conflict-block${current ? ' settled' : ''}`, 'data-choice': current ?? '' },
    h('div', { class: 'block-head' },
      h('span', { class: 'number' }, t('conflict.number', { n: number })),
      h('div', { class: 'picks' },
        choiceButton(index, 'ours', current, t('conflict.takeOurs')),
        choiceButton(index, 'theirs', current, t('conflict.takeTheirs')),
        choiceButton(index, 'both', current, t('conflict.takeBoth')),
        choiceButton(index, 'bothReversed', current, t('conflict.takeBothReversed')))),
    h('div', { class: 'block-sides' },
      h('pre', { class: 'ours' }, text(segment.ours), empty(segment.ours)),
      h('pre', { class: 'theirs' }, text(segment.theirs), empty(segment.theirs))));
}

/** Binary file, or deleted on one side: only a whole side can be kept. */
function wholeFile(conflict) {
  const kind = kindOf(conflict.sides.operation);
  const option = (which) => {
    const missing = conflict[which] === null && !conflict.binary;
    return h('button', { type: 'button', class: `btn${missing ? ' danger' : ''}`, onclick: () => repoStore.takeConflictSide(which === 'theirs') },
      icon(missing ? 'remove' : 'check', 14),
      t(missing ? 'conflict.takeDeletion' : 'conflict.takeVersion', { side: t(`conflict.side.${which}.${kind}`) }));
  };
  const reason = conflict.binary ? t('conflict.binary')
    : conflict.ours === null ? t('conflict.deletedOurs', { side: t(`conflict.side.ours.${kind}`) })
      : t('conflict.deletedTheirs', { side: t(`conflict.side.theirs.${kind}`) });
  return h('div', { class: 'conflict-whole' }, h('p', {}, reason), h('div', { class: 'picks' }, option('ours'), option('theirs')));
}

export function renderConflict(container) {
  const diff = repoStore.state.diff;
  const conflict = diff.conflict;
  const redraw = () => renderConflict(container);
  diff.expanded ??= new Set();
  const close = h('button', { type: 'button', class: 'icon-btn', title: t('diff.close'), onclick: () => repoStore.closeDiff() }, icon('close', 16));
  const head = (extra) => h('div', { class: 'diff-head' },
    h('span', { class: 'change-badge conflicted' }, t('change.conflicted')),
    h('span', { class: 'path', title: diff.file }, h('bdi', {}, diff.file)),
    extra,
    h('div', { class: 'vsep' }),
    close);

  if (diff.loading || !conflict) {
    mount(container, h('div', { class: 'diff conflict' }, head(null), h('div', { class: 'diff-note' }, t('repo.loading'))));
    return;
  }
  const whole = conflict.binary || conflict.ours === null || conflict.theirs === null;
  const blocks = conflict.segments.map((s, i) => (s.kind === 'conflict' ? i : -1)).filter((i) => i >= 0);
  const left = blocks.filter((i) => !diff.choices[i]).length;

  if (whole) {
    mount(container, h('div', { class: 'diff conflict' },
      head(null),
      h('div', { class: 'conflict-sides' }, sideHead('ours', conflict.sides), sideHead('theirs', conflict.sides)),
      wholeFile(conflict)));
    return;
  }

  const area = h('textarea', { class: 'edit-area code', spellcheck: 'false', wrap: 'off', 'aria-label': t('conflict.result') });
  area.value = diff.result;
  area.addEventListener('input', () => repoStore.editResolution(area.value));
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      repoStore.markResolved();
    }
  });
  const busy = repoStore.state.running === 'resolve';
  // Settling a conflict draws the editor again: the lists stay where they were scrolled.
  const same = container.dataset.file === diff.file;
  const bodyScroll = same ? container.querySelector('.conflict-body')?.scrollTop ?? 0 : 0;
  const resultScroll = same ? container.querySelector('.conflict-result textarea')?.scrollTop ?? 0 : 0;
  container.dataset.file = diff.file;
  let number = 0;
  mount(container, h('div', { class: 'diff conflict' },
    head([
      h('span', { class: 'side-label' }, left ? tn('conflict.left', left) : t('conflict.allChosen')),
      h('button', { type: 'button', class: 'btn', onclick: () => repoStore.chooseConflict(null, 'ours') }, t('conflict.allOurs')),
      h('button', { type: 'button', class: 'btn', onclick: () => repoStore.chooseConflict(null, 'theirs') }, t('conflict.allTheirs')),
    ]),
    h('div', { class: 'conflict-sides' }, sideHead('ours', conflict.sides), sideHead('theirs', conflict.sides)),
    h('div', { class: 'conflict-body' },
      conflict.segments.map((segment, i) => (segment.kind === 'common'
        ? commonPart(segment.text, i, diff.expanded, redraw)
        : conflictPart(segment, i, (number += 1), diff.choices[i])))),
    h('div', { class: 'conflict-result' },
      h('div', { class: 'result-head' },
        h('span', { class: 'section-title' }, t('conflict.result')),
        h('span', { class: 'hint' }, t(diff.edited ? 'conflict.editedHint' : 'conflict.resultHint'))),
      area,
      h('div', { class: 'result-foot' },
        h('span', { class: 'hint' }, 'Ctrl+Enter'),
        h('button', { type: 'button', class: 'btn primary', disabled: busy, onclick: () => repoStore.markResolved() }, icon('check', 14), t('conflict.markResolved'))))));
  container.querySelector('.conflict-body').scrollTop = bodyScroll;
  area.scrollTop = resultScroll;
}
