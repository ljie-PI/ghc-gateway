import path from "node:path";

export interface WindowsIdentity {
  readonly name: string;
  readonly sid: string;
}

export type WindowsCommandRunner = (file: string, args: readonly string[]) => string;

export interface WindowsAclRestriction {
  readonly setOwner?: boolean;
  readonly removeOtherIdentities?: boolean;
  readonly currentIdentity?: Readonly<WindowsIdentity>;
}

export interface WindowsAclOptions {
  readonly cacheIdentity?: boolean;
}

export class InvalidWindowsIdentityError extends Error {
  constructor() {
    super("unable to resolve current Windows identity");
  }
}

/** Shared parsing and mutation rules for current-user-only Windows ACLs. */
export class WindowsAcl {
  private identity: WindowsIdentity | null = null;

  constructor(
    private readonly runCommand: WindowsCommandRunner,
    private readonly options: Readonly<WindowsAclOptions> = {},
  ) {}

  currentIdentity(): WindowsIdentity {
    if (this.options.cacheIdentity === true && this.identity !== null) {
      return this.identity;
    }
    const output = this.runCommand("whoami", ["/user", "/fo", "csv", "/nh"]).trim();
    const match = /^"([^"]+)","([^"]+)"$/u.exec(output);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new InvalidWindowsIdentityError();
    }
    const identity = { name: match[1].toLowerCase(), sid: match[2].toLowerCase() };
    if (this.options.cacheIdentity === true) {
      this.identity = identity;
    }
    return identity;
  }

  identities(target: string): readonly string[] {
    const output = this.runCommand("icacls", [target]);
    const identities: string[] = [];
    for (const rawLine of output.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("Successfully processed") || line.startsWith("Failed processing")) {
        continue;
      }
      const entry = rawLine.startsWith(target) ? rawLine.slice(target.length).trim() : line;
      const separator = entry.indexOf(":(");
      if (separator > 0) {
        identities.push(entry.slice(0, separator));
      }
    }
    return identities;
  }

  isCurrentIdentity(identity: string, current: Readonly<WindowsIdentity>): boolean {
    const normalized = identity.toLowerCase();
    return normalized === current.name || normalized === current.sid;
  }

  isCurrentUserOnly(target: string): boolean {
    const current = this.currentIdentity();
    const identities = this.identities(target);
    return identities.length === 1 && this.isCurrentIdentity(identities[0] ?? "", current);
  }

  restrict(target: string, directory: boolean, options: Readonly<WindowsAclRestriction> = {}): void {
    const current = options.currentIdentity ?? this.currentIdentity();
    const grant = directory ? `*${current.sid}:(OI)(CI)(F)` : `*${current.sid}:(F)`;
    if (options.setOwner === true) {
      this.runCommand("icacls", [target, "/setowner", `*${current.sid}`]);
    }
    this.runCommand("icacls", [target, "/inheritance:r", "/grant:r", grant]);
    if (options.removeOtherIdentities === false) {
      return;
    }
    for (const identity of this.identities(target)) {
      if (!this.isCurrentIdentity(identity, current)) {
        this.runCommand("icacls", [target, "/remove:g", identity]);
      }
    }
  }
}

export function windowsCommandPath(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (platform !== "win32") {
    return command;
  }
  const systemRoot = environment.SystemRoot ?? environment.WINDIR ?? "C:\\Windows";
  return path.join(systemRoot, "System32", `${command}.exe`);
}
