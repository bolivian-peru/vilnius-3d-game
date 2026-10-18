// Coordinate contract shared with pipeline/vilnius_pipeline/config.py.
// World frame is three.js Y-up: x = east, y = height, z = -north, metres from the project origin.

export const ORIGIN = { e: 582250, n: 6062250, h: 100 };
export const TILE_SIZE = 500;

const A = 6378137;
const F = 1 / 298.257222101;
const N = F / (2 - F);
const A_HAT = (A / (1 + N)) * (1 + (N * N) / 4 + N ** 4 / 64);
const ALPHA = [N / 2 - (2 * N * N) / 3 + (5 * N ** 3) / 16, (13 * N * N) / 48 - (3 * N ** 3) / 5, (61 * N ** 3) / 240];
const C = (2 * Math.sqrt(N)) / (1 + N);
const K0 = 0.9998;
const LON0 = (24 * Math.PI) / 180;

/** Geographic radians -> LKS-94 (EPSG:3346) easting/northing, Krüger series. */
function lks94(lon, lat) {
  const s = Math.sin(lat);
  const t = Math.sinh(Math.atanh(s) - C * Math.atanh(C * s));
  const dl = lon - LON0;
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let e = eta, n = xi;
  for (let j = 1; j <= 3; j++) {
    e += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    n += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [500000 + K0 * A_HAT * e, K0 * A_HAT * n];
}

/** Web Mercator (EPSG:3857) -> local metres [east, north] from the project origin. */
export function mercatorToLocal(x, y) {
  const [e, n] = lks94(x / A, Math.atan(Math.sinh(y / A)));
  return [e - ORIGIN.e, n - ORIGIN.n];
}

export function lonLatToLocal(lonDeg, latDeg) {
  const [e, n] = lks94((lonDeg * Math.PI) / 180, (latDeg * Math.PI) / 180);
  return [e - ORIGIN.e, n - ORIGIN.n];
}

export function tileName(east, north) {
  const part = (pos, neg, v) => `${v >= 0 ? pos : neg}${String(Math.abs(v)).padStart(3, '0')}`;
  return `${part('E', 'W', Math.floor(east / TILE_SIZE))}_${part('N', 'S', Math.floor(north / TILE_SIZE))}`;
}
