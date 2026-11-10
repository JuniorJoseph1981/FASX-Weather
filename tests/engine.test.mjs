// Tests for the contract engine embedded in index.html — run with:  node --test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const block = html.match(/\/\/ ==== CONTRACT ENGINE START[\s\S]*?\/\/ ==== CONTRACT ENGINE END ====/);
assert.ok(block, "engine block not found in index.html");
const E = new Function(block[0] + "\nreturn { ctCycleStart, ctCycleMonths, ctMonth, ctCycle, ctIndexHistory, ctFloorTenth, ctWeatherDay };")();

// ZS-ESE is given an earlier start (Aug) than the real default (Nov) so the Aug-Oct worked example can be checked.
const ac = (startMonth, extra = {}) => ({ startMonth, cycleMonths: 3, baselineHours: 40, rates: [{ from: startMonth + "-01", perHour: 1800 }], enabled: true, ...extra });
const settings = () => ({
  billing: { multiplier: 1.2, vatPercent: 15 },
  weatherRule: { enabled: true, windowStart: "07:00", windowEnd: "18:00", minFlyableHours: 4, cautionCountsAsFlyable: true },
  releaseDayCountsAsUnavailable: false,
  aircraft: { "ZS-ESE": ac("2026-08"), "ZS-JOG": ac("2026-11"), "ZU-NEW": ac("2027-01", { cycleMonths: 4, baselineHours: 30 }) },
});
// The real ZS-ESE grounding history from data/aircraft_status.csv
const ESE = [
  { Registration: "ZS-ESE", GroundedDate: "2026-08-20", UngroundedDate: "2026-08-26" },
  { Registration: "ZS-ESE", GroundedDate: "2026-09-11", UngroundedDate: "2026-09-12" },
  { Registration: "ZS-ESE", GroundedDate: "2026-10-08", UngroundedDate: "2026-10-14" },
  { Registration: "ZS-ESE", GroundedDate: "2026-10-17", UngroundedDate: "2026-10-26" },
  { Registration: "ZS-ESE", GroundedDate: "2026-10-30", UngroundedDate: "" },
];
// n30-minute rows for a date, all with the same verdict, between 06:00 and 19:30
function dayRows(date, verdict) {
  const rows = [];
  for (let m = 360; m < 1170; m += 30) rows.push({ LocalTime: `${date}T${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 === 0 ? "00" : "30"}`, Verdict: verdict });
  return rows;
}
const ctx = (over = {}) => ({
  settings: settings(), grounding: ESE, histByDate: E.ctIndexHistory([]), overrides: {}, invoices: {},
  todayStr: "2026-11-10", nowMin: 8 * 60, ...over,
});
const force = (reg, dates) => Object.fromEntries(dates.map((d) => [d, "unavailable"]));

test("cycles run invoice-to-invoice from the aircraft's own start month", () => {
  assert.equal(E.ctCycleStart("2026-11", "2026-11", 3), "2026-11");
  assert.equal(E.ctCycleStart("2027-01", "2026-11", 3), "2026-11");
  assert.equal(E.ctCycleStart("2027-02", "2026-11", 3), "2027-02");
  assert.equal(E.ctCycleStart("2026-10", "2026-11", 3), "2026-08");
  assert.equal(E.ctCycleStart("2027-01", "2026-12", 3), "2026-12");     // a different aircraft, a different clock
  assert.equal(E.ctCycleStart("2027-04", "2026-12", 3), "2027-03");
  assert.equal(E.ctCycleStart("2027-05", "2027-01", 4), "2027-05");     // 4-invoice cycles
  assert.deepEqual(E.ctCycleMonths("2026-11", 3), ["2026-11", "2026-12", "2027-01"]);
});

test("baseline = 40 x available/total, rounded DOWN to a tenth", () => {
  assert.equal(E.ctFloorTenth(15.4838), 15.4);
  assert.equal(E.ctFloorTenth(36.0), 36.0);
  assert.equal(E.ctFloorTenth(28.3870), 28.3);
  assert.equal(E.ctFloorTenth(39.99), 39.9);
});

test("clean month: full 40 h baseline", () => {
  const m = E.ctMonth("ZS-ESE", "2026-08", ctx({ grounding: [] }));
  assert.equal(m.total, 31); assert.equal(m.available, 31); assert.equal(m.baseline, 40);
});

test("maintenance days come from the grounding log (release day not counted by default)", () => {
  const aug = E.ctMonth("ZS-ESE", "2026-08", ctx());       // 20..25 = 6 days
  assert.equal(aug.counts.maint, 6);
  const sep = E.ctMonth("ZS-ESE", "2026-09", ctx());       // 11 only
  assert.equal(sep.counts.maint, 1);
  const oct = E.ctMonth("ZS-ESE", "2026-10", ctx());       // 8-13, 17-25, 30-31 = 17
  assert.equal(oct.counts.maint, 17);
  assert.equal(oct.available, 14); assert.equal(oct.baseline, 18.0);   // 40*14/31=18.06
});

