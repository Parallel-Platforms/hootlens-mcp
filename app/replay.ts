/*
 * The replay viewer: one visit or page view as an interactive replay with the story of what happened beside it.
 *
 * Data: the model's tool call (get_session_narrative) reaches this view as a result, which carries the steps. The replay
 * itself is fetched on demand through the host (load_replay, a tool only this view calls), so a result the model reads
 * never carries megabytes of events. Nothing here reads more than the signed-in person was already given: the steps are the
 * tool's own result, and the events come from the same recording the replay scope already opens.
 */
import { start, type Started, type ToolResult } from './bridge';
import { h, icon, markerShape } from './dom';
import {
  dashboardUrl, formatClock, idArg, isRecord, markerName, pageViews, placeMarkers, playable, projectOf, reachedStep, snagCount, timelineMarkers,
  type NarrativeResult, type ReplayResult, type Step,
} from './model';
import { Stage } from './stage';
import { frameKindFor } from './frame';
import rrwebCss from 'rrweb/dist/style.css';

const SPEEDS = [1, 2, 4, 8] as const;
const SNAG_LEAD_MS = 1500;
const INLINE_STEPS = 5;

interface Loaded { id: string; result: ReplayResult; touch: boolean }

// Assigned once the host answers (below the handlers that use it), so it cannot be declared with its value.
// eslint-disable-next-line prefer-const
let started: Started;
let narrative: NarrativeResult | undefined;
let args: Record<string, unknown> = {};
let meta: Record<string, unknown> | undefined;
let projectId: string | undefined;
let current: string | undefined;
let loaded: Loaded | undefined;
let status: 'waiting' | 'loading' | 'ready' | 'unavailable' | 'failed' = 'waiting';
let statusNote = '';
let playing = false;
let speed = 1;
let position = 0;
let stepsOpen = false;
let pendingSeek: { recordingId: string; ms: number } | undefined;
const cache = new Map<string, Loaded>();

const root = document.getElementById('app')!;
document.head.append(h('style', {}, rrwebCss));
const stage = new Stage(() => (document.documentElement.dataset.mode === 'fullscreen' ? Math.max(340, window.innerHeight - 260) : window.innerWidth < 520 ? 280 : 340));
stage.onPosition = ms => { position = ms; syncPosition(); };
stage.onFinish = () => { playing = false; position = stage.duration; syncPosition(); syncPlaying(); };
stage.onAssetsBlocked = () => { notice.hidden = false; };
const notice = h('p', { class: 'hl-note', role: 'status', hidden: true }, 'Images, fonts or styles from the recorded page could not be loaded in this view, so the replay shows the page structure and its text.');

/* ---- elements that stay for the life of the view ---- */
const title = h('h1', { class: 'hl-title' });
const subtitle = h('p', { class: 'hl-sub' });
const summary = h('p', { class: 'hl-summary' });
const facts = h('ul', { class: 'hl-facts', 'aria-label': 'Facts about this visit' });
const pagesBar = h('div', { class: 'hl-pages', role: 'group', 'aria-label': 'Page views in this visit', hidden: true });
const fullscreen = h('button', { type: 'button', class: 'hl-button', 'data-testid': 'fullscreen', hidden: true });
const openButton = h('button', { type: 'button', class: 'hl-button', 'data-testid': 'open-in-hoot-lens', 'aria-label': 'Open in Hoot Lens', title: 'Open in Hoot Lens' }, icon.external(), h('span', { class: 'hl-label' }, 'Open in Hoot Lens'));
const playButton = h('button', { type: 'button', class: 'hl-button hl-primary hl-icon', 'data-testid': 'play' });
const restartButton = h('button', { type: 'button', class: 'hl-button hl-icon', 'aria-label': 'Restart replay', title: 'Restart' }, icon.restart());
const scrub = h('input', { type: 'range', class: 'hl-scrub', min: 0, max: 1, step: 1, value: 0, 'aria-label': 'Replay position', 'data-testid': 'scrub' });
const timeLabel = h('span', { class: 'hl-time', 'data-testid': 'time' }, '0:00 / 0:00');
const markersLane = h('div', { class: 'hl-markers', 'data-testid': 'markers' });
const legend = h('p', { class: 'hl-legend', hidden: true });
const speedBar = h('div', { class: 'hl-speeds', role: 'group', 'aria-label': 'Playback speed' }, ...SPEEDS.map(value => {
  const button = h('button', { type: 'button', class: 'hl-chip-button', 'data-speed': value, 'aria-pressed': value === 1 }, `${value}x`);
  button.addEventListener('click', () => setSpeed(value));
  return button;
}));
const stepsHeading = h('h2', { class: 'hl-h2' }, 'What happened');
const stepsList = h('ol', { class: 'hl-steplist', 'aria-label': 'Steps in this visit. Choose one to jump to it.', 'data-testid': 'steps' });
const stepsToggle = h('button', { type: 'button', class: 'hl-link', 'aria-expanded': false, hidden: true });
const stepsNote = h('p', { class: 'hl-muted hl-small' });
const notes = h('div', { class: 'hl-notes', hidden: true });
const live = h('p', { class: 'hl-sr', role: 'status', 'aria-live': 'polite' });

