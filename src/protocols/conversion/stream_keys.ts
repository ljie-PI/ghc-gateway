export type ResponseItemKey =
  | `responses:${number}`
  | `responses:${number}:message`
  | `responses:${number}:reasoning`;

export type ResponseContentKind = "text" | "refusal";
export type ResponseReasoningPresentation = "summary" | "content";

export function responseToolKey(outputIndex: number): ResponseItemKey {
  return `responses:${outputIndex}`;
}

export function responseMessageKey(outputIndex: number): ResponseItemKey {
  return `responses:${outputIndex}:message`;
}

export function responseReasoningKey(outputIndex: number): ResponseItemKey {
  return `responses:${outputIndex}:reasoning`;
}

export function responseMessagePartKey(
  outputIndex: number,
  contentIndex: number,
  kind: ResponseContentKind,
): string {
  return `responses:${outputIndex}:${contentIndex}:${kind}`;
}

export function responseReasoningPartKey(
  itemKey: string,
  presentation: ResponseReasoningPresentation,
  partIndex: number,
): string {
  const outputIndex = responseOutputIndex(itemKey);
  if (outputIndex === undefined || itemKey !== responseReasoningKey(outputIndex)) {
    throw new Error("invalid Responses reasoning key");
  }
  return `${itemKey}:${presentation}:${partIndex}`;
}

export function responseOutputIndex(key: string): number | undefined {
  const match = /^responses:(\d+)(?::(?:message|reasoning))?$/u.exec(key);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

export function responseMessagePartPosition(
  key: string,
): { readonly outputIndex: number; readonly contentIndex: number; readonly kind: ResponseContentKind } | undefined {
  const match = /^responses:(\d+):(\d+):(text|refusal)$/u.exec(key);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return {
    outputIndex: Number.parseInt(match[1], 10),
    contentIndex: Number.parseInt(match[2], 10),
    kind: match[3] as ResponseContentKind,
  };
}
