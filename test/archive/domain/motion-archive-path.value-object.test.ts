import { describe, expect, it } from "vitest";
import { MotionArchivePath } from "../../../src/archive/domain/motion-archive-path.value-object";

describe("MotionArchivePath", () => {
  it.each([
    ["2026/08/13/120000-12345.avi", "video/x-msvideo"],
    ["2024/02/29/235959-event_01.mkv", "video/x-matroska"],
    ["1970/01/01/000000-a.mp4", "video/mp4"],
  ])("parses %s without using wall-clock time", (value, contentType) => {
    const path = MotionArchivePath.parse(value);
    expect(path).toMatchObject({
      year: value.slice(0, 4),
      month: value.slice(5, 7),
      day: value.slice(8, 10),
      fileName: value.slice(11),
      yearPath: value.slice(0, 4),
      monthPath: value.slice(0, 7),
      dayPath: value.slice(0, 10),
      contentType,
    });
  });

  it.each([
    "../2026/08/13/120000-a.mp4",
    "/2026/08/13/120000-a.mp4",
    "2026\\08\\13\\120000-a.mp4",
    "2026/8/13/120000-a.mp4",
    "1969/12/31/235959-a.mp4",
    "2025/02/29/120000-a.mp4",
    "2026/13/01/120000-a.mp4",
    "2026/08/13/240000-a.mp4",
    "2026/08/13/126000-a.mp4",
    "2026/08/13/120060-a.mp4",
    "2026/08/13/120000-.mp4",
    "2026/08/13/120000-a b.mp4",
    "2026/08/13/120000-a.mov",
    "2026/08/13/extra/120000-a.mp4",
  ])("rejects malformed path %s", (value) => {
    expect(() => MotionArchivePath.parse(value)).toThrow(
      "Motion archive path is invalid",
    );
  });

  it("returns the same components in different process timezones", () => {
    const original = process.env.TZ;
    try {
      const values = ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"].map(
        (timezone) => {
          process.env.TZ = timezone;
          return MotionArchivePath.parse("2024/03/31/013000-event.avi").dayPath;
        },
      );
      expect(values).toEqual(["2024/03/31", "2024/03/31", "2024/03/31"]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
