const PATTERN =
  /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})(\d{2})-([A-Za-z0-9][A-Za-z0-9._-]*)\.(avi|mkv|mp4)$/u;

const MIME = {
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  mp4: "video/mp4",
} as const;

export class MotionArchivePath {
  private constructor(
    readonly year: string,
    readonly month: string,
    readonly day: string,
    readonly fileName: string,
    readonly contentType: (typeof MIME)[keyof typeof MIME],
  ) {}

  static parse(value: string): MotionArchivePath {
    const match = PATTERN.exec(value);
    if (match === null || value.includes("\\")) throw invalid();

    const [year, month, day, hour, minute, second] = match
      .slice(1, 7)
      .map(Number);
    if (year < 1970 || hour > 23 || minute > 59 || second > 59) {
      throw invalid();
    }

    const utc = new Date(Date.UTC(year, month - 1, day));
    if (
      utc.getUTCFullYear() !== year ||
      utc.getUTCMonth() !== month - 1 ||
      utc.getUTCDate() !== day
    ) {
      throw invalid();
    }

    const extension = match[8] as keyof typeof MIME;
    return Object.freeze(
      new MotionArchivePath(
        match[1],
        match[2],
        match[3],
        value.slice(11),
        MIME[extension],
      ),
    );
  }

  get yearPath(): string {
    return this.year;
  }

  get monthPath(): string {
    return `${this.year}/${this.month}`;
  }

  get dayPath(): string {
    return `${this.year}/${this.month}/${this.day}`;
  }
}

function invalid(): Error {
  return new Error("Motion archive path is invalid");
}
