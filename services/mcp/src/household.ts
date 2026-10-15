import type { Household } from '@jirani/core';
import { DEFAULT_DEVICES } from 'ring-routine-sim';

/**
 * The demo household. Device IDs match ring-routine-sim's defaults, so simulated
 * events map to roles. With a real Ring account, replace the keys with the IDs
 * from GET /v1/devices.
 */
export function demoHousehold(): Household {
  return {
    id: 'house-margaret',
    residentName: 'Margaret',
    timeZone: 'America/New_York',
    devices: {
      [DEFAULT_DEVICES.frontDoor]: 'frontDoor',
      [DEFAULT_DEVICES.fridge]: 'fridge',
      [DEFAULT_DEVICES.bathroom]: 'bathroom',
      [DEFAULT_DEVICES.medicine]: 'medicine',
      [DEFAULT_DEVICES.doorbell]: 'doorbell',
    },
    contacts: [
      { id: 'joe', name: 'Joe', relation: 'neighbour', priority: 1, email: 'joe@example.com' },
      { id: 'amina', name: 'Amina', relation: 'family', priority: 1, email: 'amina@example.com' },
    ],
    consent: { liveViewAtLevel3: true },
  };
}
