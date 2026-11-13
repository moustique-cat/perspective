// Runs the design's own component, unedited, outside the design tool.
//
// The tests use this as the judge: whatever the original computes for a given zoom, window
// and sequence of events is by definition right, and the site's code has to agree with it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ORIGINAL_PATH = fileURLToPath(new URL('../design/original/PowersRefined.dc.html', import.meta.url));
export const originalSource = fs.readFileSync(ORIGINAL_PATH, 'utf8');

const match = originalSource.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>([\s\S]*?)<\/script>/);
if (!match) throw new Error('component script not found in the original');
const declared = JSON.parse(match[1]) as Record<string, { default: unknown }>;
export const originalScript = match[2];
export const originalProps: Record<string, unknown> = {};
for (const k of Object.keys(declared)) if (!k.startsWith('$')) originalProps[k] = declared[k].default;

export interface OriginalOptions {
  width?: number;
  props?: Record<string, unknown>;
  reduced?: boolean;
  coarse?: boolean;
}

/** One running instance of the original component with a clock the test controls. */
export function runOriginal(opts: OriginalOptions = {}) {
  let pending: ((ts: number) => void) | null = null;
  let ids = 0;
  const win = {
    innerWidth: opts.width ?? 1280,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: (q: string) => ({ matches: q.includes('reduce') ? !!opts.reduced : q.includes('coarse') ? !!opts.coarse : false }),
  };
  // The design tool re-renders after every setState; so does this stand-in.
  class DCLogic {
    props: Record<string, unknown>;
    state: Record<string, unknown> | undefined;
    constructor(props: Record<string, unknown>) { this.props = props; }
    setState(update: Record<string, unknown>) {
      this.state = Object.assign({}, this.state, update);
      (this as unknown as { renderVals(): unknown }).renderVals();
    }
  }
  const raf = (cb: (ts: number) => void) => { pending = cb; return ++ids; };
  const caf = () => { pending = null; };
  const Component = new Function('DCLogic', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', originalScript + '\n;return Component;')(DCLogic, win, raf, caf);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comp: any = new Component({ ...originalProps, ...opts.props });
  comp.renderVals();
  comp.componentDidMount();
  return {
    comp,
    /** What the original would draw right now, without its event handlers. */
    vals(): Record<string, unknown> { return plain(comp.renderVals()); },
    /** Put the original at a zoom directly. */
    setZ(z: number) { comp.zT = z; comp.jump = null; comp.setState({ z, playing: 0 }); },
    /** Run the animation frame the component asked for, if any. */
    frame(ts: number): boolean {
      if (!pending) return false;
      const cb = pending;
      pending = null;
      cb(ts);
      return true;
    },
    get waiting() { return pending !== null; },
  };
}

/** Deep copy without functions, so two frames can be compared value for value. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'function' ? undefined : v)));
}
