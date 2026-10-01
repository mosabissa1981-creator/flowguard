// Replays the researched Oct 1–9 2026 macro seed through the regime classifier.
// Run: npx tsx --conditions=react-server scripts/regime-seed-check.ts
import { classifyRegime, composeYields } from "../lib/regime";
const y = (s: "US10Y"|"US30Y", bp: number) => ({ symbol: s, last: 5.3, prevClose: 5.3 - bp/100, changeBp: bp, asOf: null, source: "treasury" as const });
const trend = { us2yBp: 1, us10yBp: 11, us30yBp: 17, bearSteepening: true };
const at = (d: string, et: string) => new Date(`${d}T${et}:00-04:00`);
const cases: [string,string][] = [["2026-10-01","09:45"],["2026-10-01","10:20"],["2026-10-01","11:00"],["2026-10-02","09:40"],["2026-10-02","10:05"],["2026-10-05","11:30"],["2026-10-06","10:30"],["2026-10-07","10:30"],["2026-10-07","13:10"],["2026-10-08","13:30"],["2026-10-09","11:00"]];
for (const [d,t] of cases) {
  const c = classifyRegime({ today: d, now: at(d,t), events: null, us10y: y("US10Y", 1), us30y: y("US30Y", 2), trend5d: trend, tide: null });
  console.log(d, t, "ET", c.label, c.dayRating?.rating, "lockout:", c.lockout.active ? `${c.lockout.event} until ${c.lockout.until}` : "-", "| iv:", c.ivEvents.map(e=>e.title+" "+e.date).join(","));
}
const c = classifyRegime({ today: "2026-10-07", now: at("2026-10-07","09:45"), events: null, us10y: y("US10Y", 4), us30y: y("US30Y", 6), trend5d: trend, tide: null });
console.log(c.reasons);
const rows = [{date:"2026-09-30",y2:4.88,y10:5.29,y30:5.64},{date:"2026-09-29",y2:4.89,y10:5.26,y30:5.59},{date:"2026-09-28",y2:4.92,y10:5.24,y30:5.56},{date:"2026-09-25",y2:4.81,y10:5.17,y30:5.49},{date:"2026-09-24",y2:4.87,y10:5.18,y30:5.47},{date:"2026-09-23",y2:4.88,y10:5.18,y30:5.47}];
console.log(JSON.stringify(composeYields(rows, {y10:null,y30:null}, "2026-09-30")));
console.log(JSON.stringify(composeYields(rows, {y10:{symbol:"US10Y",last:5.33,prevClose:5.29,changeBp:4,asOf:"x",source:"yahoo"},y30:{symbol:"US30Y",last:5.70,prevClose:5.64,changeBp:6,asOf:"x",source:"yahoo"}}, "2026-10-01")));
