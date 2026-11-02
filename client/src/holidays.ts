// Japanese national holidays, for the diary's calendar. Computed on the
// device from the rules of the holiday law, so the calendar works offline.
// core/src/holiday.rs implements the same rules for the native apps; keep the
// two in step. Both are tested against core/tests/holidays.json.
//
// Covers 1980-2099: the equinox formula holds for those years.

// 0 for Sunday.
function weekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// The day of the month of the nth Monday.
function nthMonday(y: number, m: number, n: number): number {
  return 1 + ((8 - weekday(y, m, 1)) % 7) + (n - 1) * 7;
}

const vernalEquinox = (y: number) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnalEquinox = (y: number) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

// The holidays named in the law, without substitute and citizens' holidays.
function namedHoliday(y: number, m: number, d: number): string | null {
  const olympics = y === 2020 || y === 2021;
  switch (m) {
    case 1:
      if (d === 1) return "元日";
      if (y >= 2000 ? d === nthMonday(y, 1, 2) : d === 15) return "成人の日";
      return null;
    case 2:
      if (d === 11) return "建国記念の日";
      if (d === 23 && y >= 2020) return "天皇誕生日";
      if (d === 24 && y === 1989) return "昭和天皇の大喪の礼";
      return null;
    case 3:
      return d === vernalEquinox(y) ? "春分の日" : null;
    case 4:
      if (d === 29) return y >= 2007 ? "昭和の日" : y >= 1989 ? "みどりの日" : "天皇誕生日";
      return null;
    case 5:
      if (d === 1 && y === 2019) return "天皇の即位の日";
      if (d === 3) return "憲法記念日";
      if (d === 4 && y >= 2007) return "みどりの日";
      if (d === 5) return "こどもの日";
      return null;
    case 6:
      return d === 9 && y === 1993 ? "皇太子徳仁親王の結婚の儀" : null;
    case 7:
      if (d === 20 && y >= 1996 && y <= 2002) return "海の日";
      if ((y === 2020 && d === 23) || (y === 2021 && d === 22)) return "海の日";
      if (y >= 2003 && !olympics && d === nthMonday(y, 7, 3)) return "海の日";
      if ((y === 2020 && d === 24) || (y === 2021 && d === 23)) return "スポーツの日";
      return null;
    case 8:
      if ((y === 2020 && d === 10) || (y === 2021 && d === 8)) return "山の日";
      if (d === 11 && y >= 2016 && !olympics) return "山の日";
      return null;
    case 9:
      if (y < 2003 ? d === 15 : d === nthMonday(y, 9, 3)) return "敬老の日";
      if (d === autumnalEquinox(y)) return "秋分の日";
      return null;
    case 10:
      if (d === 10 && y < 2000) return "体育の日";
      if (y >= 2000 && !olympics && d === nthMonday(y, 10, 2)) return y >= 2020 ? "スポーツの日" : "体育の日";
      if (d === 22 && y === 2019) return "即位礼正殿の儀";
      return null;
    case 11:
      if (d === 3) return "文化の日";
      if (d === 12 && y === 1990) return "即位礼正殿の儀";
      if (d === 23) return "勤労感謝の日";
      return null;
    case 12:
      return d === 23 && y >= 1989 && y <= 2018 ? "天皇誕生日" : null;
  }
  return null;
}

// The day `delta` days away, as [year, month, day].
function shift(y: number, m: number, d: number, delta: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

// The name of the Japanese holiday on a date ("YYYY-MM-DD"), or null.
export function japaneseHoliday(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1980 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const named = namedHoliday(y, mo, d);
  if (named) return named;
  // Substitute holiday: a holiday on a Sunday moves to the next day that is
  // not a holiday (before 2007: only to the Monday).
  if (y >= 2007) {
    for (let back = 1; namedHoliday(...shift(y, mo, d, -back)); back++) {
      if (weekday(...shift(y, mo, d, -back)) === 0) return "振替休日";
    }
  } else if (weekday(y, mo, d) === 1 && namedHoliday(...shift(y, mo, d, -1))) {
    return "振替休日";
  }
  // Citizens' holiday (from 1986): a day between two holidays (before 2007,
  // not on a Sunday).
  if (
    y >= 1986 &&
    namedHoliday(...shift(y, mo, d, -1)) &&
    namedHoliday(...shift(y, mo, d, 1)) &&
    (y >= 2007 || weekday(y, mo, d) !== 0)
  ) {
    return "国民の休日";
  }
  return null;
}
