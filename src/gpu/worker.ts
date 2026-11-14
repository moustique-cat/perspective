// The worker's side of src/gpu/levels.ts.
import { levelBuilder, type Request } from './levels';

const build = levelBuilder();
const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(message: unknown, transfer: Transferable[]): void };
scope.onmessage = (e) => {
  const out = build(e.data);
  if (out) scope.postMessage(out.reply, out.transfer);
};
