/** Local-time helpers (Intl only). The household's day runs on its own clock. */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface Local {
  /** YYYY-MM-DD in the household's zone */
  date: string;
  /** minutes after local midnight */
  minutes: number;
  /** 0 = Sunday */
  weekday: number;
  hour: number;
}

export function toLocal(timeZone: string, at: string | number | Date): Local {
  const parts = formatter(timeZone).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')) + Number(get('second')) / 60,
    weekday: WEEKDAYS.indexOf(get('weekday')),
    hour,
  };
}

/** Local wall-clock (date + minutes) in a zone -> UTC epoch ms. */
export function fromLocal(timeZone: string, date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d) + Math.round(minutes * 60000);
  const offsetAt = (ms: number) => {
    const l = toLocal(timeZone, ms);
    const [ly, lm, ld] = l.date.split('-').map(Number) as [number, number, number];
    return Date.UTC(ly, lm - 1, ld) + Math.round(l.minutes * 60000) - ms;
  };
  let guess = naive - offsetAt(naive);
  guess = naive - offsetAt(guess);
  return guess;
}

export function hhmm(minutes: number): string {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')}${suffix}`;
}

export const MINUTE = 60_000;
