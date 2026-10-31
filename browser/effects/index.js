import { subjectFx } from './subject.js';
import { colorFx } from './color.js';
import { glitchFx } from './glitch.js';
import { timeFx } from './time.js';
import { distortFx } from './distort.js';
import { finishFx } from './finish.js';

export const CATEGORIES = [
  { id: 'subject', name: 'Subject', hint: 'needs a cutout' },
  { id: 'distort', name: 'Distort' },
  { id: 'time', name: 'Time' },
  { id: 'glitch', name: 'Glitch' },
  { id: 'color', name: 'Color' },
  { id: 'finish', name: 'Finish' },
];

export const EFFECTS = Object.fromEntries(
  [...subjectFx, ...distortFx, ...timeFx, ...glitchFx, ...colorFx, ...finishFx].map((e) => [e.id, e]),
);

export const isNum = (p) => !p.type || p.type === 'number';

export function defaults(fx) {
  return Object.fromEntries(fx.params.map((p) => [p.key, p.def]));
}

let uidN = 0;
export const uid = () => `L${Date.now().toString(36)}${(uidN++).toString(36)}`;

/** A new layer of effect `id`, with optional param overrides. */
export function makeLayer(id, params = {}, extra = {}) {
  const fx = EFFECTS[id];
  return { uid: uid(), fx: id, on: true, mix: 1, scope: 'all', params: { ...defaults(fx), ...params }, mods: [], ...extra };
}
