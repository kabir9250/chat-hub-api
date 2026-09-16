import { BusinessHoursConfig } from '../database/schemas/site.schema';

/**
 * FR-HRS-01 boundary computation — extracted from
 * `WidgetBootstrapService.isWithinBusinessHours` (Session 9) so it has
 * exactly one implementation. Session Feature-1b-backend (Sounds &
 * Notifications, SRS §1.2 "Operating hours start/end") reuses this same
 * function to detect a boundary CROSSING (open -> closed or vice versa) by
 * calling it on a periodic tick and diffing against the previous result —
 * see `RealtimeGateway.sweepBusinessHoursBoundaries` — rather than
 * duplicating the weekday/time-range parsing, or building a second
 * scheduler alongside the existing stale-visitor sweep interval.
 *
 * No Business Hours configured (`enabled: false`) means no restriction —
 * always "open".
 */
export function isWithinBusinessHours(config: BusinessHoursConfig): boolean {
  if (!config.enabled) return true;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone || 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const dayKey = weekday.toLowerCase().slice(0, 3);
    const hm = `${hour === '24' ? '00' : hour}:${minute}`;

    const ranges = config.weeklySchedule?.[dayKey];
    if (!ranges || ranges.length === 0) return false;
    return ranges.some((range) => {
      const [start, end] = range.split('-');
      return !!start && !!end && hm >= start && hm <= end;
    });
  } catch {
    // Bad/unrecognized timezone string — don't let a config error block
    // the widget's online indicator (or the boundary sweep) entirely.
    return true;
  }
}
