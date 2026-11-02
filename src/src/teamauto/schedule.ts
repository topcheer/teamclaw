// Wall-clock aligned schedule resolution for TeamAuto sweeps.
//
// The previous implementation translated an expression into a plain
// interval and chained setTimeout()s from "now". Two problems:
//
// 1. Every gateway restart reset the countdown: with restarts less than
//    one period apart, star-slash-30 never fired at all (observed
//    2026-11-02: three restarts within 30 minutes froze both repos).
// 2. Unrecognised expressions silently fell back to "first number of
//    digits x 1 minute" - "0 9 * * *" (daily at nine) became a sweep
//    every single minute.
//
// This module resolves schedules to the NEXT WALL-CLOCK boundary
// (local time, matching cron semantics) so a restart costs at most one
// partial period, and unsupported expressions throw ScheduleParseError
// instead of guessing a cadence.
//
// Supported expressions (5-field cron, local time):
//   every N minutes:        star-slash-N in the minute field
//   hourly at minute M:     "M * * * *"
//   every N hours on :00:   "0 star-slash-N * * *"
//   daily at H:M:           "M H * * *"
//   @hourly  @daily  @weekly (Monday 00:00)  @monthly (1st 00:00)

export class ScheduleParseError extends Error {
  constructor(schedule: string) {
    super(
      `unsupported schedule "${schedule}": use */N * * * *, M * * * *, 0 */N * * *, M H * * *, @hourly, @daily, @weekly or @monthly`,
    );
    this.name = "ScheduleParseError";
  }
}

export function nextFireMs(schedule: string, now: number = Date.now()): number {
  const s = schedule.trim();
  const next = new Date(now);
  next.setSeconds(0, 0);

  if (s === "@hourly") {
    next.setMinutes(0);
    if (next.getTime() <= now) {
      next.setHours(next.getHours() + 1);
    }
    return next.getTime() - now;
  }

  if (s === "@daily") {
    next.setHours(0, 0, 0, 0);
    if (next.getTime() <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now;
  }

  if (s === "@weekly") {
    next.setHours(0, 0, 0, 0);
    if (next.getTime() <= now) {
      next.setDate(next.getDate() + 1);
    }
    // Monday = day 1. Day-0 first guarantees strictly-future even on Mondays.
    while (next.getDay() !== 1) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now;
  }

  if (s === "@monthly") {
    next.setDate(1);
    next.setHours(0, 0, 0, 0);
    if (next.getTime() <= now) {
      next.setMonth(next.getMonth() + 1);
    }
    return next.getTime() - now;
  }

  const stepMin = s.match(/^\*\/(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/);
  if (stepMin) {
    const n = Number(stepMin[1]);
    if (n < 1 || n > 59) {
      throw new ScheduleParseError(s);
    }
    if (next.getTime() <= now) {
      next.setMinutes(next.getMinutes() + 1);
    }
    while (next.getMinutes() % n !== 0) {
      next.setMinutes(next.getMinutes() + 1);
    }
    return next.getTime() - now;
  }

  const hourlyAt = s.match(/^(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/);
  if (hourlyAt) {
    const m = Number(hourlyAt[1]);
    if (m > 59) {
      throw new ScheduleParseError(s);
    }
    next.setMinutes(m);
    if (next.getTime() <= now) {
      next.setHours(next.getHours() + 1);
    }
    return next.getTime() - now;
  }

  const hourStep = s.match(/^0\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (hourStep) {
    const n = Number(hourStep[1]);
    if (n < 1 || n > 23) {
      throw new ScheduleParseError(s);
    }
    next.setMinutes(0);
    if (next.getTime() <= now) {
      next.setHours(next.getHours() + 1);
    }
    while (next.getHours() % n !== 0) {
      next.setHours(next.getHours() + 1);
    }
    return next.getTime() - now;
  }

  const daily = s.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (daily) {
    const m = Number(daily[1]);
    const h = Number(daily[2]);
    if (m > 59 || h > 23) {
      throw new ScheduleParseError(s);
    }
    next.setMinutes(m);
    next.setHours(h);
    if (next.getTime() <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now;
  }

  throw new ScheduleParseError(s);
}
