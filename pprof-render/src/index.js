import { parseProfile } from './profile.js';
import { flameGraph } from './flame.js';
import { rasterize } from './raster.js';
import { encodePNG } from './png.js';

export { parseProfile, decodeProfile, sampleIndex } from './profile.js';
export { buildTrie, top, stackOf, collapseCycles } from './aggregate.js';
export { flameGraph, imageTokens } from './flame.js';
export { summary } from './summary.js';
export { profileTable } from './table.js';
export { rasterize } from './raster.js';
export { encodePNG } from './png.js';

/** pprof bytes (gzipped or not) -> PNG bytes. */
export async function renderFlamePNG(bytes, opts) {
  const dl = flameGraph(await parseProfile(bytes), opts);
  return encodePNG(rasterize(dl), dl.width, dl.height);
}
