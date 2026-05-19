import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
const mazevoUrl = "https://east.mymazevo.com/api/PublicCalendar/GetEvents";
const mazevoCalendarBaseUrl = "https://east.mymazevo.com/calendar";
const mitOpenRecCalendarCode =
  "RXphMEplcUJrNXhtelI0WitsVXJMK1Q5YmpWaTlJQkprZmYwVVhsOW94cm92aDJGcWNFYklMUzNtZ1h5Qmg2UnMwS2tCU0dBa1ZlMEZ0azNmbHptdUdYbGgvZW90MXExVWR2dXVJN1ovK3BoQm9uR0pndkpuMmU1bnp1bm5CcmM";
const pdfUrl = "https://www.mitrecsports.com/assets/Open-Rec-Schedule.pdf";
const outputPath = join(rootDir, "schedule.json");

const courtNames = {
  "ROCKWELL NORTH CT": "Rockwell North Court",
  "ROCKWELL SOUTH CT": "Rockwell South Court",
  "DU PONT CT1": "du Pont Court 1",
  "DU PONT CT2": "du Pont Court 2",
  "MAIN COURT": "Rockwell Main Court",
};

const dedicatedPatterns = [
  /Open Rec - Badminton/i,
  /Badminton/i,
];

function installPdfjsPolyfills() {
  if (!globalThis.DOMMatrix) {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(transform = [1, 0, 0, 1, 0, 0]) {
        const [a, b, c, d, e, f] = Array.isArray(transform) ? transform : [1, 0, 0, 1, 0, 0];
        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.e = e;
        this.f = f;
      }

      multiply() {
        return this;
      }

      translate() {
        return this;
      }

      scale() {
        return this;
      }
    };
  }

  if (!globalThis.ImageData) {
    globalThis.ImageData = class ImageData {};
  }

  if (!globalThis.Path2D) {
    globalThis.Path2D = class Path2D {};
  }
}

function getPdfjsImportPath() {
  if (process.env.PDFJS_DIST_PATH) {
    return process.env.PDFJS_DIST_PATH;
  }

  return "pdfjs-dist/legacy/build/pdf.mjs";
}

function getPlaywrightImportPath() {
  if (process.env.PLAYWRIGHT_IMPORT_PATH) {
    return process.env.PLAYWRIGHT_IMPORT_PATH;
  }

  return "playwright";
}

