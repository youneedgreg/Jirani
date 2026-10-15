import { DEFAULT_DEVICES, generate, PRESETS } from 'ring-routine-sim';
import { fromLocal, type ContextNote, type CoreEvent, type Household } from '@jirani/core';

export const TZ = 'America/New_York';

export function margaret(overrides: Partial<Household> = {}): Household {
  return {
    id: 'house-margaret',
    residentName: 'Margaret',
    timeZone: TZ,
    devices: {
      [DEFAULT_DEVICES.frontDoor]: 'frontDoor',
      [DEFAULT_DEVICES.fridge]: 'fridge',
      [DEFAULT_DEVICES.bathroom]: 'bathroom',
      [DEFAULT_DEVICES.medicine]: 'medicine',
      [DEFAULT_DEVICES.doorbell]: 'doorbell',
    },
    contacts: [
      { id: 'joe', name: 'Joe', relation: 'neighbour', priority: 1 },
      { id: 'amina', name: 'Amina', relation: 'family', priority: 1 },
    ],
    consent: { liveViewAtLevel3: true },
    ...overrides,
  };
}

export function preset(name: string, until?: string): CoreEvent[] {
  const p = PRESETS[name];
  if (!p) throw new Error(name);
  const opts = { ...p.options };
  delete opts.until;
  if (until) opts.until = until;
  return generate(opts);
}

/** Local wall-clock in Columbus -> ISO. */
export const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(fromLocal(TZ, date, h * 60 + m)).toISOString();
};

export const upTo = (events: CoreEvent[], iso: string) => events.filter((e) => e.at <= iso);

export function context(kind: ContextNote['kind'], text: string, startsAt: string, endsAt: string, extra: Partial<ContextNote> = {}): ContextNote {
  return { id: `ctx-${kind}-${startsAt}`, kind, text, startsAt, endsAt, createdBy: 'resident', createdAt: startsAt, ...extra };
}