const controls = h('div', { class: 'hl-controls', hidden: true }, playButton, restartButton, h('div', { class: 'hl-track' }, scrub, markersLane), timeLabel);
const controls2 = h('div', { class: 'hl-controls-2', hidden: true }, speedBar, legend);
const player = h('section', { class: 'hl-player', 'aria-label': 'Replay' }, pagesBar, stage.element, notice, controls, controls2);
const stepsPanel = h('section', { class: 'hl-steps', 'aria-label': 'What happened' }, stepsHeading, stepsList, stepsToggle, stepsNote, notes);
root.append(
  h('div', { class: 'hl hl-replay' },
    h('header', { class: 'hl-head' }, h('div', { class: 'hl-headtext' }, title, subtitle), h('div', { class: 'hl-actions' }, fullscreen, openButton)),
    summary, facts,
    h('div', { class: 'hl-body' }, player, stepsPanel),
    live));

/** The controls show only while there is a replay to control. */
function setStatus(next: typeof status): void {
  status = next;
  controls.hidden = controls2.hidden = next !== 'ready';
}

/* ---- behavior ---- */
playButton.addEventListener('click', () => toggle());
restartButton.addEventListener('click', () => { seek(0, false); });
scrub.addEventListener('input', () => { seek(Number(scrub.value), false); });
fullscreen.addEventListener('click', async () => {
  const next = started.mode() === 'fullscreen' ? 'inline' : 'fullscreen';
  await started.setMode(next);
  renderFullscreenButton();
  stage.layout();
});
openButton.addEventListener('click', () => {
  const url = dashboardUrl('recordings', projectId, { ...(current ? { recordingId: current } : {}), ...(loaded?.result.events?.length ? { at: stage.origin + position } : {}) });
  if (url) void started.open(url);
});
stepsToggle.addEventListener('click', () => { stepsOpen = !stepsOpen; renderStepsMode(); });

function toggle(): void {
  if (status !== 'ready') return;
  if (playing) { stage.pause(); position = stage.time; playing = false; }
  else {
    const from = position >= stage.duration ? 0 : position;
    stage.play(from);
    stage.setSpeed(speed);
    playing = true;
  }
  syncPlaying();
}

function seek(ms: number, play: boolean): void {
  if (status !== 'ready') return;
  position = Math.min(stage.duration, Math.max(0, ms));
  if (play) { stage.play(position); stage.setSpeed(speed); playing = true; }
  else { stage.pause(position); playing = false; }
  syncPlaying();
  syncPosition();
}

function setSpeed(value: number): void {
  speed = value;
  stage.setSpeed(value);
  for (const button of speedBar.querySelectorAll('button')) button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === value));
}

function syncPlaying(): void {
  playButton.replaceChildren(playing ? icon.pause() : icon.play());
  playButton.setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
  playButton.title = playing ? 'Pause' : 'Play';
  playButton.dataset.playing = String(playing);
}

function syncPosition(): void {
  const duration = stage.duration;
  scrub.max = String(Math.max(1, Math.round(duration)));
  scrub.value = String(Math.round(position));
  scrub.setAttribute('aria-valuetext', `${formatClock(position)} of ${formatClock(duration)}`);
  timeLabel.textContent = `${formatClock(position)} / ${formatClock(duration)}`;
  scrub.style.setProperty('--hl-progress', duration > 0 ? `${(position / duration) * 100}%` : '0%');
  markCurrentStep();
}

