import { type EffectiveModelCapabilitySnapshot } from "../../../copilot/capability_registry.js";
import { type WireJsonObject } from "../../../serialization/wire_json.js";
import { type ReasoningCarrierRecord } from "../reasoning_carriers.js";
import { type EncodedConversionRequest, type InferenceProtocol, type SemanticRequest } from "../types.js";

export interface EncodeContext {
  readonly resolvedModel: string;
  readonly capability: EffectiveModelCapabilitySnapshot;
}

export interface ProtocolRequestCodec {
  readonly protocol: InferenceProtocol;
  decode(body: WireJsonObject, carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord>): SemanticRequest;
  encode(request: Readonly<SemanticRequest>, context: Readonly<EncodeContext>): EncodedConversionRequest;
}
