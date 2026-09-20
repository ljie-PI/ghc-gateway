import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type BigIntStats,
  type Stats,
} from "node:fs";

type FileStats = Stats | BigIntStats;
type StatsFor<UseBigInt extends boolean> = UseBigInt extends true ? BigIntStats : Stats;

interface ProtectedFileReadErrors {
  readonly changed: (phase: "validation" | "read") => Error;
  readonly incomplete: () => Error;
  readonly tooLarge: () => Error;
  readonly open?: (cause: unknown) => Error;
}

interface ProtectedFileReadOptions<UseBigInt extends boolean = false> {
  readonly filePath: string;
  readonly maximumBytes: number;
  readonly bigint?: UseBigInt;
  readonly observeBefore: () => StatsFor<UseBigInt>;
  readonly observeNamed?: () => StatsFor<UseBigInt>;
  readonly validateBefore?: (stat: StatsFor<UseBigInt>) => void;
  readonly validateNamed?: () => void;
  readonly onBeforeOpen?: ((filePath: string) => void) | undefined;
  readonly onPostRead?: ((filePath: string) => void) | undefined;
  readonly settleMetadata?: boolean;
  readonly errors: ProtectedFileReadErrors;
}

interface ProtectedFileReadResult<T extends FileStats> {
  readonly buffer: Buffer;
  readonly opened: T;
}

export function readProtectedFileSync<UseBigInt extends boolean = false>(
  options: ProtectedFileReadOptions<UseBigInt>,
): ProtectedFileReadResult<StatsFor<UseBigInt>> {
  const noFollow = (constants as Readonly<Record<string, number>>)["O_NOFOLLOW"] ?? 0;
  if (options.settleMetadata === true) settleMetadata(options.filePath, noFollow, options.bigint === true);

  const before = options.observeBefore();
  options.validateBefore?.(before);
  options.onBeforeOpen?.(options.filePath);
  let fd: number;
  try {
    fd = openSync(options.filePath, constants.O_RDONLY | noFollow);
  } catch (error: unknown) {
    throw options.errors.open?.(error) ?? error;
  }

  try {
    const opened = statDescriptor(fd, options.bigint === true) as StatsFor<UseBigInt>;
    if (!opened.isFile() || !sameObservation(before, opened)) {
      throw options.errors.changed("validation");
    }
    if (exceeds(opened.size, options.maximumBytes)) throw options.errors.tooLarge();

    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) throw options.errors.incomplete();

    options.onPostRead?.(options.filePath);
    const after = statDescriptor(fd, options.bigint === true) as StatsFor<UseBigInt>;
    const named = (options.observeNamed ?? options.observeBefore)();
    if (!sameObservation(opened, after) || !sameObservation(after, named)) {
      throw options.errors.changed("read");
    }
    options.validateNamed?.();
    return { buffer, opened };
  } finally {
    closeSync(fd);
  }
}

function statDescriptor(fd: number, bigint: boolean): FileStats {
  return bigint ? fstatSync(fd, { bigint: true }) : fstatSync(fd);
}

function settleMetadata(filePath: string, noFollow: number, bigint: boolean): void {
  const fd = openSync(filePath, constants.O_RDONLY | noFollow);
  try {
    statDescriptor(fd, bigint);
  } finally {
    closeSync(fd);
  }
}

function sameObservation(left: FileStats, right: FileStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && timestamp(left, "ctime") === timestamp(right, "ctime")
    && timestamp(left, "mtime") === timestamp(right, "mtime")
    && left.size === right.size
    && left.nlink === right.nlink;
}

function timestamp(stat: FileStats, field: "ctime" | "mtime"): number | bigint {
  if ("ctimeNs" in stat) return field === "ctime" ? stat.ctimeNs : stat.mtimeNs;
  return field === "ctime" ? stat.ctimeMs : stat.mtimeMs;
}

function exceeds(size: number | bigint, maximumBytes: number): boolean {
  return typeof size === "bigint" ? size > BigInt(maximumBytes) : size > maximumBytes;
}
