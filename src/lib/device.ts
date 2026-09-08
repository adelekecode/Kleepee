import type { DeviceIdentity } from "../types/index";

const ADJECTIVES: string[] = [
  "Amber",
  "Azure",
  "Brave",
  "Bright",
  "Calm",
  "Clever",
  "Cosmic",
  "Daring",
  "Dusty",
  "Eager",
  "Fierce",
  "Gentle",
  "Golden",
  "Grand",
  "Happy",
  "Jade",
  "Jolly",
  "Keen",
  "Lively",
  "Mighty",
  "Noble",
  "Quick",
  "Radiant",
  "Serene",
  "Silver",
  "Swift",
  "Teal",
  "Vivid",
  "Wild",
  "Zesty",
];

const ANIMALS: string[] = [
  "Badger",
  "Bear",
  "Buffalo",
  "Cheetah",
  "Crane",
  "Deer",
  "Eagle",
  "Falcon",
  "Fox",
  "Gecko",
  "Hawk",
  "Jaguar",
  "Koala",
  "Lemur",
  "Lynx",
  "Otter",
  "Owl",
  "Panda",
  "Parrot",
  "Penguin",
  "Rabbit",
  "Raven",
  "Shark",
  "Tiger",
  "Turtle",
  "Viper",
  "Walrus",
  "Wolf",
  "Wombat",
  "Zebra",
];

/**
 * Picks a random adjective and a random animal and returns them
 * as a space-separated string, e.g. "Bright Panda".
 */
export function generateDeviceName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adjective} ${animal}`;
}

const STORAGE_KEY_ID = "kleepee.device.id";
const STORAGE_KEY_NAME = "kleepee.device.name";

/**
 * Reads the device identity from localStorage. If either value is missing,
 * generates a new id (via `crypto.randomUUID()`) and name (via
 * `generateDeviceName()`), persists them, and returns the new identity.
 *
 * If localStorage is unavailable (e.g. in a sandboxed or private-browsing
 * context that throws on access), falls back to in-memory generation without
 * attempting persistence.
 */
export function loadOrCreateIdentity(): DeviceIdentity {
  try {
    const storedId = localStorage.getItem(STORAGE_KEY_ID);
    const storedName = localStorage.getItem(STORAGE_KEY_NAME);

    if (storedId !== null && storedName !== null) {
      return { deviceId: storedId, deviceName: storedName };
    }

    // At least one value is missing — generate fresh values and persist both.
    const deviceId = crypto.randomUUID();
    const deviceName = generateDeviceName();

    localStorage.setItem(STORAGE_KEY_ID, deviceId);
    localStorage.setItem(STORAGE_KEY_NAME, deviceName);

    return { deviceId, deviceName };
  } catch {
    // localStorage is unavailable; fall back to ephemeral in-memory identity.
    const deviceId = crypto.randomUUID();
    const deviceName = generateDeviceName();
    return { deviceId, deviceName };
  }
}
