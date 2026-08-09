import { Subscription, CommuteDirection, Trip } from '../types';

export interface CommuteDayInfo {
  currentDay: number;
  totalDays: number;
  planName: string;
  formattedDate: string;
  isWeekend: boolean;
}

export function isWorkingDay(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6; // Mon-Fri
}

/**
 * Calculates the active commute day (e.g. Day 1 of 22) based on billable working days
 * (Mon-Fri) elapsed since the subscription start date.
 */
export function calculateCommuteDayInfo(
  sub: Subscription | null,
  targetDate: Date = new Date()
): CommuteDayInfo {
  const name = (sub?.planName || '').toLowerCase();
  const days = sub?.durationDays || 0;
  const isMonthly = name.includes('1m') || name.includes('30') || name.includes('monthly') || days >= 20;
  const is15d = name.includes('15') || days === 11 || days === 15;

  const totalDays = isMonthly ? 22 : is15d ? 11 : 5;
  const planName = isMonthly ? 'Monthly Plan' : is15d ? '15-Day Plan' : '7-Day Plan';

  const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' };
  const formattedDate = targetDate.toLocaleDateString('en-IN', dateOptions);
  const isWeekend = !isWorkingDay(targetDate);

  if (!sub || !sub.startDate) {
    return { currentDay: 1, totalDays, planName, formattedDate, isWeekend };
  }

  const start = new Date(sub.startDate);
  start.setHours(0, 0, 0, 0);

  const current = new Date(targetDate);
  current.setHours(0, 0, 0, 0);

  if (current < start) {
    return { currentDay: 1, totalDays, planName, formattedDate, isWeekend };
  }

  // Count billable working days (Mon-Fri) between start and current date inclusive
  let workingDaysCount = 0;
  const cursor = new Date(start);

  while (cursor <= current) {
    if (isWorkingDay(cursor)) {
      workingDaysCount++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const currentDay = Math.min(totalDays, Math.max(1, workingDaysCount));

  return {
    currentDay,
    totalDays,
    planName,
    formattedDate,
    isWeekend,
  };
}

export interface LegScheduleItem {
  direction: CommuteDirection;
  label: string;
  time: string;
  origin: string;
  destination: string;
  buddyName?: string;
  matchScore?: number;
  matchId?: string;
  status: 'completed' | 'in_progress' | 'awaiting_confirmation' | 'scheduled' | 'no_buddy';
  trip?: Trip;
}

export function formatTimeHHMM(timeStr?: string): string {
  if (!timeStr) return '--:--';
  const [hStr, mStr] = timeStr.split(':');
  let h = parseInt(hStr, 10);
  if (isNaN(h)) return timeStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h.toString().padStart(2, '0')}:${mStr || '00'} ${ampm}`;
}
