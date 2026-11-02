export function getLocalDateKey(value: Date = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Hours from `now` until 9:00 local time on the next calendar day. */
export function hoursUntilTomorrowMorning(now: Date = new Date()): number {
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  return (morning.getTime() - now.getTime()) / 3_600_000;
}
