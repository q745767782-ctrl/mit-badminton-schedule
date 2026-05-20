import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
const sourceUrl = "https://www.bu.edu/fitrec/visit-us/hours/";
const outputPath = join(rootDir, "bu-schedule.json");
const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&#8211;|&ndash;/g, "-")
    .replace(/&#8212;|&mdash;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&");
}

function htmlToLines(html) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(h\d|li|div|span|p|time|ul|section)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractThreeCourtGymSection(html) {
  const start = html.indexOf("3-Court Gym Hours");
  const end = html.indexOf("4-Court Gym Hours", start);

  if (start === -1 || end === -1) {
    throw new Error("Could not find BU 3-Court Gym Hours section.");
  }

  return html.slice(start, end);
}

function parseDateRange(lines) {
  const rangeLine = lines.find((line) =>
    /^[A-Z][a-z]+ \d{2}, \d{4} - [A-Z][a-z]+ \d{2}, \d{4}$/.test(line),
  );

  if (!rangeLine) {
    throw new Error("Could not find BU effective date range.");
  }

  const [startText, endText] = rangeLine.split(" - ");
  return {
    start: toDateKey(startText),
    end: toDateKey(endText),
    text: rangeLine,
  };
}

function toDateKey(dateText, fallbackYear = null) {
  const year = /\d{4}/.test(dateText) ? "" : `, ${fallbackYear}`;
  const parsed = new Date(`${dateText}${year} 12:00:00 GMT-0400`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0"),
  ].join("-");
}

function bostonDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
  };
}

function addDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function dateKeyFromParts(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dayNameFromDateKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00-04:00`);
  return dayNames[date.getDay()];
}

function normalizeTime(start, end) {
  return `${start} - ${end}`.replace(/\s+/g, " ").trim();
}

function parseWeeklyBadminton(lines) {
  const schedulesIndex = lines.indexOf("Schedules");
  const closuresIndex = lines.indexOf("Holidays & Closures");

  if (schedulesIndex === -1 || closuresIndex === -1) {
    throw new Error("Could not find BU schedule or closures block.");
  }

  const rows = [];
  let currentDay = null;

  for (let index = schedulesIndex + 1; index < closuresIndex; index += 1) {
    const line = lines[index];

    if (dayNames.includes(line)) {
      currentDay = line;
      continue;
    }

    if (!currentDay || !/^\d{1,2}(?::\d{2})? (AM|PM)$/i.test(line)) {
      continue;
    }

    const separator = lines[index + 1];
    const end = lines[index + 2];
    const title = lines[index + 3];

    if (separator !== "-" || !end || !/badminton/i.test(title || "")) {
      continue;
    }

    rows.push({
      dayName: currentDay,
      time: normalizeTime(line, end),
      title,
    });
  }

  return rows;
}

function parseClosureDates(lines, year) {
  const closuresIndex = lines.indexOf("Holidays & Closures");
  const closures = new Map();

  if (closuresIndex === -1) {
    return closures;
  }

  for (let index = closuresIndex + 1; index < lines.length; index += 2) {
    const dateLine = lines[index];
    const title = lines[index + 1] || "";

    if (!/^[A-Z][a-z]+, [A-Z][a-z]+ \d{2}$/.test(dateLine)) {
      continue;
    }

    const dateKey = toDateKey(dateLine.replace(/^[A-Z][a-z]+, /, ""), year);

    if (dateKey) {
      closures.set(dateKey, title);
    }
  }

  return closures;
}

function expandSchedule(weeklyRows, closures, range) {
  const start = bostonDateParts();
  const rows = [];

  for (let offset = 0; offset <= 14; offset += 1) {
    const date = dateKeyFromParts(addDays(start, offset));

    if (date < range.start || date > range.end) {
      continue;
    }

    const closure = closures.get(date);
    const dayName = dayNameFromDateKey(date);
    const weekly = weeklyRows.filter((row) => row.dayName === dayName);

    weekly.forEach((row) => {
      if (/no open rec badminton|closed/i.test(closure || "")) {
        return;
      }

      rows.push({
        date,
        time: row.time,
        court: "BU FitRec 3-Court Gym",
        type: "dedicated",
        sourceText: `${row.dayName} ${row.time} ${row.title}`,
      });
    });
  }

  return groupRows(rows);
}

function groupRows(rows) {
  const rowsByDate = new Map();

  rows.forEach((row) => {
    if (!rowsByDate.has(row.date)) {
      rowsByDate.set(row.date, []);
    }

    rowsByDate.get(row.date).push({
      time: row.time,
      court: row.court,
      type: row.type,
      sourceText: row.sourceText,
    });
  });

  return [...rowsByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sessions]) => ({
      date,
      sessions,
    }));
}

async function main() {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": "bu-badminton-schedule/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch BU FitRec Hours: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const section = extractThreeCourtGymSection(html);
  const lines = htmlToLines(section);
  const range = parseDateRange(lines);
  const year = Number(range.start.slice(0, 4));
  const weeklyRows = parseWeeklyBadminton(lines);
  const closures = parseClosureDates(lines, year);
  const schedule = expandSchedule(weeklyRows, closures, range);

  if (schedule.length === 0) {
    throw new Error("No BU badminton rows found in the schedule source.");
  }

  const payload = {
    source: sourceUrl,
    generatedAt: new Date().toISOString(),
    effectiveRange: range.text,
    schedule,
  };

  await mkdir(rootDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  const sessionCount = schedule.reduce((sum, day) => sum + day.sessions.length, 0);
  console.log(`Wrote ${sessionCount} BU badminton sessions to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
