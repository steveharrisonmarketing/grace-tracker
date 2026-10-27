/* Self-test for the date & streak logic in app.js.
 * Run: node test.js   (try several timezones: TZ=America/New_York node test.js) */
'use strict';
const assert = require('assert');
const L = require('./app.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

/** Fresh state with optional log: { 'YYYY-MM-DD': { habitId: count } }. */
function makeState(log = {}) {
  const s = L.defaultState();
  s.log = JSON.parse(JSON.stringify(log));
  return s;
}
const habit = (s, id) => s.habits.find((h) => h.id === id);
/** Log `ids` as fully done on every date in `dates`. */
function doneOn(s, dates, ids = s.habits.map((h) => h.id)) {
  for (const d of dates) {
    s.log[d] = s.log[d] || {};
    for (const id of ids) s.log[d][id] = habit(s, id).target;
  }
  return s;
}

const T = '2026-10-27'; // "today" for the tests
const day = (n) => L.addDays(T, n);

console.log(`Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

console.log('Dates');
test('dateKey uses local date parts, zero-padded', () => {
  assert.strictEqual(L.dateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.strictEqual(L.dateKey(new Date(2026, 11, 31, 0, 0)), '2026-12-31');
});
test('late evening is still "today" (no UTC shift)', () => {
  assert.strictEqual(L.todayKey(new Date(2026, 9, 27, 23, 45)), '2026-10-27');
  assert.strictEqual(L.todayKey(new Date(2026, 9, 27, 0, 5)), '2026-10-27');
});
test('addDays crosses month, year, leap day', () => {
  assert.strictEqual(L.addDays('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(L.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(L.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(L.addDays('2026-03-01', -1), '2026-02-28');
});
test('addDays steps exactly one day across DST changes (US, EU, AU)', () => {
  for (const d of ['2026-03-07', '2026-03-08', '2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25', '2026-10-31', '2026-11-01', '2026-04-04', '2026-10-03']) {
    assert.strictEqual(L.daysBetween(d, L.addDays(d, 1)), 1, d);
    assert.strictEqual(L.addDays(L.addDays(d, 1), -1), d, d);
  }
  // Walk a whole year one day at a time: 365 distinct dates.
  const seen = new Set();
  let d = '2026-01-01';
  for (let i = 0; i < 365; i++) { seen.add(d); d = L.addDays(d, 1); }
  assert.strictEqual(seen.size, 365);
  assert.strictEqual(d, '2027-01-01');
});
test('mondayOf', () => {
  assert.strictEqual(L.mondayOf('2026-10-27'), '2026-10-26'); // Tue
  assert.strictEqual(L.mondayOf('2026-10-26'), '2026-10-26'); // Mon
  assert.strictEqual(L.mondayOf('2026-11-01'), '2026-10-26'); // Sun
});

console.log('Habit streaks');
test('no data -> all zeros', () => {
  const s = makeState();
  assert.deepStrictEqual(L.habitStats(s, habit(s, 'read'), T), { current: 0, best: 0, total: 0, pct30: 0 });
});
test('done today + 2 previous days -> streak 3', () => {
  const s = doneOn(makeState(), [day(0), day(-1), day(-2)], ['read']);
  const st = L.habitStats(s, habit(s, 'read'), T);
  assert.strictEqual(st.current, 3);
  assert.strictEqual(st.best, 3);
  assert.strictEqual(st.total, 3);
});
test('today not done yet does NOT break the streak', () => {
  const s = doneOn(makeState(), [day(-1), day(-2)], ['read']);
  assert.strictEqual(L.habitStats(s, habit(s, 'read'), T).current, 2);
});
test('missed yesterday -> streak 0 (until today is done)', () => {
  const s = doneOn(makeState(), [day(-2), day(-3)], ['read']);
  assert.strictEqual(L.habitStats(s, habit(s, 'read'), T).current, 0);
  doneOn(s, [T], ['read']);
  assert.strictEqual(L.habitStats(s, habit(s, 'read'), T).current, 1);
});
test('gap splits streaks; best remembers the longest run', () => {
  const s = doneOn(makeState(), [day(-10), day(-9), day(-8), day(-7), day(-5), day(-1), day(0)], ['read']);
  const st = L.habitStats(s, habit(s, 'read'), T);
  assert.strictEqual(st.current, 2);
  assert.strictEqual(st.best, 4);
  assert.strictEqual(st.total, 7);
});
test('streaks run across month/year boundaries', () => {
  const s = doneOn(makeState(), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'], ['read']);
  const st = L.habitStats(s, habit(s, 'read'), '2027-01-02');
  assert.strictEqual(st.current, 4);
  assert.strictEqual(st.best, 4);
});
test('streak across DST change dates', () => {
  const dates = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30'];
  const s = doneOn(makeState(), dates, ['read']);
  assert.strictEqual(L.habitStats(s, habit(s, 'read'), '2026-11-02').current, 4);
  assert.strictEqual(L.habitStats(s, habit(s, 'read'), '2026-11-02').best, 4);
});
test('future entries are ignored', () => {
  const s = doneOn(makeState(), [day(1), day(2), day(3), day(4)], ['read']);
  assert.deepStrictEqual(L.habitStats(s, habit(s, 'read'), T), { current: 0, best: 0, total: 0, pct30: 0 });
});
test('other habits do not affect this habit', () => {
  const s = doneOn(makeState(), [day(0), day(-1)], ['stretch']);
  assert.strictEqual(L.habitStats(s, habit(s, 'read'), T).current, 0);
  assert.strictEqual(L.habitStats(s, habit(s, 'stretch'), T).current, 2);
});

console.log('Water counter');
test('1 of 2 bottles is not done; 2 is done', () => {
  const s = makeState({ [T]: { water: 1 } });
  assert.strictEqual(L.isDone(s, T, habit(s, 'water')), false);
  s.log[T].water = 2;
  assert.strictEqual(L.isDone(s, T, habit(s, 'water')), true);
});
test('water streak only counts full days', () => {
  const s = makeState({ [day(0)]: { water: 2 }, [day(-1)]: { water: 1 }, [day(-2)]: { water: 2 }, [day(-3)]: { water: 2 } });
  const st = L.habitStats(s, habit(s, 'water'), T);
  assert.strictEqual(st.current, 1);
  assert.strictEqual(st.best, 2);
  assert.strictEqual(st.total, 3);
});

console.log('Overall (perfect day) streak');
test('perfect day needs every habit, incl. 2 bottles', () => {
  const s = doneOn(makeState(), [T]);
  assert.strictEqual(L.allDone(s, T), true);
  s.log[T].water = 1;
  assert.strictEqual(L.allDone(s, T), false);
  assert.strictEqual(L.dayFraction(s, T), 6 / 7);
});
test('overall current/best/perfectDays', () => {
  const s = doneOn(makeState(), [day(-1), day(-2), day(-3), day(-6), day(-7)]);
  doneOn(s, [day(-4)], ['read']); // partial day breaks the run
  doneOn(s, [T], ['read', 'stretch']); // today partly done: streak still alive
  assert.deepStrictEqual(L.overallStats(s, T), { current: 3, best: 3, perfectDays: 5 });
});
test('a habit added today does not spoil earlier perfect days', () => {
  const s = doneOn(makeState(), [day(-2), day(-1)]);
  s.habits.push({ id: 'new', name: 'Journal', emoji: '📓', target: 1, created: T });
  assert.strictEqual(L.allDone(s, day(-1)), true);
  assert.strictEqual(L.overallStats(s, T).current, 2);
  doneOn(s, [T], s.habits.filter((h) => h.id !== 'new').map((h) => h.id));
  assert.strictEqual(L.allDone(s, T), false, 'new habit counts from today');
});
test('no habits -> never a perfect day', () => {
  const s = makeState();
  s.habits = [];
  assert.strictEqual(L.allDone(s, T), false);
  assert.strictEqual(L.overallStats(s, T).current, 0);
});

console.log('Last 30 days %');
test('15 of 30 days -> 50%', () => {
  const s = doneOn(makeState(), Array.from({ length: 15 }, (_, i) => day(-2 * i)), ['read']);
  assert.strictEqual(L.habitStats(s, habit(s, 'read'), T).pct30, 50);
});
test('days before a habit was added are not counted', () => {
  const s = makeState();
  s.habits.push({ id: 'new', name: 'Journal', emoji: '📓', target: 1, created: day(-3) });
  doneOn(s, [day(-3), day(-2)], ['new']);
  assert.strictEqual(L.habitStats(s, habit(s, 'new'), T).pct30, 50); // 2 of 4 days
});
test('day 31 ago is outside the window', () => {
  const s = doneOn(makeState(), [day(-30)], ['read']);
  assert.strictEqual(L.habitStats(s, habit(s, 'read'), T).pct30, 0);
});

console.log('Reminders & calendar');
test('reminderPassed', () => {
  assert.strictEqual(L.reminderPassed('19:30', new Date(2026, 9, 27, 19, 29)), false);
  assert.strictEqual(L.reminderPassed('19:30', new Date(2026, 9, 27, 19, 30)), true);
  assert.strictEqual(L.reminderPassed('19:30', new Date(2026, 9, 27, 23, 0)), true);
});
test('.ics repeats daily at local reminder time with an alarm', () => {
  const ics = L.buildIcs('19:30', new Date(2026, 9, 27, 10, 0));
  assert.match(ics, /\r\nDTSTART:20261027T193000\r\n/);
  assert.match(ics, /\r\nRRULE:FREQ=DAILY\r\n/);
  assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY/);
  assert.match(ics, /TRIGGER:PT0M/);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.includes('END:VCALENDAR'));
  assert.ok(!/DTSTART[^\r]*Z/.test(ics), 'start time must be local (floating), not UTC');
});

console.log('Import');
test('valid backup round-trips', () => {
  const s = doneOn(makeState(), [T, day(-1)]);
  s.settings.reminderTime = '20:15';
  const back = L.sanitizeImport(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(back.habits, s.habits);
  assert.deepStrictEqual(back.log, s.log);
  assert.strictEqual(back.settings.reminderTime, '20:15');
});
test('junk is rejected or cleaned', () => {
  assert.throws(() => L.sanitizeImport(null));
  assert.throws(() => L.sanitizeImport({ hello: 1 }));
  assert.throws(() => L.sanitizeImport({ habits: [{}], log: {} }));
  const out = L.sanitizeImport({
    habits: [{ id: 'a', name: ' Read ', target: 99 }, { id: 'a', name: 'Dup id' }],
    log: { 'not-a-date': { a: 1 }, '2026-10-27': { a: 1, ghost: 1, a_: -3 } },
    settings: { reminderTime: 'whenever' },
  });
  assert.strictEqual(out.habits[0].name, 'Read');
  assert.strictEqual(out.habits[0].target, 5);
  assert.notStrictEqual(out.habits[0].id, out.habits[1].id);
  assert.deepStrictEqual(out.log, { '2026-10-27': { a: 1 } });
  assert.strictEqual(out.settings.reminderTime, '19:30');
});

console.log(process.exitCode ? '\nSome tests FAILED' : `\nAll ${passed} tests passed 🎉`);