function markCurrentStep(): void {
  const steps = narrative?.steps ?? [];
  const reached = status === 'ready' ? reachedStep(steps, current, position) : -1;
  stepsList.querySelectorAll<HTMLElement>('[data-step]').forEach((item, index) => {
    const button = item.querySelector('button');
    const is = index === reached;
    item.classList.toggle('hl-current', is);
    if (is) button?.setAttribute('aria-current', 'step');
    else button?.removeAttribute('aria-current');
  });
  // In the side by side layout the list scrolls on its own; keep the reached step in view without moving the host page.
  const item = stepsList.querySelector<HTMLElement>(`[data-step="${reached}"]`);
  const box = stepsList.parentElement;
  if (item && box && playing && box.scrollHeight > box.clientHeight + 4 && getComputedStyle(box).overflowY === 'auto') {
    const top = item.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + item.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - 40);
  }
}

function renderFullscreenButton(): void {
  fullscreen.hidden = !started.canFullscreen();
  const full = started.mode() === 'fullscreen';
  fullscreen.replaceChildren(full ? icon.collapse() : icon.expand(), h('span', { class: 'hl-label' }, full ? 'Exit full screen' : 'Full screen'));
  fullscreen.setAttribute('aria-label', full ? 'Exit full screen' : 'Full screen');
  fullscreen.title = full ? 'Exit full screen' : 'Full screen';
}

function renderStepsMode(): void {
  const steps = narrative?.steps ?? [];
  stepsList.classList.toggle('hl-collapsed', !stepsOpen);
  stepsToggle.hidden = steps.length <= INLINE_STEPS;
  stepsToggle.setAttribute('aria-expanded', String(stepsOpen));
  stepsToggle.textContent = stepsOpen ? 'Show fewer steps' : `Show all ${steps.length} steps`;
}

function renderHeader(): void {
  const facts_ = narrative?.facts ?? {};
  const path = loaded?.result.recording?.path ?? facts_.pages?.[0] ?? 'Visit';
  title.textContent = path;
  const device = facts_.device ? facts_.device[0]!.toUpperCase() + facts_.device.slice(1) : undefined;
  const parts = [device, facts_.browser, facts_.os, facts_.durationMs !== undefined ? `${formatClock(facts_.durationMs)} on site` : undefined].filter((value): value is string => !!value);
  subtitle.textContent = parts.join(' · ');
  summary.textContent = narrative?.summary ?? '';
  facts.replaceChildren();
  const add = (text: string, tone?: string) => facts.append(h('li', { class: `hl-fact${tone ? ` hl-${tone}` : ''}` }, text));
  if (facts_.clicks !== undefined) add(`${facts_.clicks.toLocaleString('en-US')} ${facts_.touch ? (facts_.clicks === 1 ? 'tap' : 'taps') : facts_.clicks === 1 ? 'click' : 'clicks'}`);
  if (facts_.pileUps) add(snagCount('rage-click', facts_.pileUps), 'snag');
  if (facts_.noShows) add(snagCount('dead-click', facts_.noShows), 'snag');
  if (facts_.misfires) add(snagCount('error-click', facts_.misfires), 'snag');
  if (facts_.errors) add(`${facts_.errors} JavaScript ${facts_.errors === 1 ? 'error' : 'errors'}`, 'error');
  if (facts_.maxScrollPercent) add(`Scrolled to ${Math.round(facts_.maxScrollPercent)}%`);
}

function renderSteps(): void {
  const steps = narrative?.steps ?? [];
  stepsList.replaceChildren();
  steps.forEach((step, index) => {
    const label = h('span', { class: 'hl-step-text' }, step.text);
    const time = h('span', { class: 'hl-step-time' }, step.clock ?? formatClock(step.atMs ?? 0));
    const tag = step.kind === 'snag' ? h('span', { class: 'hl-badge' }, markerShape('rage-click'), 'Snag') : step.kind === 'error' ? h('span', { class: 'hl-badge hl-badge-error' }, markerShape('js-error'), 'JavaScript error') : null;
    const canSeek = status === 'ready' || status === 'loading';
    const control = canSeek && step.recordingId
      ? h('button', { type: 'button', class: `hl-step hl-step-${step.kind ?? 'other'}`, 'data-testid': 'step' }, time, label, tag)
      : h('span', { class: `hl-step hl-step-${step.kind ?? 'other'}` }, time, label, tag);
    if (control instanceof HTMLButtonElement) control.addEventListener('click', () => void goToStep(step));
    stepsList.append(h('li', { 'data-step': index }, control));
  });
  stepsNote.textContent = [narrative?.note, steps.length === 0 ? 'This visit has no steps to list.' : ''].filter(Boolean).join(' ');
  renderStepsMode();
  markCurrentStep();
  renderNotes();
}