test("release day setting adds the release day", () => {
  const c = ctx(); c.settings.releaseDayCountsAsUnavailable = true;
  assert.equal(E.ctMonth("ZS-ESE", "2026-08", c).counts.maint, 7);
});

test("a still-grounded aircraft counts only up to today", () => {
  const nov = E.ctMonth("ZS-ESE", "2026-11", ctx());       // grounded since 30 Oct, today 10 Nov -> 1..10
  assert.equal(nov.counts.maint, 10);
  assert.equal(nov.status, "open");
  assert.equal(nov.baseline, 26.6);                         // 40*20/30 = 26.67 -> 26.6 (provisional)
});

test("weather days are detected from logged checks - and Sundays/holidays count", () => {
  const rows = [...dayRows("2026-11-01", "NO-FLY"), ...dayRows("2026-11-02", "FLYABLE"), ...dayRows("2026-11-03", "CAUTION")];
  const c = ctx({ grounding: [], histByDate: E.ctIndexHistory(rows) });
  const nov = E.ctMonth("ZS-ESE", "2026-11", c);           // 1 Nov 2026 is a Sunday
  assert.equal(nov.days[0].kind, "weather");
  assert.equal(nov.days[1].kind, "ok");
  assert.equal(nov.days[2].kind, "ok");                     // caution counts as flyable by default
  assert.equal(nov.counts.weather, 1);
  c.settings.weatherRule.cautionCountsAsFlyable = false;
  assert.equal(E.ctMonth("ZS-ESE", "2026-11", c).days[2].kind, "weather");
});

test("weather: not enough logged data => unknown, not counted; today is pending until the window ends", () => {
  const few = dayRows("2026-11-04", "NO-FLY").slice(0, 4);
  const c = ctx({ grounding: [], histByDate: E.ctIndexHistory(few) });
  assert.equal(E.ctMonth("ZS-ESE", "2026-11", c).days[3].kind, "nodata");
  const today = E.ctMonth("ZS-ESE", "2026-11", ctx({ grounding: [], histByDate: E.ctIndexHistory(dayRows("2026-11-10", "NO-FLY")), nowMin: 10 * 60 }));
  assert.equal(today.days[9].kind, "pending");
  const late = E.ctMonth("ZS-ESE", "2026-11", ctx({ grounding: [], histByDate: E.ctIndexHistory(dayRows("2026-11-10", "NO-FLY")), nowMin: 19 * 60 }));
  assert.equal(late.days[9].kind, "weather");
});

test("maintenance + weather on the same day counts once", () => {
  const c = ctx({ histByDate: E.ctIndexHistory(dayRows("2026-08-21", "NO-FLY")) });
  const aug = E.ctMonth("ZS-ESE", "2026-08", c);
  assert.equal(aug.days[20].kind, "maint");
  assert.equal(aug.counts.maint, 6); assert.equal(aug.counts.weather, 0); assert.equal(aug.available, 25);
});

test("manual overrides beat the automatic call, both ways", () => {
  const c = ctx({ grounding: [], histByDate: E.ctIndexHistory(dayRows("2026-11-05", "NO-FLY")) });
  assert.equal(E.ctMonth("ZS-ESE", "2026-11", c).days[4].kind, "weather");
  c.overrides = { "ZS-ESE": { "2026-11-05": "available", "2026-11-06": "unavailable" } };
  const nov = E.ctMonth("ZS-ESE", "2026-11", c);
  assert.equal(nov.days[4].kind, "forced-on"); assert.equal(nov.days[4].unavailable, false);
  assert.equal(nov.days[5].kind, "forced-off"); assert.equal(nov.days[5].unavailable, true);
});

test("months before an aircraft's start month are not tracked at all (fresh start)", () => {
  for (const ym of ["2026-08", "2026-09", "2026-10"]) {
    const m = E.ctMonth("ZS-JOG", ym, ctx({ grounding: [] }));
    assert.equal(m.status, "na"); assert.equal(m.baseline, 0);
  }
  assert.notEqual(E.ctMonth("ZS-JOG", "2026-11", ctx({ grounding: [] })).status, "na");
  // a cycle that straddles nothing: the Aug-Oct cycle for ZS-JOG is entirely untracked and never bills
  const cy = E.ctCycle("ZS-JOG", "2026-08", ctx({ grounding: [], todayStr: "2027-03-01" }));
  assert.equal(cy.deficit, 0); assert.ok(cy.months.every((m) => m.status === "na"));
});

test("each aircraft has its own baseline hours and cycle length", () => {
  const nu = E.ctMonth("ZU-NEW", "2027-01", ctx({ grounding: [], todayStr: "2027-03-01" }));
  assert.equal(nu.baseline, 30);
  const cy = E.ctCycle("ZU-NEW", "2027-01", ctx({ grounding: [], todayStr: "2027-09-01" }));
  assert.equal(cy.months.length, 4);
});

