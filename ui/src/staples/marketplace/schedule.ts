/**
 * Plain-language schedules for agent template routines: "Weekdays at 8:00",
 * "Mondays at 9:00", "Every 2 hours, 8:00–18:00 on weekdays". Covers the
 * shapes templates use; anything else is shown as the cron string itself.
 */

const DAY_PLURALS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function int(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

function clock(hour: number, minute: number): string {
  return `${hour}:${minute.toString().padStart(2, "0")}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function joinList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "weekdays", "weekends", "Mondays and Thursdays", or null for every day / unrecognized. */
function days(dow: string): { text: string } | "every" | null {
  if (dow === "*" || dow === "?") return "every";
  if (dow === "1-5") return { text: "weekdays" };
  if (dow === "0,6" || dow === "6,0" || dow === "6,7") return { text: "weekends" };
  const parts = dow.split(",").map((part) => int(part, 0, 7));
  if (parts.some((part) => part === null)) return null;
  const unique = [...new Set(parts.map((part) => part! % 7))].sort((a, b) => a - b);
  return { text: joinList(unique.map((day) => DAY_PLURALS[day]!)) };
}

function capitalize(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/** A human description of a 5-field cron expression, or the expression itself when unrecognized. */
export function describeSchedule(cron: string): string {
  const trimmed = cron.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return trimmed;
  const [minuteField, hourField, domField, monthField, dowField] = fields as [string, string, string, string, string];
  if (monthField !== "*") return trimmed;
  const minute = int(minuteField, 0, 59);
  if (minute === null) return trimmed;
  const dayRule = days(dowField);
  if (dayRule === null) return trimmed;

  // Every N hours within a window, e.g. "0 8-18/2 * * 1-5".
  const windowed = hourField.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (windowed && domField === "*") {
    const from = int(windowed[1]!, 0, 23);
    const to = int(windowed[2]!, 0, 23);
    const step = int(windowed[3]!, 1, 23);
    if (from === null || to === null || step === null || from > to) return trimmed;
    const every = step === 1 ? "Every hour" : `Every ${step} hours`;
    const window = `${clock(from, minute)}–${clock(to, minute)}`;
    return dayRule === "every" ? `${every}, ${window}` : `${every}, ${window} on ${dayRule.text}`;
  }

  // Every N hours all day, e.g. "0 */3 * * *".
  const stepped = hourField.match(/^\*\/(\d+)$/);
  if (stepped && domField === "*") {
    const step = int(stepped[1]!, 1, 23);
    if (step === null) return trimmed;
    const every = step === 1 ? "Every hour" : `Every ${step} hours`;
    return dayRule === "every" ? every : `${every} on ${dayRule.text}`;
  }

  const hour = int(hourField, 0, 23);
  if (hour === null) return trimmed;
  const at = clock(hour, minute);

  if (domField === "*") {
    return dayRule === "every" ? `Every day at ${at}` : `${capitalize(dayRule.text)} at ${at}`;
  }
  const dom = int(domField, 1, 31);
  if (dom !== null && dayRule === "every") {
    // Cron skips months without that day (e.g. the 31st in April), so say so.
    const skips = dom >= 29 ? " (skips shorter months)" : "";
    return `Monthly on the ${ordinal(dom)} at ${at}${skips}`;
  }
  return trimmed;
}

/** The schedule plus its time zone: "person" zones run on the person's own time, so they need no label. */
export function describeRoutineSchedule(routine: { schedule: string; timezone: string }): string {
  const text = describeSchedule(routine.schedule);
  if (!routine.timezone || routine.timezone === "person") return text;
  return `${text} (${routine.timezone})`;
}
