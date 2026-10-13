import { describe, expect, it } from "vitest";
import { describeRoutineSchedule, describeSchedule } from "./schedule";

describe("describeSchedule", () => {
  it.each([
    ["0 8 * * 1-5", "Weekdays at 8:00"],
    ["0 17 * * 1-5", "Weekdays at 17:00"],
    ["30 7 * * 1-5", "Weekdays at 7:30"],
    ["0 9 * * 1", "Mondays at 9:00"],
    ["0 9 * * 0", "Sundays at 9:00"],
    ["0 9 * * 7", "Sundays at 9:00"],
    ["0 9 * * 2,4", "Tuesdays and Thursdays at 9:00"],
    ["0 9 * * 1,3,5", "Mondays, Wednesdays and Fridays at 9:00"],
    ["0 10 * * 0,6", "Weekends at 10:00"],
    ["0 9 * * *", "Every day at 9:00"],
    ["0 9 1 * *", "Monthly on the 1st at 9:00"],
    ["15 6 22 * *", "Monthly on the 22nd at 6:15"],
    ["0 9 28 * *", "Monthly on the 28th at 9:00"],
    ["0 9 29 * *", "Monthly on the 29th at 9:00 (skips shorter months)"],
    ["0 9 31 * *", "Monthly on the 31st at 9:00 (skips shorter months)"],
    ["0 8-18/2 * * 1-5", "Every 2 hours, 8:00–18:00 on weekdays"],
    ["0 8-18/2 * * *", "Every 2 hours, 8:00–18:00"],
    ["0 */3 * * *", "Every 3 hours"],
  ])("describes %s as %s", (cron, text) => {
    expect(describeSchedule(cron)).toBe(text);
  });

  it.each(["*/5 * * * *", "0 9 * 1 *", "0 9 1 * 1", "0 9 * * MON", "nonsense", "0 25 * * *", "0 18-8/2 * * *"])(
    "falls back to the cron string for %s",
    (cron) => {
      expect(describeSchedule(cron)).toBe(cron);
    },
  );
});

describe("describeRoutineSchedule", () => {
  it("leaves the person's own time zone unlabelled and labels fixed zones", () => {
    expect(describeRoutineSchedule({ schedule: "0 8 * * 1-5", timezone: "person" })).toBe("Weekdays at 8:00");
    expect(describeRoutineSchedule({ schedule: "0 16 * * 5", timezone: "America/New_York" })).toBe(
      "Fridays at 16:00 (America/New_York)",
    );
  });
});
