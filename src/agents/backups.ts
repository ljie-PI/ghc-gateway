const BACKUP_TIMESTAMP_PATTERN = "[0-9]{8}T[0-9]{6}";
const BACKUP_SEQUENCE_PATTERN = "[1-9][0-9]*";

export function formatLocalBackupTimestamp(value: Date): string {
  const year = value.getFullYear().toString().padStart(4, "0");
  const month = (value.getMonth() + 1).toString().padStart(2, "0");
  const day = value.getDate().toString().padStart(2, "0");
  const hour = value.getHours().toString().padStart(2, "0");
  const minute = value.getMinutes().toString().padStart(2, "0");
  const second = value.getSeconds().toString().padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}${second}`;
}

export function timestampBackupPattern(fileName: string): RegExp {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped}\\.ghcg\\.(${BACKUP_TIMESTAMP_PATTERN})(?:\\.(${BACKUP_SEQUENCE_PATTERN}))?$`, "u");
}

export function parseTimestampBackupPath(value: string): null | { readonly base: string; readonly sequence: number } {
  const match = new RegExp(`^(.*\\.ghcg\\.${BACKUP_TIMESTAMP_PATTERN})(?:\\.(${BACKUP_SEQUENCE_PATTERN}))?$`, "u").exec(value);
  return match === null ? null : { base: match[1]!, sequence: Number(match[2] ?? "0") };
}