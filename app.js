/* Grace's Habit Tracker
 * ---------------------------------------------------------------
 * One plain script, no dependencies. It has two parts:
 *   1. `Logic`: pure functions (dates, streaks, stats, .ics, import
 *      checks). No DOM. Exported for Node so test.js can run them.
 *   2. The UI: runs only in a browser. Renders the three tabs
 *      (Today, Progress, Settings) and saves everything to localStorage.
 *
 * Data shape (saved to localStorage as JSON):
 *   {
 *     version: 1,
 *     habits: [{ id, name, emoji, target, created }],  // target 1 = checkbox, >1 = counter
 *     log: { "YYYY-MM-DD": { [habitId]: count } },     // local dates only
 *     settings: { reminderTime: "19:30", notify: false, lastNotified: "", installHelpDismissed: false }
 *   }
 */
'use strict';

const Logic = (() => {
  // ---------- Dates ----------
  // All dates are local "YYYY-MM-DD" strings. We never use toISOString()
  // for days because that converts to UTC and can move the date by one.

  const pad = (n) => String(n).padStart(2, '0');

  /** Date object -> local "YYYY-MM-DD". */
  function dateKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** "YYYY-MM-DD" -> Date at local noon (noon keeps us well away from DST edges). */
  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  }

  /** Add (or subtract) whole days to a date key. */
  function addDays(key, n) {
    const d = parseKey(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }

  function todayKey(now = new Date()) {
    return dateKey(now);
  }

  /** Monday of the week containing `key`. */
  function mondayOf(key) {
    const dow = (parseKey(key).getDay() + 6) % 7; // Mon = 0 ... Sun = 6
    return addDays(key, -dow);
  }

  /** Number of whole days from a to b (b - a). */
  function daysBetween(a, b) {
    return Math.round((parseKey(b) - parseKey(a)) / 86400000);
  }

  // ---------- Default data ----------

  // "Since forever", so Grace can backfill yesterday on her very first day.
  const EPOCH = '2000-01-01';

  function defaultHabits() {
    return [
      { id: 'read',    emoji: '📚', name: 'Read 10 pages',              target: 1 },
      { id: 'workout', emoji: '🏃‍♀️', name: '30 min workout',            target: 1 },
      { id: 'stretch', emoji: '🧘‍♀️', name: 'Stretch',                   target: 1 },
      { id: 'meals',   emoji: '🥗', name: 'Healthy balanced meals',     target: 1 },
      { id: 'snacks',  emoji: '🍎', name: 'Healthy snacks',             target: 1 },
      { id: 'bed',     emoji: '🛏️', name: 'In bed by 9:30pm',           target: 1 },
      { id: 'water',   emoji: '💧', name: 'Drink 2 bottles of water',   target: 2 },
    ].map((h) => ({ ...h, created: EPOCH }));
  }

  function defaultState() {
    return {
      version: 1,
      habits: defaultHabits(),
      log: {},
      settings: { reminderTime: '19:30', notify: false, lastNotified: '', installHelpDismissed: false },
    };
  }

  // ---------- Completion ----------

  function countFor(state, date, habitId) {
    return (state.log[date] && state.log[date][habitId]) || 0;
  }

  function isDone(state, date, habit) {
    return countFor(state, date, habit.id) >= habit.target;
  }

  /** Habits that existed on `date` (so adding a new habit doesn't spoil old perfect days). */
  function habitsOn(state, date) {
    return state.habits.filter((h) => (h.created || EPOCH) <= date);
  }

  /** Fraction of that day's habits completed (0..1). */
  function dayFraction(state, date) {
    const active = habitsOn(state, date);
    if (!active.length) return 0;
    return active.filter((h) => isDone(state, date, h)).length / active.length;
  }

  /** A "perfect day": every habit that existed that day was completed. */
  function allDone(state, date) {
    const active = habitsOn(state, date);
    return active.length > 0 && active.every((h) => isDone(state, date, h));
  }

  // ---------- Streaks ----------

  /**
   * Current streak for any "was this day a win?" test.
   * Counts back from today. If today isn't done *yet*, we start from
   * yesterday instead, so the streak isn't broken until the day is over.
   */
  function currentStreak(isWin, today) {
    let d = isWin(today) ? today : addDays(today, -1);
    let n = 0;
    while (isWin(d)) {
      n++;
      d = addDays(d, -1);
    }
    return n;
  }

  /** Longest run of consecutive winning days among `dates` (any order, may repeat). */
  function bestStreak(isWin, dates) {
    const wins = [...new Set(dates)].filter(isWin).sort();
    let best = 0;
    let run = 0;
    let prev = null;
    for (const d of wins) {
      run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
      best = Math.max(best, run);
      prev = d;
    }
    return best;
  }

  /** Logged dates up to and including today (ignores any stray future entries). */
  function loggedDates(state, today) {
    return Object.keys(state.log).filter((d) => d <= today);
  }

  /** Streaks, total and last-30-days % for one habit. */
  function habitStats(state, habit, today) {
    const isWin = (d) => isDone(state, d, habit);
    const dates = loggedDates(state, today);
    // Last 30 days including today, but not before the habit was added.
    const created = habit.created || EPOCH;
    let windowDays = 0;
    let windowDone = 0;
    for (let i = 0; i < 30; i++) {
      const d = addDays(today, -i);
      if (d < created) break;
      windowDays++;
      if (isWin(d)) windowDone++;
    }
    return {
      current: currentStreak(isWin, today),
      best: bestStreak(isWin, dates),
      total: dates.filter(isWin).length,
      pct30: windowDays ? Math.round((windowDone / windowDays) * 100) : 0,
    };
  }

  /** Perfect-day (all habits done) streaks and count. */
  function overallStats(state, today) {
    const isWin = (d) => allDone(state, d);
    const dates = loggedDates(state, today);
    return {
      current: currentStreak(isWin, today),
      best: bestStreak(isWin, dates),
      perfectDays: dates.filter(isWin).length,
    };
  }

  // ---------- Reminders ----------

  /** Has the "HH:MM" reminder time passed (local time)? */
  function reminderPassed(reminderTime, now = new Date()) {
    const [h, m] = reminderTime.split(':').map(Number);
    return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
  }

  /** Escape text for .ics fields. */
  const icsText = (s) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');

  /**
   * A repeating daily calendar event with an alarm at the reminder time.
   * DTSTART has no "Z"/TZID, so it's "floating" local time: 7:30pm
   * wherever the phone is, which is exactly what we want.
   */
  function buildIcs(reminderTime, now = new Date()) {
    const [h, m] = reminderTime.split(':');
    const start = todayKey(now).replace(/-/g, '') + `T${h}${m}00`;
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Grace Habits//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:grace-habits-daily-${stamp}@grace-habits`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      'DURATION:PT10M',
      'RRULE:FREQ=DAILY',
      `SUMMARY:${icsText('🌸 Habit check-in')}`,
      `DESCRIPTION:${icsText('Open your habit tracker and tick off what you did today. You\'ve got this!')}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText('Habit check-in time! 🌸')}`,
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
  }

  // ---------- Import validation ----------

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;

  /** Turn an imported JSON object into a clean state, or throw a friendly Error. */
  function sanitizeImport(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.habits) || typeof obj.log !== 'object' || !obj.log) {
      throw new Error("That file doesn't look like a habit backup.");
    }
    const seen = new Set();
    const habits = obj.habits.map((h, i) => {
      if (!h || typeof h.name !== 'string' || !h.name.trim()) throw new Error(`Habit #${i + 1} has no name.`);
      let id = typeof h.id === 'string' && h.id ? h.id : `h${i}`;
      while (seen.has(id)) id += '_';
      seen.add(id);
      return {
        id,
        name: h.name.trim().slice(0, 60),
        emoji: typeof h.emoji === 'string' && h.emoji ? h.emoji.slice(0, 8) : '⭐',
        target: Math.min(5, Math.max(1, Math.round(Number(h.target)) || 1)),
        created: typeof h.created === 'string' && DATE_RE.test(h.created) ? h.created : EPOCH,
      };
    });
    const log = {};
    for (const [date, day] of Object.entries(obj.log)) {
      if (!DATE_RE.test(date) || !day || typeof day !== 'object') continue;
      const clean = {};
      for (const [id, n] of Object.entries(day)) {
        const c = Math.round(Number(n));
        if (seen.has(id) && c > 0) clean[id] = Math.min(c, 99);
      }
      if (Object.keys(clean).length) log[date] = clean;
    }
    const s = obj.settings || {};
    const base = defaultState().settings;
    return {
      version: 1,
      habits,
      log,
      settings: {
        ...base,
        reminderTime: TIME_RE.test(s.reminderTime) ? s.reminderTime : base.reminderTime,
        notify: !!s.notify,
        lastNotified: DATE_RE.test(s.lastNotified) ? s.lastNotified : '',
        installHelpDismissed: !!s.installHelpDismissed,
      },
    };
  }

  return {
    dateKey, parseKey, addDays, todayKey, mondayOf, daysBetween,
    defaultHabits, defaultState, countFor, isDone, habitsOn, dayFraction, allDone,
    currentStreak, bestStreak, habitStats, overallStats,
    reminderPassed, buildIcs, sanitizeImport, EPOCH,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Logic;

// =================================================================
// UI (browser only)
// =================================================================
if (typeof document !== 'undefined') (() => {
  const L = Logic;
  const STORAGE_KEY = 'grace-habits-v1';
  const $ = (sel) => document.querySelector(sel);
  const main = $('#main');

  // ---------- State & storage ----------

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return L.sanitizeImport(JSON.parse(raw));
    } catch (e) {
      console.warn('Could not read saved data, starting fresh.', e);
    }
    return L.defaultState();
  }

  let state = load();

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("Hmm, couldn't save. Is storage full?");
    }
  }

  // Screen state (not saved).
  const ui = {
    tab: 'today',
    today: L.todayKey(),
    viewDate: L.todayKey(), // which day the Today tab is editing
    calMonth: L.todayKey().slice(0, 7), // "YYYY-MM" shown in the month calendar
  };

  // ---------- Small helpers ----------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function prettyDate(key, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
    return L.parseKey(key).toLocaleDateString(undefined, opts);
  }

  function prettyTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /** 0..4 colour level for the heat map. */
  function heatLevel(f) {
    if (f <= 0) return 0;
    if (f >= 1) return 4;
    return f < 0.34 ? 1 : f < 0.67 ? 2 : 3;
  }

  const isWaterish = (h) => /water|bottle|drink/i.test(h.name);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function doneCount(date) {
    return state.habits.filter((h) => L.isDone(state, date, h)).length;
  }

  function remainingToday() {
    return state.habits.length - doneCount(ui.today);
  }

  function setCount(date, habit, count) {
    const day = state.log[date] || (state.log[date] = {});
    if (count > 0) day[habit.id] = count;
    else delete day[habit.id];
    if (!Object.keys(day).length) delete state.log[date];
    // Logging a habit before it was "added" means it existed then; move the date back.
    if (count > 0 && habit.created > date) habit.created = date;
    save();
  }

  // ---------- Icons (inline SVG) ----------

  const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_BOTTLE = '<svg viewBox="0 0 24 40" aria-hidden="true"><path class="b-fill" d="M7 16h10v19a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/><path class="b-line" d="M9.5 2.5h5v5l3.5 4.5v23a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 35V12l3.5-4.5z"/></svg>';

  // ---------- Rendering ----------

  function render() {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === ui.tab)));
    if (ui.tab === 'today') main.innerHTML = renderToday();
    else if (ui.tab === 'progress') main.innerHTML = renderProgress();
    else main.innerHTML = renderSettings();
  }

  function progressRing(done, total) {
    const r = 34;
    const c = 2 * Math.PI * r;
    const frac = total ? done / total : 0;
    return `
      <div class="ring" role="img" aria-label="${done} of ${total} done">
        <svg viewBox="0 0 80 80">
          <circle class="ring-bg" cx="40" cy="40" r="${r}"/>
          <circle class="ring-fg" cx="40" cy="40" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - frac)}"/>
        </svg>
        <div class="ring-text"><strong>${done}</strong><span>of ${total}</span></div>
      </div>`;
  }

  function encouragement(done, total, isToday) {
    if (!total) return 'Add a habit in Settings to get started ✨';
    if (!isToday) return done === total ? 'A perfect day! 🌟' : 'Catching up? No problem, tap what you did.';
    if (done === total) return 'You did it ALL today! So proud of you 🎉';
    if (done === 0) return "Fresh day, fresh start. You've got this! 💪";
    const left = total - done;
    if (done / total >= 0.5) return `Amazing! Only ${left} to go ✨`;
    return `Nice start! ${left} more to go 🌸`;
  }

  function renderToday() {
    const date = ui.viewDate;
    const isToday = date === ui.today;
    const total = state.habits.length;
    const done = doneCount(date);
    const overall = L.overallStats(state, ui.today);

    // Reminder banner: reminder time has passed and there's still stuff to do.
    const showBanner = isToday && total && done < total && L.reminderPassed(state.settings.reminderTime);
    const showInstall = !state.settings.installHelpDismissed && !isStandalone();

    return `
      <header class="hero">
        <div>
          <p class="eyebrow">${isToday ? 'Today' : 'Editing a past day'}</p>
          <h1>${isToday ? 'Hi Grace! 🌸' : esc(prettyDate(date, { weekday: 'long', day: 'numeric', month: 'short' }))}</h1>
          <p class="sub">${isToday ? esc(prettyDate(date)) : ''}</p>
          <p class="cheer">${encouragement(done, total, isToday)}</p>
        </div>
        ${progressRing(done, total)}
      </header>

      ${!isToday ? `<button class="pill-btn back-today" data-action="go-today">← Back to today</button>` : ''}

      ${showBanner ? `
        <div class="banner" role="status">
          <span class="banner-emoji">⏰</span>
          <div><strong>Little reminder!</strong><br>${total - done} habit${total - done === 1 ? '' : 's'} left for today. A few minutes now = a happy streak tomorrow 💖</div>
        </div>` : ''}

      ${showInstall ? renderInstallCard() : ''}

      ${renderWeek(date, overall)}

      <section class="habits" aria-label="Habits">
        ${state.habits.map((h) => renderHabitCard(h, date)).join('')}
      </section>

      ${total && done === total ? `<div class="all-done">🏆 All ${total} done${isToday ? ' today' : ''}! You're a superstar.</div>` : ''}
    `;
  }

  function renderInstallCard() {
    return `
      <section class="card install">
        <button class="icon-btn close" data-action="dismiss-install" aria-label="Dismiss">✕</button>
        <h2>📲 Put me on your Home Screen</h2>
        <p>Then I open like a real app, even with no Wi-Fi!</p>
        <ol>
          <li>Open this page in <strong>Safari</strong>.</li>
          <li>Tap the <strong>Share</strong> button <span class="share-glyph" aria-hidden="true">⬆︎</span>
            <br><small>iPhone: bottom of the screen · iPad: top right</small></li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
          <li>Tap <strong>Add</strong>. Done! 🎉</li>
        </ol>
        <button class="pill-btn" data-action="dismiss-install">Got it</button>
      </section>`;
  }

  function renderWeek(selected, overall) {
    const mon = L.mondayOf(selected);
    const days = WEEKDAYS.map((name, i) => {
      const d = L.addDays(mon, i);
      const future = d > ui.today;
      const level = heatLevel(L.dayFraction(state, d));
      const cls = ['wday', `lvl${level}`, d === selected ? 'selected' : '', d === ui.today ? 'is-today' : '', future ? 'future' : ''].join(' ');
      return `
        <button class="${cls}" data-action="pick-day" data-date="${d}" ${future ? 'disabled' : ''}
          aria-label="${esc(prettyDate(d))}${level === 4 ? ', perfect day' : ''}">
          <span class="wname">${name[0]}</span>
          <span class="dot">${level === 4 ? '★' : ''}</span>
        </button>`;
    }).join('');
    const nextMon = L.addDays(mon, 7);
    return `
      <section class="card week">
        <div class="week-head">
          <button class="icon-btn" data-action="week" data-dir="-1" aria-label="Previous week">‹</button>
          <div class="streak-chip">🔥 <strong>${overall.current}</strong> perfect day${overall.current === 1 ? '' : 's'} in a row</div>
          <button class="icon-btn" data-action="week" data-dir="1" aria-label="Next week" ${nextMon > ui.today ? 'disabled' : ''}>›</button>
        </div>
        <div class="week-days">${days}</div>
      </section>`;
  }

  function renderHabitCard(h, date) {
    const count = L.countFor(state, date, h.id);
    const done = count >= h.target;
    const st = L.habitStats(state, h, ui.today);
    const meta = `🔥 ${st.current} day${st.current === 1 ? '' : 's'} · best ${st.best} · ${st.total}× total`;

    if (h.target === 1) {
      return `
        <button class="card habit ${done ? 'done' : ''}" data-action="toggle" data-id="${esc(h.id)}" aria-pressed="${done}">
          <span class="h-emoji" aria-hidden="true">${esc(h.emoji)}</span>
          <span class="h-text"><span class="h-name">${esc(h.name)}</span><span class="h-meta">${meta}</span></span>
          <span class="check">${ICON_CHECK}</span>
        </button>`;
    }

    // Counter habit (e.g. water bottles): tap the card to add one, or tap a specific pip.
    const pips = Array.from({ length: h.target }, (_, i) => `
      <button class="pip ${i < count ? 'full' : ''} ${isWaterish(h) ? 'bottle' : 'emoji-pip'}" data-action="pip" data-id="${esc(h.id)}" data-i="${i}"
        aria-label="${i + 1} of ${h.target}" aria-pressed="${i < count}">
        ${isWaterish(h) ? ICON_BOTTLE : `<span>${esc(h.emoji)}</span>`}
      </button>`).join('');
    return `
      <div class="card habit counter ${done ? 'done' : ''}">
        <button class="h-main" data-action="bump" data-id="${esc(h.id)}" aria-label="${esc(h.name)}: ${Math.min(count, h.target)} of ${h.target}. Tap to add one.">
          <span class="h-emoji" aria-hidden="true">${esc(h.emoji)}</span>
          <span class="h-text"><span class="h-name">${esc(h.name)}</span><span class="h-meta">${Math.min(count, h.target)}/${h.target} · ${meta}</span></span>
        </button>
        <div class="pips">${pips}</div>
      </div>`;
  }

  function renderProgress() {
    const overall = L.overallStats(state, ui.today);
    return `
      <header class="page-head"><h1>Your progress ✨</h1><p class="sub">Every tick counts. Look how far you've come!</p></header>

      <section class="tiles">
        <div class="tile"><span class="big">🔥 ${overall.current}</span><span>perfect-day streak</span></div>
        <div class="tile"><span class="big">🏅 ${overall.best}</span><span>best streak</span></div>
        <div class="tile"><span class="big">🌟 ${overall.perfectDays}</span><span>perfect days</span></div>
      </section>

      ${renderMonth()}

      <h2 class="section-title">Habits</h2>
      <section class="stats">
        ${state.habits.map((h) => {
          const st = L.habitStats(state, h, ui.today);
          return `
            <div class="card stat">
              <div class="stat-head"><span class="h-emoji" aria-hidden="true">${esc(h.emoji)}</span><span class="h-name">${esc(h.name)}</span></div>
              <div class="stat-nums">
                <div><strong>${st.current}</strong><span>streak</span></div>
                <div><strong>${st.best}</strong><span>best</span></div>
                <div><strong>${st.total}</strong><span>total</span></div>
              </div>
              <div class="bar-label"><span>Last 30 days</span><span>${st.pct30}%</span></div>
              <div class="bar" role="img" aria-label="${st.pct30}% in the last 30 days"><span style="width:${st.pct30}%"></span></div>
            </div>`;
        }).join('') || '<p class="sub">No habits yet. Add some in Settings!</p>'}
      </section>`;
  }

  function renderMonth() {
    const [y, m] = ui.calMonth.split('-').map(Number);
    const first = `${ui.calMonth}-01`;
    const daysInMonth = new Date(y, m, 0).getDate();
    const lead = (L.parseKey(first).getDay() + 6) % 7; // blanks before the 1st (Monday start)
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<span class="cday blank"></span>');
    for (let day = 1; day <= daysInMonth; day++) {
      const d = L.addDays(first, day - 1);
      const future = d > ui.today;
      const level = future ? 0 : heatLevel(L.dayFraction(state, d));
      cells.push(`
        <button class="cday lvl${level} ${d === ui.today ? 'is-today' : ''} ${future ? 'future' : ''}"
          data-action="pick-day" data-date="${d}" ${future ? 'disabled' : ''} aria-label="${esc(prettyDate(d))}">${day}</button>`);
    }
    const title = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const isCurrent = ui.calMonth >= ui.today.slice(0, 7);
    return `
      <section class="card month">
        <div class="week-head">
          <button class="icon-btn" data-action="month" data-dir="-1" aria-label="Previous month">‹</button>
          <h2>${esc(title)}</h2>
          <button class="icon-btn" data-action="month" data-dir="1" aria-label="Next month" ${isCurrent ? 'disabled' : ''}>›</button>
        </div>
        <div class="cal">
          ${WEEKDAYS.map((w) => `<span class="cname">${w[0]}</span>`).join('')}
          ${cells.join('')}
        </div>
        <div class="legend"><span>less</span>${[0, 1, 2, 3, 4].map((l) => `<i class="lvl${l}"></i>`).join('')}<span>all done</span></div>
        <p class="hint">Tap a day to see or change it.</p>
      </section>`;
  }

  function renderSettings() {
    const s = state.settings;
    const notifSupported = 'Notification' in window;
    const perm = notifSupported ? Notification.permission : 'unsupported';
    return `
      <header class="page-head"><h1>Settings ⚙️</h1><p class="sub">Make it yours!</p></header>

      <section class="card">
        <h2>My habits</h2>
        <p class="hint">Change the emoji or name, set how many times a day, and use the arrows to reorder.</p>
        <ul class="edit-list">
          ${state.habits.map((h, i) => `
            <li class="edit-row">
              <input class="emoji-input" data-field="emoji" data-id="${esc(h.id)}" value="${esc(h.emoji)}" aria-label="Emoji for ${esc(h.name)}">
              <input class="name-input" data-field="name" data-id="${esc(h.id)}" value="${esc(h.name)}" maxlength="60" aria-label="Habit name">
              <select data-field="target" data-id="${esc(h.id)}" aria-label="Times per day">
                ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === h.target ? 'selected' : ''}>${n}×</option>`).join('')}
              </select>
              <div class="row-btns">
                <button class="icon-btn" data-action="move" data-id="${esc(h.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
                <button class="icon-btn" data-action="move" data-id="${esc(h.id)}" data-dir="1" ${i === state.habits.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
                <button class="icon-btn danger" data-action="delete" data-id="${esc(h.id)}" aria-label="Delete ${esc(h.name)}">🗑</button>
              </div>
            </li>`).join('')}
        </ul>
        <button class="pill-btn" data-action="add-habit">＋ Add a habit</button>
      </section>

      <section class="card">
        <h2>Reminders ⏰</h2>
        <label class="field">
          <span>Reminder time</span>
          <input type="time" data-field="reminderTime" value="${esc(s.reminderTime)}">
        </label>
        <p class="hint">After ${esc(prettyTime(s.reminderTime))}, you'll see a friendly reminder in the app if anything's left to do.</p>

        <div class="honest">
          <strong>Heads up:</strong> websites can't reliably buzz your phone when they're closed.
          The <strong>calendar reminder</strong> is the one that will actually pop up every day. 📅
        </div>
        <button class="pill-btn primary" data-action="ics">📅 Add daily reminder to my calendar</button>
        <p class="hint">Downloads a calendar event that repeats every day at ${esc(prettyTime(s.reminderTime))}. Tap <em>Add All</em> when your phone asks. Works best from Safari. Changed the time? Delete the old event and add a new one.</p>

        <label class="toggle">
          <input type="checkbox" data-field="notify" ${s.notify && perm === 'granted' ? 'checked' : ''} ${notifSupported ? '' : 'disabled'}>
          <span class="switch" aria-hidden="true"></span>
          <span>App notifications <small>(bonus)</small></span>
        </label>
        <p class="hint">${notifSupported
          ? (perm === 'denied'
            ? 'Notifications are blocked. You can allow them in your phone Settings.'
            : "Only shows a notification when you <em>open</em> the app after reminder time and there's still stuff to do. Use the calendar reminder for a real daily nudge.")
          : 'On iPhone/iPad, notifications only work after you add this app to your Home Screen (and open it from there).'}</p>
      </section>

      <section class="card">
        <h2>Backup 💾</h2>
        <p class="hint">Your data lives only on this device. Save a backup now and then so you never lose your streaks!</p>
        <div class="btn-row">
          <button class="pill-btn" data-action="export">⬇️ Save backup</button>
          <button class="pill-btn" data-action="import">⬆️ Load backup</button>
          <input type="file" id="import-file" accept="application/json,.json" hidden>
        </div>
      </section>

      <section class="card">
        <h2>More</h2>
        <div class="btn-row">
          ${isStandalone() ? '' : '<button class="pill-btn" data-action="show-install">📲 Home Screen help</button>'}
          <button class="pill-btn danger" data-action="reset">Start over</button>
        </div>
      </section>
      <p class="footer">Made with 💖 for Grace</p>`;
  }

  // ---------- Celebrations ----------

  const COLORS = ['#f472b6', '#fb7185', '#f9a8d4', '#fcd34d', '#a5b4fc', '#86efac', '#ffffff'];
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Burst of confetti pieces from (x, y) in page coordinates. */
  function confetti(x, y, count = 18, spread = 120) {
    if (reduceMotion()) return;
    const layer = $('#fx');
    for (let i = 0; i < count; i++) {
      const p = document.createElement('i');
      const angle = Math.random() * Math.PI * 2;
      const dist = spread * (0.4 + Math.random() * 0.6);
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      p.style.background = COLORS[i % COLORS.length];
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist - 40}px`);
      p.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
      p.style.animationDelay = `${Math.random() * 80}ms`;
      if (i % 3 === 0) p.classList.add('round');
      layer.appendChild(p);
      p.addEventListener('animationend', () => p.remove());
    }
  }

  /** Big celebration when everything is done. */
  function bigCelebration() {
    const w = window.innerWidth;
    [0.2, 0.5, 0.8].forEach((fx, i) => setTimeout(() => confetti(w * fx, window.innerHeight * 0.3, 36, 220), i * 180));
    toast(['You did it ALL! 🎉', 'Superstar day! 🌟', 'Every single one! 💖'][Math.floor(Math.random() * 3)]);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /** Re-render, then celebrate if this change completed a habit / the whole day. */
  function afterChange(habit, wasDone, wasAllDone, originEl) {
    const rect = originEl ? originEl.getBoundingClientRect() : null;
    render();
    const date = ui.viewDate;
    const nowDone = L.isDone(state, date, habit);
    const nowAllDone = state.habits.length > 0 && doneCount(date) === state.habits.length;
    if (nowDone && !wasDone) {
      if (rect) confetti(rect.left + rect.width - 40, rect.top + rect.height / 2);
      // Tiny buzz on Android (iOS ignores it). Only after a real tap, or Chrome logs an error.
      if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(15);
    }
    if (nowAllDone && !wasAllDone) bigCelebration();
    // Pop animation on the card we just touched.
    const card = main.querySelector(`[data-id="${CSS.escape(habit.id)}"]`);
    const target = card && (card.closest('.habit') || card);
    if (target && nowDone && !wasDone) target.classList.add('pop');
  }

  // ---------- Actions ----------

  function habitById(id) {
    return state.habits.find((h) => h.id === id);
  }

  function changeCount(habit, newCount, el) {
    const date = ui.viewDate;
    const wasDone = L.isDone(state, date, habit);
    const wasAllDone = doneCount(date) === state.habits.length;
    setCount(date, habit, newCount);
    afterChange(habit, wasDone, wasAllDone, el);
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const actions = {
    toggle(el) {
      const h = habitById(el.dataset.id);
      changeCount(h, L.isDone(state, ui.viewDate, h) ? 0 : 1, el);
    },
    bump(el) {
      // Counter: +1 each tap; after the goal, wrap back to 0 (an easy "undo").
      const h = habitById(el.dataset.id);
      const c = Math.min(L.countFor(state, ui.viewDate, h.id), h.target);
      changeCount(h, c >= h.target ? 0 : c + 1, el);
    },
    pip(el) {
      // Tap pip #i to fill up to it; tap the last filled one again to empty it.
      const h = habitById(el.dataset.id);
      const i = Number(el.dataset.i);
      const c = Math.min(L.countFor(state, ui.viewDate, h.id), h.target);
      changeCount(h, c === i + 1 ? i : i + 1, el);
    },
    'pick-day'(el) {
      ui.viewDate = el.dataset.date;
      ui.tab = 'today';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    'go-today'() {
      ui.viewDate = ui.today;
      render();
    },
    week(el) {
      const d = L.addDays(ui.viewDate, 7 * Number(el.dataset.dir));
      ui.viewDate = d > ui.today ? ui.today : d;
      render();
    },
    month(el) {
      const [y, m] = ui.calMonth.split('-').map(Number);
      ui.calMonth = L.dateKey(new Date(y, m - 1 + Number(el.dataset.dir), 1)).slice(0, 7);
      render();
    },
    'dismiss-install'() {
      state.settings.installHelpDismissed = true;
      save();
      render();
    },
    'show-install'() {
      state.settings.installHelpDismissed = false;
      save();
      ui.tab = 'today';
      ui.viewDate = ui.today;
      render();
      window.scrollTo({ top: 0 });
    },
    move(el) {
      const i = state.habits.findIndex((h) => h.id === el.dataset.id);
      const j = i + Number(el.dataset.dir);
      if (j < 0 || j >= state.habits.length) return;
      [state.habits[i], state.habits[j]] = [state.habits[j], state.habits[i]];
      save();
      render();
    },
    delete(el) {
      const h = habitById(el.dataset.id);
      if (!confirm(`Delete "${h.name}"? Its history will be removed too.`)) return;
      state.habits = state.habits.filter((x) => x !== h);
      for (const [date, day] of Object.entries(state.log)) {
        delete day[h.id];
        if (!Object.keys(day).length) delete state.log[date];
      }
      save();
      render();
      toast('Habit deleted');
    },
    'add-habit'() {
      const id = 'h' + Date.now().toString(36);
      state.habits.push({ id, name: 'New habit', emoji: '⭐', target: 1, created: ui.today });
      save();
      render();
      const input = main.querySelector(`.name-input[data-id="${id}"]`);
      if (input) { input.focus(); input.select(); }
    },
    ics() {
      download('grace-habit-reminder.ics', L.buildIcs(state.settings.reminderTime), 'text/calendar;charset=utf-8');
      toast('Calendar reminder downloaded 📅');
    },
    export() {
      const data = JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
      download(`grace-habits-backup-${ui.today}.json`, data, 'application/json');
      toast('Backup saved 💾');
    },
    import() {
      $('#import-file').click();
    },
    reset() {
      if (!confirm('Start over? This deletes ALL your ticks, streaks and custom habits on this device. (Tip: save a backup first!)')) return;
      const keepInstall = state.settings.installHelpDismissed;
      state = L.defaultState();
      state.settings.installHelpDismissed = keepInstall;
      save();
      ui.viewDate = ui.today;
      render();
      toast('All fresh! 🌱');
    },
  };

  // One click handler for everything (event delegation).
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) {
      ui.tab = tab.dataset.tab;
      if (ui.tab === 'today') ui.viewDate = ui.today;
      render();
      window.scrollTo({ top: 0 });
      return;
    }
    const el = e.target.closest('[data-action]');
    if (el && !el.disabled && actions[el.dataset.action]) actions[el.dataset.action](el);
  });

  // Settings fields: save on "change" (after typing finishes) so inputs keep focus.
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.id === 'import-file') return importFile(el);
    const field = el.dataset.field;
    if (!field) return;
    if (field === 'reminderTime') {
      if (el.value) state.settings.reminderTime = el.value;
      save();
      render();
      return;
    }
    if (field === 'notify') {
      await setNotify(el.checked);
      render();
      return;
    }
    const h = habitById(el.dataset.id);
    if (!h) return;
    if (field === 'name') h.name = el.value.trim().slice(0, 60) || h.name;
    if (field === 'emoji') h.emoji = el.value.trim().slice(0, 8) || '⭐';
    if (field === 'target') h.target = Number(el.value);
    el.value = field === 'target' ? h.target : h[field];
    save();
  });

  async function importFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const imported = L.sanitizeImport(JSON.parse(await file.text()));
      if (!confirm(`Load this backup? It has ${imported.habits.length} habits and ${Object.keys(imported.log).length} days. It will replace what's on this device now.`)) return;
      state = imported;
      save();
      ui.viewDate = ui.today;
      render();
      toast('Backup loaded! 🎉');
    } catch (err) {
      alert(err instanceof SyntaxError ? "Oops, that file isn't a valid backup." : err.message);
    }
  }

  // ---------- Notifications (best effort) ----------

  async function setNotify(on) {
    if (!on) {
      state.settings.notify = false;
      save();
      return;
    }
    if (!('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    state.settings.notify = perm === 'granted';
    save();
    toast(perm === 'granted' ? 'Notifications on 🔔' : 'No problem! The calendar reminder works great too.');
  }

  /** If it's past reminder time and stuff is left, show one notification per day. */
  async function maybeNotify() {
    const s = state.settings;
    if (!s.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    const left = remainingToday();
    if (!left || !L.reminderPassed(s.reminderTime) || s.lastNotified === ui.today) return;
    s.lastNotified = ui.today;
    save();
    const title = 'Habit check-in 🌸';
    const opts = { body: `${left} habit${left === 1 ? '' : 's'} left today. You've got this!`, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'daily-reminder' };
    try {
      const reg = 'serviceWorker' in navigator && (await navigator.serviceWorker.getRegistration());
      if (reg) await reg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch (e) {
      console.warn('Notification failed', e);
    }
  }

  // ---------- Keeping "today" fresh ----------

  /** Runs every minute and when the app comes back to the screen. */
  function tick() {
    const now = L.todayKey();
    if (now !== ui.today) {
      // Midnight passed: if we were looking at "today", follow it to the new day.
      if (ui.viewDate === ui.today) ui.viewDate = now;
      ui.today = now;
      render();
    } else if (ui.tab === 'today') {
      // Show/hide the reminder banner as the time passes (only if it changed).
      const hasBanner = !!main.querySelector('.banner');
      const wantBanner = ui.viewDate === ui.today && remainingToday() > 0 && L.reminderPassed(state.settings.reminderTime);
      if (hasBanner !== wantBanner) render();
    }
    maybeNotify();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
  setInterval(tick, 60 * 1000);

  // ---------- Start ----------

  render();
  maybeNotify();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
  }
  // Ask the browser not to clear our data when storage is low.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
