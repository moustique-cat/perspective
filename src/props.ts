import type { Props } from './frame';

/** The design's four tweaks, as optional address parameters: ?cm=46&speed=0.8&ink=26304A&hand=1 */
export function readProps(search: string, base: Props): Props {
  const q = new URLSearchParams(search);
  const props = { ...base };
  const cm = Number(q.get('cm'));
  if (q.has('cm') && cm >= 20 && cm <= 90) props.moustiqueLengthCm = Math.round(cm);
  const speed = Number(q.get('speed'));
  if (q.has('speed') && speed >= 0.2 && speed <= 3) props.flySpeed = speed;
  const ink = (q.get('ink') || '').replace(/^#/, '');
  if (/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(ink)) props.ink = '#' + ink.toUpperCase();
  if (q.has('hand')) props.handDrawn = !/^(0|false|no|off)$/i.test(q.get('hand') || '');
  return props;
}
