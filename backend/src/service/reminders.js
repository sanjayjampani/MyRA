const TIME_ZONE = process.env.DEFAULT_USER_TIMEZONE || "Asia/Kolkata";

export function dayKey(value, timeZone = TIME_ZONE) {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function countDue(reminders, now = new Date()) {
  const today = dayKey(now);
  return reminders.filter((reminder) => !reminder.doneAt && reminder.due && reminder.due <= today).length;
}

export function dueReminders(reminders, now = new Date()) {
  const today = dayKey(now);
  return reminders
    .filter((reminder) => !reminder.doneAt && reminder.due && reminder.due <= today)
    .map(({ id, title, due }) => ({ id, title, due }));
}

/** One point per day, oldest first, so a chart of length `days` ends today. */
export function reminderSeries(reminders, days, now = new Date()) {
  const today = dayKey(now);
  const start = shiftDay(today, -(days - 1));
  const points = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = shiftDay(start, offset);
    points.push({
      set: reminders.filter((reminder) => dayKey(reminder.createdAt) === day).length,
      done: reminders.filter((reminder) => reminder.doneAt && dayKey(reminder.doneAt) === day).length,
    });
  }
  return points;
}

function shiftDay(day, offset) {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + offset));
  return shifted.toISOString().slice(0, 10);
}
