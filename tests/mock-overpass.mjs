// A fake Overpass server for offline tests. It answers the app's real tile
// queries from an in-memory OSM dataset (e.g. the synthetic city), and can be
// made flaky: random 429/504 errors and per-server failure rates, so the
// download pool, fallbacks and partial-map handling get exercised.

export function makeMockFetch(dataset, { failRate = 0, deadServers = [], seed = 1, log = null } = {}) {
  const nodes = new Map();
  const ways = [];
  const featureEls = [];
  for (const el of dataset.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
  }
  for (const el of dataset.elements) {
    if (el.type === 'way' && el.nodes) ways.push(el);
    else if (el.geometry || el.members) featureEls.push(el);
  }
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const calls = { total: 0, failed: 0, byHost: {} };

  const fetchImpl = async (url, opts = {}) => {
    const host = new URL(url).host;
    calls.total++;
    calls.byHost[host] = (calls.byHost[host] || 0) + 1;
    await new Promise((r) => setTimeout(r, 1));
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (deadServers.includes(host) || rand() < failRate) {
      calls.failed++;
      const status = rand() < 0.5 ? 504 : 429;
      log?.push(`${host} -> ${status}`);
      return { ok: false, status, json: async () => ({}) };
    }
    const query = decodeURIComponent(String(opts.body).replace(/^data=/, ''));
    const [s0, w0, n0, e0] = query.match(/\[bbox:([^\]]+)\]/)[1].split(',').map(Number);
    const hwRe = new RegExp(query.match(/"highway"~"(\^\([^"]+\)\$)"/)[1]);
    const noSidewalks = query.includes('"footway"!~"^(sidewalk|crossing)$"');
    const inBox = (n) => n && n.lat >= s0 && n.lat <= n0 && n.lon >= w0 && n.lon <= e0;

    const out = [];
    const wayNodeIds = new Set();
    for (const w of ways) {
      if (!w.tags?.highway || !hwRe.test(w.tags.highway)) continue;
      if (noSidewalks && /^(sidewalk|crossing)$/.test(w.tags.footway || '')) continue;
      if (!w.nodes.some((id) => inBox(nodes.get(id)))) continue;
      out.push(w);
      w.nodes.forEach((id) => wayNodeIds.add(id));
    }
    for (const id of wayNodeIds) {
      const n = nodes.get(id);
      if (n.tags) out.push(n); // tagged stop nodes ("node(w.r)[...]; out")
    }
    for (const id of wayNodeIds) {
      const n = nodes.get(id);
      out.push({ type: 'node', id: n.id, lat: n.lat, lon: n.lon }); // ".r >; out skel"
    }
    for (const f of featureEls) {
      const pts = f.geometry || f.members.flatMap((m) => m.geometry || []);
      if (pts.some((p) => p.lat >= s0 && p.lat <= n0 && p.lon >= w0 && p.lon <= e0) ||
          bboxOverlap(pts, s0, w0, n0, e0)) out.push(f);
    }
    return { ok: true, status: 200, json: async () => ({ elements: out }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function bboxOverlap(pts, s, w, n, e) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of pts) {
    a = Math.min(a, p.lat); b = Math.min(b, p.lon); c = Math.max(c, p.lat); d = Math.max(d, p.lon);
  }
  return a <= n && c >= s && b <= e && d >= w;
}
