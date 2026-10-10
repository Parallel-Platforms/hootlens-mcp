/*
 * The findings viewer: the pages and device classes with the most snags as a short list of cards. It shows exactly the
 * counts the tool returned, one card per cohort, and links to the dashboard for the rest.
 */
import { start, type Started, type ToolResult } from './bridge';
import { h, icon, markerShape } from './dom';
import { dashboardUrl, isRecord, projectOf, snagCount, type FindingsResult } from './model';

const MAX_CARDS = 6;
// Assigned once the host answers (below the handlers that use it), so it cannot be declared with its value.
// eslint-disable-next-line prefer-const
let started: Started;
let args: Record<string, unknown> = {};

const root = document.getElementById('app')!;
const title = h('h1', { class: 'hl-title' }, 'Findings');
const subtitle = h('p', { class: 'hl-sub' });
const list = h('ol', { class: 'fd-cards', 'data-testid': 'cards' });
const footnote = h('p', { class: 'hl-muted hl-small' });
const openButton = h('button', { type: 'button', class: 'hl-button', 'data-testid': 'open-in-hoot-lens' }, icon.external(), h('span', {}, 'Open in Hoot Lens'));
let projectId: string | undefined;
openButton.addEventListener('click', () => {
  const url = dashboardUrl('overview', projectId);
  if (url) void started.open(url);
});
root.append(h('div', { class: 'hl hl-findings' }, h('header', { class: 'hl-head' }, h('div', { class: 'hl-headtext' }, title, subtitle), h('div', { class: 'hl-actions' }, openButton)), list, footnote));

const deviceName = (value: string | undefined) => (value ? value[0]!.toUpperCase() + value.slice(1) : '');

function onResult(result: ToolResult): void {
  list.replaceChildren();
  if (result.isError || !isRecord(result.structuredContent)) {
    subtitle.textContent = result.content?.find(item => item.type === 'text')?.text?.slice(0, 240) ?? 'There are no findings to show.';
    return;
  }
  const data = result.structuredContent as FindingsResult;
  projectId = projectOf(args, result._meta);
  const cohorts = [...(data.cohorts ?? [])].sort((a, b) => (b.frictionClicks ?? 0) - (a.frictionClicks ?? 0) || (b.clicks ?? 0) - (a.clicks ?? 0));
  subtitle.textContent = data.signal?.evidence ?? (cohorts.length ? 'Pages and devices with the most snags first.' : 'No cohorts have recorded clicks yet.');
  const worst = Math.max(1, ...cohorts.map(cohort => cohort.frictionClicks ?? 0));
  for (const cohort of cohorts.slice(0, MAX_CARDS)) {
    const parts: string[] = [];
    if (cohort.rageClicks) parts.push(snagCount('rage-click', cohort.rageClicks));
    if (cohort.deadClicks) parts.push(snagCount('dead-click', cohort.deadClicks));
    if (cohort.errorClicks) parts.push(snagCount('error-click', cohort.errorClicks));
    const friction = cohort.frictionClicks ?? 0;
    const top = (cohort.selectors ?? []).slice(0, 2).map(entry => entry.name?.trim() || entry.label?.trim() || entry.selector);
    list.append(h('li', { class: 'fd-card', 'data-testid': 'card' },
      h('div', { class: 'fd-top' },
        h('h2', { class: 'fd-path' }, cohort.path ?? cohort.key),
        h('span', { class: 'hl-sub' }, [deviceName(cohort.deviceClass), cohort.clicks !== undefined ? `${cohort.clicks.toLocaleString('en-US')} clicks` : undefined].filter(Boolean).join(' · '))),
      h('div', { class: 'fd-meter', role: 'img', 'aria-label': `${friction} of ${cohort.clicks ?? 0} clicks were snags` }, h('span', { style: `width:${friction ? Math.max(3, Math.round((friction / worst) * 100)) : 0}%` })),
      parts.length ? h('p', { class: 'fd-snags' }, markerShape('rage-click'), parts.join(', ')) : h('p', { class: 'hl-muted hl-small' }, 'No snags spotted.'),
      top.length ? h('p', { class: 'hl-muted hl-small' }, `Most affected: ${top.join(', ')}`) : null));
  }
  footnote.textContent = cohorts.length > MAX_CARDS ? `Showing ${MAX_CARDS} of ${cohorts.length}. Snags describe the page, not the visitor.` : 'Snags describe the page, not the visitor.';
}

started = await start('Hoot Lens findings', { input: input => { args = input; }, result: onResult });
