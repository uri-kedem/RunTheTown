// Geographic helpers: distances, bearings and a local flat projection (meters).

const EARTH_R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Point reached by travelling `dist` meters from (lat, lon) on `bearingDeg`.
export function destination(lat, lon, bearingDeg, dist) {
  const d = dist / EARTH_R;
  const b = toRad(bearingDeg);
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 =
    l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [toDeg(p2), ((toDeg(l2) + 540) % 360) - 180];
}

// Equirectangular projection around an origin. Accurate to <0.5% within ~20 km.
export function makeProjection(lat0, lon0) {
  const ky = 110574;
  const kx = 111320 * Math.cos(toRad(lat0));
  return {
    lat0,
    lon0,
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function bearingName(deg) {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

const COMPASS16 = [
  'north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast',
  'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest',
];
export function bearingNameFine(deg) {
  return COMPASS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * The sun's height above the horizon, in degrees, at a place and a moment (good to about
 * half a degree, which is all a "is it dark?" question needs).
 */
export function sunAltitude(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 - 10957.5; // days since noon on Jan 1, 2000 (UTC)
  const meanLon = 280.46 + 0.9856474 * d;
  const anomaly = (357.528 + 0.9856003 * d) * rad;
  const ecliptic = (meanLon + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * rad;
  const tilt = (23.439 - 0.0000004 * d) * rad;
  const rightAsc = Math.atan2(Math.cos(tilt) * Math.sin(ecliptic), Math.cos(ecliptic));
  const decl = Math.asin(Math.sin(tilt) * Math.sin(ecliptic));
  const sidereal = (18.697374558 + 24.06570982441908 * d) * 15; // Greenwich, in degrees
  const hourAngle = (sidereal + lon) * rad - rightAsc;
  return Math.asin(Math.sin(lat * rad) * Math.sin(decl) + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(hourAngle)) / rad;
}

// The sun this far under the horizon: dusk has set in and the street lamps matter.
export const DARK_SUN_DEG = -3;

/**
 * Will part of a run be in the dark? True when it is dark at the start now, or will be
 * `minutes` from now (a run that starts at sunset ends at night).
 */
export function darkForRun(lat, lon, date = new Date(), minutes = 45) {
  return sunAltitude(lat, lon, date) < DARK_SUN_DEG || sunAltitude(lat, lon, new Date(date.getTime() + minutes * 60000)) < DARK_SUN_DEG;
}