test("price history: a rise only affects cycles that end after it", () => {
  const c = ctx({ grounding: [], todayStr: "2027-09-01", invoices: {
    "ZS-JOG|2026-11": { invoicedHours: 30 }, "ZS-JOG|2026-12": { invoicedHours: 40 }, "ZS-JOG|2027-01": { invoicedHours: 40 },
    "ZS-JOG|2027-02": { invoicedHours: 30 }, "ZS-JOG|2027-03": { invoicedHours: 40 }, "ZS-JOG|2027-04": { invoicedHours: 40 } } });
  c.settings.aircraft["ZS-JOG"].rates = [{ from: "2026-11-01", perHour: 1800 }, { from: "2027-03-01", perHour: 1950 }];
  const first = E.ctCycle("ZS-JOG", "2026-11", c);     // ends 31 Jan 2027 -> R1800
  const second = E.ctCycle("ZS-JOG", "2027-02", c);    // ends 30 Apr 2027 -> R1950
  assert.equal(first.deficit, 10); assert.equal(first.perHour, 1800); assert.equal(first.rand.exVat, 21600);
  assert.equal(second.deficit, 10); assert.equal(second.perHour, 1950); assert.equal(second.rand.exVat, 23400);
});

test("the contract's own example: 60 h then 30 h leaves no deficit", () => {
  const c = ctx({ grounding: [], todayStr: "2027-03-01", invoices: {
    "ZS-ESE|2026-11": { invoicedHours: 60 }, "ZS-ESE|2026-12": { invoicedHours: 30 }, "ZS-ESE|2027-01": { invoicedHours: 40 } } });
  const cy = E.ctCycle("ZS-ESE", "2026-11", c);
  assert.equal(cy.months[0].diff, 20); assert.equal(cy.months[1].diff, -10);
  assert.equal(cy.balance, 10); assert.equal(cy.deficit, 0); assert.equal(cy.state, "final"); assert.equal(cy.billable, 0);
});

test("worked example: Aug-Oct cycle ends with a 2.2 h billable deficit", () => {
  // weather days (non-maintenance): Aug 3, Sep 2, Oct 2 - forced via overrides
  const overrides = { "ZS-ESE": {
    ...force("ZS-ESE", ["2026-08-03", "2026-08-04", "2026-08-05", "2026-09-02", "2026-09-03", "2026-10-05", "2026-10-15"]) } };
  const c = ctx({ overrides, todayStr: "2026-11-10", invoices: {
    "ZS-ESE|2026-08": { invoicedHours: 34.0 }, "ZS-ESE|2026-09": { invoicedHours: 31.5 }, "ZS-ESE|2026-10": { invoicedHours: 12.0, ownerHours: 0 } } });
  const cy = E.ctCycle("ZS-ESE", "2026-08", c);
  assert.deepEqual(cy.months.map((m) => m.baseline), [28.3, 36.0, 15.4]);
  assert.deepEqual(cy.months.map((m) => m.diff), [5.7, -4.5, -3.4]);
  assert.deepEqual(cy.months.map((m) => m.balanceAfter), [5.7, 1.2, -2.2]);
  assert.equal(cy.deficit, 2.2); assert.equal(cy.state, "final"); assert.equal(cy.billable, 2.2);
  assert.equal(cy.rand.exVat, 4752); assert.equal(cy.rand.inclVat, 5464.8);
});

test("owner-flying hours are excluded from the counted hours", () => {
  const c = ctx({ grounding: [], todayStr: "2027-03-01", invoices: { "ZS-ESE|2026-11": { invoicedHours: 45, ownerHours: 8 } } });
  const m = E.ctCycle("ZS-ESE", "2026-11", c).months[0];
  assert.equal(m.counted, 37); assert.equal(m.diff, -3);
});

test("a cycle is provisional until every month has ended and has an invoice", () => {
  const cy = E.ctCycle("ZS-ESE", "2026-11", ctx({ grounding: [], invoices: { "ZS-ESE|2026-11": { invoicedHours: 10 } } }));
  assert.equal(cy.state, "provisional"); assert.equal(cy.billable, null);
});

test("credit never carries across cycles", () => {
  const c = ctx({ grounding: [], todayStr: "2027-06-01", invoices: {
    "ZS-ESE|2026-11": { invoicedHours: 100 }, "ZS-ESE|2026-12": { invoicedHours: 40 }, "ZS-ESE|2027-01": { invoicedHours: 40 },
    "ZS-ESE|2027-02": { invoicedHours: 30 }, "ZS-ESE|2027-03": { invoicedHours: 40 }, "ZS-ESE|2027-04": { invoicedHours: 40 } } });
  assert.equal(E.ctCycle("ZS-ESE", "2026-11", c).credit, 60);
  assert.equal(E.ctCycle("ZS-ESE", "2027-02", c).deficit, 10);   // the 60 h credit is gone
});