function renderNotes(): void {
  notes.replaceChildren();
  const items = (narrative?.annotations ?? []).filter(entry => entry.recordingId === current || !current);
  const tags = [...new Set(items.flatMap(entry => entry.tags))];
  const written = items.flatMap(entry => entry.notes.map(note => ({ ...note, recordingId: entry.recordingId })));
  notes.hidden = tags.length === 0 && written.length === 0;
  if (notes.hidden) return;
  notes.append(h('h2', { class: 'hl-h2' }, 'Team notes'));
  if (tags.length) notes.append(h('ul', { class: 'hl-tags', 'aria-label': 'Tags' }, ...tags.map(tag => h('li', { class: 'hl-fact' }, tag))));
  for (const note of written) {
    const text = h('span', {}, note.text ?? '');
    if (typeof note.offsetMs === 'number' && status === 'ready') {
      const button = h('button', { type: 'button', class: 'hl-note-button' }, h('span', { class: 'hl-step-time' }, formatClock(note.offsetMs)), text);
      button.addEventListener('click', () => seek(note.offsetMs!, false));
      notes.append(h('p', { class: 'hl-notetext' }, button));
    } else notes.append(h('p', { class: 'hl-notetext' }, text));
  }
}

function renderPages(): void {
  const ids = pageViews(narrative?.steps ?? []);
  pagesBar.hidden = ids.length < 2;
  pagesBar.replaceChildren();
  if (ids.length < 2) return;
  const paths = new Map<string, string>();
  for (const entry of narrative?.annotations ?? []) paths.set(entry.recordingId, entry.path);
  ids.forEach((id, index) => {
    const label = `Page ${index + 1}`;
    const button = h('button', { type: 'button', class: 'hl-chip-button', 'aria-pressed': id === current, 'data-testid': 'page-tab' }, label);
    button.addEventListener('click', () => { if (id !== current) void openRecording(id); });
    pagesBar.append(button);
  });
}

function renderMarkers(): void {
  markersLane.replaceChildren();
  legend.hidden = true;
  if (!loaded || status !== 'ready') return;
  const duration = stage.duration;
  const all = timelineMarkers({ origin: stage.origin, durationMs: duration, clicks: loaded.result.recording?.clicks, errors: loaded.result.errors, touch: loaded.touch });
  const placed = placeMarkers(all, duration, markersLane.clientWidth || 300);
  const kinds = new Set<string>();
  for (const marker of placed) {
    kinds.add(marker.kind);
    const interactive = marker.kind !== 'click';
    const shape = markerShape(marker.kind);
    const common = { class: `hl-marker hl-m-${marker.kind}`, style: `left:${marker.percent}%`, 'data-kind': marker.kind, 'data-offset': Math.round(marker.offsetMs) };
    if (!interactive) { markersLane.append(h('span', { ...common, 'aria-hidden': 'true' }, shape)); continue; }
    const more = marker.hidden ? `, and ${marker.hidden} more close by` : '';
    const button = h('button', { type: 'button', ...common, 'aria-label': `${marker.label}${more}. Jump to just before it.`, title: marker.label, 'data-testid': 'marker' }, shape);
    button.addEventListener('click', () => seek(Math.max(0, marker.offsetMs - SNAG_LEAD_MS), false));
    markersLane.append(button);
  }
  const named = ['rage-click', 'dead-click', 'error-click', 'js-error'].filter(kind => kinds.has(kind)).map(kind => markerName(kind, loaded!.touch));
  legend.hidden = named.length === 0;
  legend.textContent = named.length ? `On the timeline: ${named.join(', ')}. Choose one to jump to just before it.` : '';
}

