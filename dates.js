// dates.js — shared date helpers; single source of truth for all date conversion and arithmetic

// Accepts a JS Date (SheetJS cellDates:true), a DD/MM/YYYY string, or a YYYY-MM-DD string.
// Returns YYYY-MM-DD, or null if absent/unparseable.
// Never uses Date.toString() or toISOString() — timezone offsets can shift the date.
function toISODate(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'string') {
    const parts = val.split('/');
    if (parts.length === 3) {
      // Interpret as DD/MM/YYYY — do not pass to new Date() (treats as MM/DD/YYYY)
      const [dd, mm, yyyy] = parts;
      return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
    return val; // assume already YYYY-MM-DD
  }
  return null;
}

// Takes a YYYY-MM-DD string and returns a timezone-safe JS Date.
// Returns null for absent input.
function toJsDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Calendar days between two YYYY-MM-DD strings (b - a).
// Uses Date.UTC to avoid timezone shifts.
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000;
}

// Takes a YYYY-MM-DD string and a date-fns format string, returns a formatted display string.
// Timezone-safe via local-Date construction.
function formatDate(iso, formatStr) {
  const [y, m, d] = iso.split('-').map(Number);
  return dateFns.format(new Date(y, m - 1, d), formatStr);
}

// Returns ISO week label for a YYYY-MM-DD string, e.g. "W03".
// Monday is the first day of the ISO week.
function isoWeekLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return dateFns.format(new Date(y, m - 1, d), "'W'II");
}

// Returns weekday name for a YYYY-MM-DD string.
// length: 'full' → 'Monday', 'short' → 'Mon', 'letter' → 'M'
function weekdayName(iso, length) {
  const [y, m, d] = iso.split('-').map(Number);
  const fmt = length === 'full' ? 'EEEE' : length === 'short' ? 'EEE' : 'EEEEE';
  return dateFns.format(new Date(y, m - 1, d), fmt);
}
