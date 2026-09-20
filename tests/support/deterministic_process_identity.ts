export function deterministicProcessIdentity(pid: number): string | null {
  try {
    process.kill(pid, 0);
    return identityForPid(pid);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return null;
    throw error;
  }
}

export function identityForPid(pid: number): string {
  if (process.platform === "win32") return `windows:${String(pid)}`;
  if (process.platform === "darwin") {
    return `macos:${new Date(Date.UTC(2026, 0, 1, 0, 0, pid)).toISOString().replace(".000Z", "Z")}`;
  }
  return `linux:01234567-89ab-cdef-0123-456789abcdef:${String(pid)}`;
}
