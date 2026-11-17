// Small shared helpers with no browser-only dependencies, so tests can import them.

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback for old browsers without randomUUID; ids only need to be unique on one device.
  return (
    "id-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

// Local calendar date as YYYY-MM-DD. We store dates, not timestamps, for "met" and "last seen"
// because "which day" is what matters at the counter, and it avoids time-zone drift.
export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isISODate(s) {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s))
  );
}

// Escape text for safe insertion into HTML. Every user-entered value goes through this.
export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function daysBetween(a, b) {
  // Parse as UTC midnight so daylight-saving changes cannot produce 0.96-day gaps.
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000,
  );
}

export function formatDate(iso) {
  if (!isISODate(iso)) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// "today", "yesterday", "5 days ago", "3 weeks ago", else "Mar 4, 2026".
export function relativeDate(iso, today = todayISO()) {
  if (!isISODate(iso)) return "";
  const n = daysBetween(iso, today);
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  if (n > 1 && n < 14) return `${n} days ago`;
  if (n >= 14 && n < 60) return `${Math.floor(n / 7)} weeks ago`;
  return formatDate(iso);
}

// Lowercase and strip accents so "Renée" matches "renee".
export function fold(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
