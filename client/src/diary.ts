// Diary entries: the note "diary-YYYY-MM-DD" holds what was written that day
// (see server/src/note.ts). Dates are the device's local dates.

const DIARY_ID = /^diary-(\d{4}-\d{2}-\d{2})$/;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function diaryId(date: string): string {
  return `diary-${date}`;
}

// The date of a diary entry's id, or null for an ordinary note.
export function diaryDate(id: string): string | null {
  return DIARY_ID.exec(id)?.[1] ?? null;
}

export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function today(): string {
  return isoDate(new Date());
}

function parse(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// "2024年1月2日（火）"
export function formatDiaryDate(date: string): string {
  const d = parse(date);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
}

export interface Month {
  year: number;
  month: number; // 1-12
}

export function monthOf(date: string): Month {
  const d = parse(date);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function addMonths(m: Month, delta: number): Month {
  const d = new Date(m.year, m.month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function inMonth(date: string, m: Month): boolean {
  return date.startsWith(`${m.year}-${String(m.month).padStart(2, "0")}-`);
}

export interface CalendarOptions {
  month: Month;
  selected: string | null;
  written: Set<string>;
  onPick: (date: string) => void;
  onMonth: (month: Month) => void;
}

// A month grid starting on Sunday. Days with an entry carry a dot.
export function renderCalendar(box: HTMLElement, o: CalendarOptions): void {
  const head = document.createElement("div");
  head.className = "cal-head";
  const prev = button("‹", "前の月", () => o.onMonth(addMonths(o.month, -1)));
  const next = button("›", "次の月", () => o.onMonth(addMonths(o.month, 1)));
  const title = document.createElement("span");
  title.className = "cal-title";
  title.textContent = `${o.month.year}年${o.month.month}月`;
  head.append(prev, title, next);

  const grid = document.createElement("div");
  grid.className = "cal-grid";
  WEEKDAYS.forEach((w, i) => {
    const cell = document.createElement("span");
    cell.className = "cal-weekday" + (i === 0 ? " sun" : i === 6 ? " sat" : "");
    cell.textContent = w;
    grid.append(cell);
  });
  const first = new Date(o.month.year, o.month.month - 1, 1);
  for (let i = 0; i < first.getDay(); i++) grid.append(document.createElement("span"));
  const days = new Date(o.month.year, o.month.month, 0).getDate();
  const todayDate = today();
  for (let day = 1; day <= days; day++) {
    const date = isoDate(new Date(o.month.year, o.month.month - 1, day));
    const weekday = (first.getDay() + day - 1) % 7;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.textContent = String(day);
    cell.title = formatDiaryDate(date);
    cell.className = [
      "cal-day",
      weekday === 0 ? "sun" : weekday === 6 ? "sat" : "",
      date === todayDate ? "today" : "",
      date === o.selected ? "selected" : "",
      o.written.has(date) ? "written" : "",
    ]
      .filter(Boolean)
      .join(" ");
    cell.onclick = () => o.onPick(date);
    grid.append(cell);
  }
  box.replaceChildren(head, grid);
}

function button(label: string, title: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.onclick = onclick;
  return b;
}
