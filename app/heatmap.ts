/*
 * The heatmap viewer: one cohort (a page, release, revision, variant and device class) as click density over the page,
 * with the most-clicked elements, their snags and how far visitors scrolled.
 *
 * Data: the tool result (get_heatmap) carries the density cells, the elements and the scroll shares. The page behind the
 * density is the cohort's reference recording, fetched through the host with the same replay tool the replay viewer uses;
 * without the replay scope the density is drawn on a blank page of the typical size, as the dashboard does.
 */
import { start, type Started, type ToolResult } from './bridge';
import { h, icon } from './dom';
import { dashboardUrl, documentSize, idArg, isRecord, playable, projectOf, snagCount, type HeatmapResult, type ReplayResult } from './model';
import { Stage } from './stage';
import { frameForDevice } from './frame';
import { DENSITY_STOPS, canvasPixelRatio, drawDensity, drawScrollBands, rampGradient, type Cell } from '../../../apps/web/src/dashboard/heatmap/density';
import rrwebCss from 'rrweb/dist/style.css';

type Mode = 'clicks' | 'scroll';
// Assigned once the host answers (below the handlers that use it), so it cannot be declared with its value.
// eslint-disable-next-line prefer-const
let started: Started | undefined;
let data: HeatmapResult | undefined;
let args: Record<string, unknown> = {};
let projectId: string | undefined;
let mode: Mode = 'clicks';
let snapshot: 'none' | 'loading' | 'ready' | 'unavailable' = 'none';

const root = document.getElementById('app')!;
document.head.append(h('style', {}, rrwebCss));
const stage = new Stage(() => (document.documentElement.dataset.mode === 'fullscreen' ? Math.max(340, window.innerHeight - 220) : 360));
const canvas = h('canvas', { class: 'hm-canvas', 'aria-hidden': 'true', 'data-testid': 'heat-canvas' });
stage.screenLayer.append(canvas);
// The first layout with a measured width decides the scale, so the busiest area is brought into view after it.
let focusPending = true;
stage.onLayout = () => {
  draw();
  cropped();
  if (focusPending && stage.element.clientWidth > 0 && stage.element.dataset.state === 'page') { focusPending = false; focusBusiest(); }
};
stage.onAssetsBlocked = () => { note.textContent = 'Images, fonts or styles from the recorded page could not be loaded in this view, so the page behind the density shows its structure and text.'; note.hidden = false; };

const title = h('h1', { class: 'hl-title' });
const subtitle = h('p', { class: 'hl-sub' });
const summary = h('p', { class: 'hl-summary' });
const note = h('p', { class: 'hl-note', role: 'status', hidden: true });
const fullscreen = h('button', { type: 'button', class: 'hl-button', hidden: true, 'data-testid': 'fullscreen' });
const openButton = h('button', { type: 'button', class: 'hl-button', 'data-testid': 'open-in-hoot-lens', 'aria-label': 'Open in Hoot Lens', title: 'Open in Hoot Lens' }, icon.external(), h('span', { class: 'hl-label' }, 'Open in Hoot Lens'));
const modes = h('div', { class: 'hl-speeds', role: 'group', 'aria-label': 'What the heatmap shows' },
  ...([['clicks', 'Clicks'], ['scroll', 'Scroll reach']] as const).map(([value, label]) => {
    const button = h('button', { type: 'button', class: 'hl-chip-button', 'data-mode': value, 'aria-pressed': value === mode }, label);
    button.addEventListener('click', () => { mode = value; for (const b of modes.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); renderKey(); draw(); focusBusiest(); });
    return button;
  }));
const keyBar = h('div', { class: 'hm-key' });
const cropNote = h('p', { class: 'hl-muted hl-small', hidden: true });
const cropText = h('p', { class: 'hl-muted hl-small', hidden: true });
const elements = h('ol', { class: 'hm-elements', 'aria-label': 'Most clicked elements', 'data-testid': 'elements' });
const reach = h('div', { class: 'hm-reach', hidden: true });
const live = h('p', { class: 'hl-sr', role: 'status', 'aria-live': 'polite' });

root.append(h('div', { class: 'hl hl-heatmap' },
  h('header', { class: 'hl-head' }, h('div', { class: 'hl-headtext' }, title, subtitle), h('div', { class: 'hl-actions' }, fullscreen, openButton)),
  summary,
  h('div', { class: 'hl-body' },
    h('section', { class: 'hl-player', 'aria-label': 'Page with click density' }, modes, stage.element, note, keyBar, cropText, cropNote),
    h('section', { class: 'hl-steps', 'aria-label': 'Elements' }, h('h2', { class: 'hl-h2' }, 'Most clicked elements'), elements, reach)),
  live));

fullscreen.addEventListener('click', async () => {
  await started!.setMode(started!.mode() === 'fullscreen' ? 'inline' : 'fullscreen');
  renderFullscreenButton();
  stage.layout();
});
openButton.addEventListener('click', () => {
  const url = dashboardUrl('heatmaps', projectId);
  if (url) void started?.open(url);
});