/* ---- loading ---- */
async function openRecording(id: string, then?: number): Promise<void> {
  current = id;
  playing = false;
  stage.pause();
  syncPlaying();
  renderPages();
  const cached = cache.get(id);
  if (cached) { show(cached, then); return; }
  setStatus('loading');
  stage.showState('loading');
  notice.hidden = true;
  const response = await started.call<ReplayResult>('load_replay', { ...(projectId ? { projectId } : {}), recordingId: id });
  if (current !== id) return; // the person chose another page view meanwhile
  if (!response.ok) {
    // The tool may be missing (replay toolset off) or refused (no replay scope): the steps still read as a story.
    setStatus(/not found|unknown tool|not available|-32601/i.test(response.message) ? 'unavailable' : 'failed');
    statusNote = /scope|permission|403|replay/i.test(response.message)
      ? 'This connection can read the steps of a visit but not watch the replay. The replay needs the replay scope.'
      : status === 'unavailable' ? 'The replay is not available on this connection. The steps below still tell the story.' : `The replay could not be loaded. ${response.message}`;
    stage.showState('note', statusNote);
    renderSteps();
    return;
  }
  const result = response.value;
  if (idArg(result.projectId)) projectId = projectId ?? result.projectId;
  if (!playable(result.events)) {
    setStatus('failed');
    statusNote = 'This page view has too little recorded to replay. The steps below still tell the story.';
    stage.showState('note', statusNote);
    renderSteps();
    return;
  }
  const touch = (result.recording?.deviceClass ?? narrative?.facts?.device) !== 'desktop' && (result.recording?.deviceClass ?? narrative?.facts?.device) !== undefined;
  const entry: Loaded = { id, result, touch };
  cache.set(id, entry);
  if (cache.size > 3) cache.delete(cache.keys().next().value as string);
  show(entry, then);
}

function show(entry: Loaded, then?: number): void {
  try {
    const viewport = entry.result.recording?.viewport ?? { width: 1280, height: 720 };
    stage.load({
      events: entry.result.events!, assetOrigin: entry.result.assetOrigin, viewport, touch: entry.touch,
      frame: frameKindFor({ deviceClass: entry.result.recording?.deviceClass }, viewport),
    });
  } catch {
    setStatus('failed');
    stage.showState('note', 'This recording could not be replayed. The steps below still tell the story.');
    renderSteps();
    return;
  }
  loaded = entry;
  setStatus('ready');
  position = 0;
  stage.setSpeed(speed);
  renderHeader();
  renderMarkers();
  renderSteps();
  renderNotes();
  syncPlaying();
  syncPosition();
  if (then !== undefined) seek(then, false);
  else if (pendingSeek && pendingSeek.recordingId === entry.id) { seek(pendingSeek.ms, false); pendingSeek = undefined; }
}

async function goToStep(step: Step): Promise<void> {
  if (!step.recordingId) return;
  const ms = Math.max(0, step.offsetMs ?? 0);
  live.textContent = `Jumped to ${formatClock(ms)}: ${step.text}`;
  if (step.recordingId !== current) { await openRecording(step.recordingId, ms); return; }
  seek(ms, false);
}

function onResult(result: ToolResult): void {
  if (result.isError || !isRecord(result.structuredContent)) {
    setStatus('failed');
    stage.showState('note', 'There is no visit to show. Ask for a visit or a page view, and it appears here.');
    summary.textContent = result.content?.find(item => item.type === 'text')?.text?.slice(0, 240) ?? '';
    return;
  }
  narrative = result.structuredContent as NarrativeResult;
  meta = result._meta;
  projectId = projectOf(args, meta);
  const ids = pageViews(narrative.steps ?? []);
  const wanted = idArg(args.recordingId);
  current = undefined;
  loaded = undefined;
  cache.clear();
  renderHeader();
  renderPages();
  setStatus('loading');
  renderSteps();
  const first = wanted && (ids.length === 0 || ids.includes(wanted)) ? wanted : ids[0] ?? wanted;
  if (!first) { setStatus('unavailable'); stage.showState('note', 'This visit has no page view to replay. The steps below still tell the story.'); renderSteps(); return; }
  void openRecording(first);
}

started = await start('Hoot Lens replay', {
  input: input => { args = input; },
  result: onResult,
  context: () => { renderFullscreenButton(); stage.layout(); if (status === 'ready') renderMarkers(); },
});
renderFullscreenButton();
stage.showState('loading');
syncPlaying();
window.addEventListener('resize', () => { stage.layout(); if (status === 'ready') renderMarkers(); });
