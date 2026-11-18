// Working week: which days and hours count as normal. Feeds the metrics (normal vs extra hours, and elapsed
// times that skip non-working days). Pure: Clockify/GitHub/Jira data comes in, numbers go out.

const HOUR_MS = 3_600_000;
export const WORKWEEK_DEFAULT = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', skipOffDays: true };

const toMin = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

export const normalizeWorkweek = (w = {}) => {
  const days = Array.isArray(w.days) ? [...new Set(w.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  let startMin = toMin(w.start, 9 * 60); let endMin = toMin(w.end, 18 * 60);
  if (endMin <= startMin) { startMin = 9 * 60; endMin = 18 * 60; }
  return { days: days.length ? days : WORKWEEK_DEFAULT.days, startMin, endMin, skipOffDays: w.skipOffDays !== false };
};
export const isWorkday = (ww, ms) => ww.days.includes(new Date(ms).getDay());

// calls fn for every local calendar day touched by [a, b], with the slice of the interval inside that day
const eachDay = (a, b, fn) => {
  const d = new Date(a); d.setHours(0, 0, 0, 0);
  while (d.getTime() < b) {
    const start = d.getTime(); const day = d.getDay();
    d.setDate(d.getDate() + 1);
    fn(day, start, Math.max(a, start), Math.min(b, d.getTime()));
  }
};

// hours between two instants, leaving out non-working days when the config says so (NaN if either is missing)
export const elapsedHours = (aIso, bIso, ww) => {
  if (!aIso || !bIso) return NaN;
  const a = typeof aIso === 'number' ? aIso : Date.parse(aIso); const b = typeof bIso === 'number' ? bIso : Date.parse(bIso);
  if (!(b > a)) return 0;
  if (!ww?.skipOffDays) return (b - a) / HOUR_MS;
  let ms = 0;
  eachDay(a, b, (day, _start, lo, hi) => { if (ww.days.includes(day)) ms += hi - lo; });
  return ms / HOUR_MS;
};

// splits an interval into hours inside the working window, outside it on working days, and on non-working days
export const splitHours = (aMs, bMs, ww) => {
  const out = { normal: 0, outside: 0, offDay: 0 };
  if (!(bMs > aMs)) return out;
  eachDay(aMs, bMs, (day, start, lo, hi) => {
    if (!ww.days.includes(day)) { out.offDay += (hi - lo) / HOUR_MS; return; }
    const winLo = start + ww.startMin * 60_000; const winHi = start + ww.endMin * 60_000;
    const inside = Math.max(0, Math.min(hi, winHi) - Math.max(lo, winLo));
    out.normal += inside / HOUR_MS; out.outside += (hi - lo - inside) / HOUR_MS;
  });
  return out;
};