function renderFullscreenButton(): void {
  fullscreen.hidden = !started?.canFullscreen();
  const full = started?.mode() === 'fullscreen';
  fullscreen.replaceChildren(full ? icon.collapse() : icon.expand(), h('span', { class: 'hl-label' }, full ? 'Exit full screen' : 'Full screen'));
  fullscreen.setAttribute('aria-label', full ? 'Exit full screen' : 'Full screen');
  fullscreen.title = full ? 'Exit full screen' : 'Full screen';
}

const deviceName = (value: string | undefined) => (value ? value[0]!.toUpperCase() + value.slice(1) : '');

function nameOf(entry: NonNullable<HeatmapResult['selectors']>[number]): string {
  return entry.name?.trim() || entry.label?.trim() || entry.selector;
}

function renderText(): void {
  if (!data) return;
  title.textContent = data.path ?? 'Heatmap';
  const visits = data.sessions ?? data.segments;
  subtitle.textContent = [deviceName(data.deviceClass), data.clicks !== undefined ? `${data.clicks.toLocaleString('en-US')} clicks` : undefined, visits !== undefined ? `${visits.toLocaleString('en-US')} visits` : undefined].filter(Boolean).join(' · ');
  const list = data.selectors ?? [];
  const top = list[0];
  summary.textContent = top
    ? `The most clicked element is ${nameOf(top)}, with ${top.clicks.toLocaleString('en-US')} of ${(data.clicks ?? top.clicks).toLocaleString('en-US')} clicks.`
    : 'No clicks were recorded for this page group yet.';
  elements.replaceChildren();
  const max = Math.max(1, ...list.map(entry => entry.clicks));
  for (const entry of list.slice(0, 8)) {
    const snags: string[] = [];
    if (entry.rageClicks) snags.push(snagCount('rage-click', entry.rageClicks));
    if (entry.deadClicks) snags.push(snagCount('dead-click', entry.deadClicks));
    if (entry.errorClicks) snags.push(snagCount('error-click', entry.errorClicks));
    const bar = h('span', { class: 'hm-bar', 'aria-hidden': 'true' }, h('span', { class: 'hm-fill', style: `width:${Math.max(2, Math.round((entry.clicks / max) * 100))}%` }));
    elements.append(h('li', { class: 'hm-element', 'data-testid': 'element' },
      h('span', { class: 'hm-name' }, nameOf(entry)),
      h('span', { class: 'hm-count' }, `${entry.clicks.toLocaleString('en-US')} clicks`),
      bar,
      snags.length ? h('span', { class: 'hl-fact hl-snag' }, snags.join(', ')) : null,
      entry.source ? h('span', { class: 'hm-source' }, entry.source) : null));
  }
  if (!list.length) elements.append(h('li', { class: 'hl-muted' }, 'No elements to list.'));
  const cells = data.grid;
  if (cells?.truncatedFrom && cells.truncatedFrom > cells.cells.length) {
    cropNote.hidden = false;
    cropNote.textContent = `The density uses the ${cells.cells.length.toLocaleString('en-US')} busiest of ${cells.truncatedFrom.toLocaleString('en-US')} cells.`;
  }
  renderReach();
  renderKey();
}

function renderReach(): void {
  const depths = data?.scrollDepths ?? [];
  reach.hidden = depths.length === 0;
  reach.replaceChildren();
  if (!depths.length) return;
  // Index 0 is the top 10% of the page; each value is the share of visits that reached that band.
  let half = -1;
  depths.forEach((share, band) => { if (share >= 0.5) half = band; });
  reach.append(h('h2', { class: 'hl-h2' }, 'Scroll reach'),
    h('p', { class: 'hl-muted hl-small' }, half >= 0 ? `At least half of visits reached ${(half + 1) * 10}% of the page.` : 'Fewer than half of visits scrolled past the top band.'),
    h('ol', { class: 'hm-bands', 'aria-label': 'Share of visits that reached each tenth of the page' },
      ...depths.slice(0, 10).map((share, band) => h('li', { 'aria-label': `${band * 10} to ${(band + 1) * 10} percent of the page: ${Math.round(share * 100)} percent of visits`, title: `${Math.round(share * 100)}%` },
        h('span', { class: 'hm-band', style: `height:${Math.max(3, Math.round(share * 100))}%` })))));
}

function renderKey(): void {
  keyBar.replaceChildren();
  if (mode === 'clicks') keyBar.append(h('span', {}, 'Fewer clicks'), h('span', { class: 'hm-ramp', 'aria-hidden': 'true', style: `background:${rampGradient('to right', DENSITY_STOPS)}` }), h('span', {}, 'More clicks'));
  else keyBar.append(h('span', {}, 'Fewer visits reached'), h('span', { class: 'hm-ramp', 'aria-hidden': 'true', style: `background:${rampGradient('to right', DENSITY_STOPS)}` }), h('span', {}, 'More visits reached'));
}

