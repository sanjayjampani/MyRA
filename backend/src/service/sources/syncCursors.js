import { userRepository } from "../../database/index.js";

function asObject(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? { ...parsed } : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? { ...value } : {};
}

export async function readSyncCursors(userId, repo = userRepository) {
  const user = await repo.findById(userId);
  const preferences = asObject(user?.preferences);
  const cursors = preferences.syncCursors;
  return cursors && typeof cursors === "object" ? cursors : {};
}

/**
 * Merge a sync cursor into user preferences without dropping unrelated keys.
 * Calendar tokens merge per calendar id so one calendar refresh cannot wipe the others.
 */
export async function patchSyncCursors(userId, patch, repo = userRepository) {
  return writePreferences(userId, (preferences) => {
    const current = preferences.syncCursors && typeof preferences.syncCursors === "object"
      ? preferences.syncCursors
      : {};
    const next = { ...current, ...patch };
    if (patch.calendarTokens) {
      next.calendarTokens = {
        ...(current.calendarTokens || {}),
        ...patch.calendarTokens,
      };
    }
    preferences.syncCursors = next;
    return preferences;
  }, repo);
}

async function writePreferences(userId, build, repo) {
  if (typeof repo.modifyPreferences === "function") {
    return repo.modifyPreferences(userId, async (current) => build(current));
  }
  const user = await repo.findById(userId);
  if (!user) throw new Error(`User with id ${userId} not found`);
  const next = await build(asObject(user.preferences));
  await repo.updatePreferences(userId, next);
  return next;
}

export async function readPreferences(userId, repo = userRepository) {
  const user = await repo.findById(userId);
  return asObject(user?.preferences);
}

export async function patchPreferenceKey(userId, key, value, repo = userRepository) {
  return writePreferences(userId, (preferences) => {
    preferences[key] = value;
    return preferences;
  }, repo);
}

export function cleanDeviceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,80}$/.test(value) ? value : "";
}

export function requestDeviceId(req) {
  const header = req?.get?.("x-myra-device") || req?.headers?.["x-myra-device"];
  return cleanDeviceId(header);
}

export async function indexingEnabled(userId, repo = userRepository) {
  try {
    const preferences = await readPreferences(userId, repo);
    return preferences.settings?.indexData !== false;
  } catch {
    return true;
  }
}

export async function rememberDevice(userId, deviceId, repo = userRepository) {
  const clean = cleanDeviceId(deviceId);
  if (!clean) return null;
  return writePreferences(userId, (preferences) => {
    const known = Array.isArray(preferences.knownDevices) ? preferences.knownDevices : [];
    if (known.includes(clean)) return preferences;
    preferences.knownDevices = [...known, clean].slice(-20);
    return preferences;
  }, repo);
}

/**
 * True only when the account has explicitly asked for a new sign-in on
 * unknown devices. A database miss allows the request so tests and a down
 * database do not lock the account out.
 */
export async function deviceNeedsReauth(userId, deviceId, repo = userRepository) {
  try {
    const preferences = await readPreferences(userId, repo);
    if (preferences.settings?.reauth !== true) return false;
    const known = Array.isArray(preferences.knownDevices) ? preferences.knownDevices : [];
    return !known.includes(cleanDeviceId(deviceId));
  } catch {
    return false;
  }
}
