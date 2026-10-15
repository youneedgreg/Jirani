/** What a sensor is for. Jirani reasons about roles, never raw device IDs. */
export type Role = 'frontDoor' | 'fridge' | 'bathroom' | 'medicine' | 'doorbell';

export interface Household {
  id: string;
  /** The person Jirani looks after. */
  residentName: string;
  timeZone: string;
  /** deviceId -> role */
  devices: Record<string, Role>;
  contacts: Contact[];
  /** Margaret's own choices. Jirani never overrides these. */
  consent: {
    /** May family open the front-door live view at Level 3? */
    liveViewAtLevel3: boolean;
  };
}

export interface Contact {
  id: string;
  name: string;
  relation: 'neighbour' | 'family';
  /** Order within the ladder: lower is asked first. */
  priority: number;
  email?: string;
  phone?: string;
}

/** Normalised Ring event (see @jirani/ring normalise()). */
export interface CoreEvent {
  id: string;
  deviceId: string;
  type: string;
  subType?: string;
  /** ISO 8601 */
  at: string;
}

export type ContextKind =
  /** Nobody home: suppress "no activity" alerts in the window. */
  | 'away'
  /** e.g. "sleeping in", "doctor at 10": shift morning expectations later. */
  | 'late_start'
  /** Expected visitor or carer: suppress unusual doorbell/door alerts. */
  | 'visitor_expected'
  /** Free note, kept for the family; no effect on detection. */
  | 'note';

export interface ContextNote {
  id: string;
  kind: ContextKind;
  text: string;
  /** ISO */
  startsAt: string;
  /** ISO */
  endsAt: string;
  createdBy: 'resident' | 'family';
  createdAt: string;
  /** For late_start: how many minutes to shift expectations. */
  shiftMinutes?: number;
}

export interface Pause {
  until: string;
  by: 'resident';
  reason?: string;
}