/**
 * A page taller than the view shows its top. In click mode the view opens on the busiest area instead, so the density a
 * person came to see is on screen; scroll reach starts at the top, where its bands begin.
 */
function focusBusiest(): void {
  if (!data || stage.element.dataset.cropped !== 'true') return;
  const cells = data.grid?.cells ?? [];
  const busiest = mode === 'clicks' ? cells.reduce<[number, number, number] | undefined>((best, cell) => (!best || cell[2] > best[2] ? cell : best), undefined) : undefined;
  const y = busiest ? (busiest[1] + 0.5) * (data.grid?.cellSize ?? 40) * stage.pageScale : 0;
  stage.element.scrollTop = Math.max(0, y - stage.element.clientHeight / 2);
}

/** Says so when the page is taller than the room the view has. */
function cropped(): void {
  const crop = stage.element.dataset.cropped === 'true';
  cropText.hidden = !crop;
  const full = started?.mode() === 'fullscreen';
  cropText.textContent = crop ? (full ? 'This page is taller than the view. Scroll it to see the rest.' : started?.canFullscreen() ? 'This page is taller than the view, so only part of it shows. Full screen shows more of it.' : 'This page is taller than the view, so only part of it shows. The dashboard shows all of it.') : '';
}

/** Draws the density at display resolution over the page. */
function draw(): void {
  if (!data) return;
  const docWidth = documentSize(data.docWidth, 1280), docHeight = documentSize(data.docHeight, 1600);
  const scale = stage.pageScale;
  const width = docWidth * scale, height = docHeight * scale;
  const ratio = canvasPixelRatio(width, height, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return;
  if (mode === 'clicks') drawDensity(context, (data.grid?.cells ?? []) as Cell[], data.grid?.cellSize ?? 40, scale * ratio);
  else drawScrollBands(context, data.scrollDepths ?? []);
  canvas.dataset.mode = mode;
  const dim = mode === 'clicks' && snapshot === 'ready';
  stage.element.classList.toggle('hm-dim', dim);
}

async function showPage(): Promise<void> {
  if (!data) return;
  focusPending = true;
  const size = { width: documentSize(data.docWidth, 1280), height: documentSize(data.docHeight, 1600) };
  const reference = data.reference;
  if (!reference || !idArg(reference.recordingId)) {
    snapshot = 'none';
    stage.blank(size);
    note.hidden = false;
    note.textContent = 'No reference page is available for this group yet, so the density is drawn on a blank page of the typical size. The list shows every value.';
    focusBusiest();
    return;
  }
  snapshot = 'loading';
  stage.showState('loading');
  const response = await started!.call<ReplayResult>('load_replay', { ...(projectId ? { projectId } : {}), recordingId: reference.recordingId });
  if (!response.ok || !playable(response.value.events)) {
    snapshot = 'unavailable';
    stage.blank(size);
    note.hidden = false;
    note.textContent = response.ok
      ? 'The reference recording has too little recorded to rebuild the page, so the density is drawn on a blank page of the typical size.'
      : 'The page behind the density needs the replay scope on this connection, so the density is drawn on a blank page of the typical size.';
    focusBusiest();
    return;
  }
  if (idArg(response.value.projectId)) projectId = projectId ?? response.value.projectId;
  try {
    const events = response.value.events!;
    stage.load({ events, assetOrigin: response.value.assetOrigin, viewport: size, frame: frameForDevice(data.deviceClass), touch: false, document: true });
    // The page as it was when the reference snapshot was taken, held still.
    const opening = events.find(event => event.type === 2);
    stage.freezeAt(Math.max((reference.timestamp ?? opening?.timestamp ?? events[0]!.timestamp) - events[0]!.timestamp, (opening?.timestamp ?? events[0]!.timestamp) - events[0]!.timestamp + 1));
    snapshot = 'ready';
  } catch {
    snapshot = 'unavailable';
    stage.blank(size);
    note.hidden = false;
    note.textContent = 'The reference page could not be rebuilt, so the density is drawn on a blank page of the typical size.';
  }
  draw();
  focusBusiest();
}

function onResult(result: ToolResult): void {
  if (result.isError || !isRecord(result.structuredContent)) {
    summary.textContent = result.content?.find(item => item.type === 'text')?.text?.slice(0, 240) ?? 'There is no heatmap to show.';
    stage.showState('note', 'There is no heatmap to show. Ask for a heatmap cohort, and it appears here.');
    return;
  }
  data = result.structuredContent as HeatmapResult;
  projectId = projectOf(args, result._meta);
  note.hidden = true;
  renderText();
  void showPage();
}

started = await start('Hoot Lens heatmap', {
  input: input => { args = input; },
  result: onResult,
  context: () => { renderFullscreenButton(); stage.layout(); },
});
renderFullscreenButton();
stage.showState('loading');
window.addEventListener('resize', () => stage.layout());