function toIsoDate(dateText) {
  const parsed = new Date(`${dateText} 12:00:00 GMT-0400`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeCourt(rawLocation) {
  const normalized = rawLocation.replace(/\s+/g, " ").trim().toUpperCase();

  for (const [needle, label] of Object.entries(courtNames)) {
    if (normalized.includes(needle)) {
      return label;
    }
  }

  return rawLocation
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bCT\b/g, "Court")
    .replace(/\bDU PONT\b/i, "du Pont")
    .replace(/\bROCKWELL\b/i, "Rockwell");
}

function normalizeTime(time) {
  return time.replace(/^0/, "");
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

function mazevoTimestamp(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T00:00:00.000Z`;
}

function dateKeyFromParts(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function isSharedMazevoSession(booking) {
  if (booking.eventName?.trim() !== "Open Rec") {
    return false;
  }

  if (booking.buildingDescription === "du Pont (W31/32)") {
    return ["Du Pont Court 1", "Du Pont Court 2"].includes(booking.roomDescription);
  }

  if (booking.buildingDescription === "Rockwell (W33)") {
    return ["North Court", "South Court"].includes(booking.roomDescription);
  }

  return false;
}

function isoDateFromMazevo(value) {
  return value.slice(0, 10);
}

function timeFromMazevo(value) {
  const date = new Date(value);

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(date);
}

function courtFromMazevo(booking) {
  if (booking.buildingDescription === "du Pont (W31/32)") {
    return booking.roomDescription;
  }

  if (booking.buildingDescription === "Rockwell (W33)") {
    return `Rockwell ${booking.roomDescription.replace("Court", "Court")}`;
  }

  return `${booking.buildingDescription} ${booking.roomDescription}`;
}

function normalizeMazevoCalendarCourt(location) {
  const cleaned = location.replace(/\s+/g, " ").trim();

  if (/du Pont \(W31\/32\) - Du Pont Court 1/i.test(cleaned)) {
    return "du Pont Court 1";
  }

  if (/du Pont \(W31\/32\) - Du Pont Court 2/i.test(cleaned)) {
    return "du Pont Court 2";
  }

  if (/Rockwell \(W33\) - North Court/i.test(cleaned)) {
    return "Rockwell North Court";
  }

  if (/Rockwell \(W33\) - South Court/i.test(cleaned)) {
    return "Rockwell South Court";
  }

  return cleaned
    .replace(/^du Pont \(W31\/32\) - /i, "du Pont ")
    .replace(/^Rockwell \(W33\) - /i, "Rockwell ")
    .replace(/\bDu Pont\b/g, "du Pont");
}

function isBadmintonCapableCalendarLocation(location) {
  return (
    /du Pont \(W31\/32\) - Du Pont Court [12]/i.test(location) ||
    /Rockwell \(W33\) - (North|South) Court/i.test(location)
  );
}

function toIsoDateFromMazevoCalendar(dateText) {
  const parsed = new Date(`${dateText} 12:00:00 GMT-0400`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeMazevoCalendarTime(timeText) {
  return timeText.replace(/\s*-\s*/, " - ").replace(/\s+/g, " ").trim();
}

function parseMazevoCalendarText(text, includeSharedSessions = true) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let currentDate = null;
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}$/.test(line)) {
      currentDate = toIsoDateFromMazevoCalendar(line);
      continue;
    }

    if (!currentDate || !/^\d{1,2}:\d{2}\s+[AP]M\s*-\s*\d{1,2}:\d{2}\s+[AP]M$/i.test(line)) {
      continue;
    }

    const location = lines[index + 1] || "";
    const eventName = lines[index + 2] || "";
    const isBadminton = /badminton/i.test(eventName);
    const isShared =
      includeSharedSessions &&
      eventName.trim() === "Open Rec" &&
      isBadmintonCapableCalendarLocation(location);

    if (!isBadminton && !isShared) {
      continue;
    }

    rows.push({
      date: currentDate,
      time: normalizeMazevoCalendarTime(line),
      court: normalizeMazevoCalendarCourt(location),
      type: isShared ? "shared" : "dedicated",
      sourceText: `${line} ${location} ${eventName}`,
    });
  }

  return groupRows(rows);
}

function filterScheduleWindow(schedule) {
  const start = dateKeyFromParts(bostonDateParts());
  const end = dateKeyFromParts(addDays(bostonDateParts(), 7));

  return schedule.filter((day) => day.date >= start && day.date <= end);
}

async function fetchMazevoCalendarSchedule() {
  const calendarCode = process.env.MAZEVO_CALENDAR_CODE || mitOpenRecCalendarCode;
  const calendarUrl = `${mazevoCalendarBaseUrl}?code=${encodeURIComponent(calendarCode)}`;
  const { chromium } = await import(getPlaywrightImportPath());
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(calendarUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      () => /Results Found|No Results Found|Showing Events through/i.test(document.body.innerText),
      undefined,
      { timeout: 60000 },
    );
    await page.waitForTimeout(1500);
    const weekTab = page.getByText("WEEK", { exact: true });

    if ((await weekTab.count()) > 0) {
      await weekTab.first().click();
      await page.waitForTimeout(1500);
    }

    const currentWeekText = await page.locator("body").innerText({ timeout: 10000 });
    const nextWeekButton = page.getByLabel("Move to Next Week");
    let nextWeekText = "";

    if ((await nextWeekButton.count()) > 0) {
      await nextWeekButton.first().click();
      await page.waitForTimeout(1500);
      nextWeekText = await page.locator("body").innerText({ timeout: 10000 });
    }

    const schedule = filterScheduleWindow(
      parseMazevoCalendarText(
        `${currentWeekText}\n${nextWeekText}`,
        process.env.INCLUDE_SHARED_SESSIONS !== "0",
      ),
    );

    return {
      schedule,
      source: calendarUrl,
    };
  } finally {
    await browser.close();
  }
}

async function fetchMazevoBookings() {
  if (!process.env.MAZEVO_API_KEY) {
    throw new Error("MAZEVO_API_KEY is required for live Mazevo updates.");
  }

  const start = bostonDateParts();
  const end = addDays(start, 7);
  const payload = {
    start: mazevoTimestamp(start),
    end: mazevoTimestamp(end),
    buildingIds: null,
    roomTags: ["OPEN REC "],
    eventTypeIds: [87],
    statusIds: [1],
    organizationIds: null,
    organizationTypeIds: null,
    hideSpecialDates: false,
    userOffsetMinutes: 240,
    startDay: start.day,
    startMonth: start.month - 1,
    startYear: start.year,
    endDay: end.day,
    endMonth: end.month - 1,
    endYear: end.year,
    apiKey: process.env.MAZEVO_API_KEY,
  };

  const response = await fetch(mazevoUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "mit-badminton-schedule/1.0",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Mazevo API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.bookings || [];
}

function parseMazevoSchedule(bookings) {
  const rows = [];

  bookings.forEach((booking) => {
    const isBadminton = booking.eventName?.toLowerCase().includes("badminton");
    const isShared = !isBadminton && isSharedMazevoSession(booking);

    if (!isBadminton && !isShared) {
      return;
    }

    rows.push({
      date: isoDateFromMazevo(booking.dateTimeStart),
      time: `${timeFromMazevo(booking.dateTimeStart)} - ${timeFromMazevo(booking.dateTimeEnd)}`,
      court: courtFromMazevo(booking),
      type: isShared ? "shared" : "dedicated",
      sourceText: `${booking.eventName} ${booking.buildingDescription} ${booking.roomDescription}`,
    });
  });

  return groupRows(rows);
}

function parseLine(line, currentDate) {
  const match = line.match(
    /^(\d{1,2}:\d{2}\s+[AP]M)\s+(\d{1,2}:\d{2}\s+[AP]M)\s+DAPER\s+(.+)$/i,
  );

  if (!match || !currentDate) {
    return null;
  }

  const [, start, end, rest] = match;
  const isBadminton = dedicatedPatterns.some((pattern) => pattern.test(rest));
  const isSharedCourt =
    /Rockwell\s+(NORTH|SOUTH)\s+CT/i.test(rest) ||
    /du Pont\s+DU PONT CT[12]/i.test(rest);

  if (!isBadminton && !isSharedCourt) {
    return null;
  }

  const location = rest
    .replace(/^Open Rec\s+-\s+Badminton\s+/i, "")
    .replace(/^Open Rec\s+/i, "")
    .replace(/^Rockwell\s+/i, "Rockwell ")
    .replace(/^du Pont\s+/i, "du Pont ")
    .trim();

  return {
    date: currentDate,
    time: `${normalizeTime(start)} - ${normalizeTime(end)}`,
    court: normalizeCourt(location),
    type: isBadminton ? "dedicated" : "shared",
    sourceText: line,
  };
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

async function fetchPdf() {
  const response = await fetch(pdfUrl, {
    headers: {
      "user-agent": "mit-badminton-schedule/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch schedule PDF: ${response.status} ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function itemLines(items) {
  const grouped = new Map();

  items.forEach((item) => {
    const y = Math.round(item.transform[5]);
    const x = item.transform[4];
    const key = String(y);

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push({ x, text: item.str });
  });

  return [...grouped.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([, parts]) =>
      parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

async function extractText(pdfBytes) {
  installPdfjsPolyfills();
  const pdfjs = await import(getPdfjsImportPath());
  const doc = await pdfjs.getDocument({
    data: pdfBytes,
    disableWorker: true,
    useSystemFonts: true,
  }).promise;
  const lines = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    lines.push(...itemLines(textContent.items));
  }

  return lines;
}

function parseSchedule(lines) {
  let currentDate = null;
  const rows = [];

  lines.forEach((line) => {
    const dateMatch = line.match(
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}$/i,
    );

    if (dateMatch) {
      currentDate = toIsoDate(line);
      return;
    }

    const row = parseLine(line, currentDate);

    if (row) {
      rows.push(row);
    }
  });

  return groupRows(rows);
}

async function main() {
  let source = mazevoCalendarBaseUrl;
  let schedule;

  try {
    const result = await fetchMazevoCalendarSchedule();
    source = result.source;
    schedule = result.schedule;
  } catch (error) {
    if (!process.env.MAZEVO_API_KEY) {
      throw error;
    }

    console.warn(`${error.message} Falling back to the Mazevo events API.`);
    const bookings = await fetchMazevoBookings();
    source = mazevoUrl;
    schedule = parseMazevoSchedule(bookings);
  }

  if (schedule.length === 0) {
    throw new Error("No badminton rows found in the schedule source.");
  }

  const payload = {
    source,
    generatedAt: new Date().toISOString(),
    schedule,
  };

  await mkdir(rootDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  const sessionCount = schedule.reduce((sum, day) => sum + day.sessions.length, 0);
  console.log(`Wrote ${sessionCount} badminton sessions to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
