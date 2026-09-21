// Approved experiment regions only; neither callers nor env strings become URLs.
export function approvedEdgeRegion(value) {
  return value === 'ap-northeast-2' || value === 'ap-southeast-1' ? value : undefined;
}

export function regionalLiveCapability(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.endpoint !== expected.endpoint || value.protocolVersion !== expected.protocolVersion) return undefined;
  if (value.region !== undefined && approvedEdgeRegion(value.region) === undefined) return undefined;
  return { endpoint: expected.endpoint, protocolVersion: expected.protocolVersion,
    ...(value.region === undefined ? {} : { region: approvedEdgeRegion(value.region) }) };
}

export function observedEdgeRegion(env) {
  const region = approvedEdgeRegion(env('SB_REGION'));
  return region === undefined ? {} : { region };
}
