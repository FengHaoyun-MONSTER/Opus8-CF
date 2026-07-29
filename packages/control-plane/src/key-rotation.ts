import { jwtVerify } from "@opus8-cf/shared";

export type SecretSlot = "current" | "previous";

export interface SecretCandidate {
  slot: SecretSlot;
  secret: string;
}

export interface JwtRotationEnv {
  JWT_SECRET: string;
  JWT_SECRET_PREVIOUS?: string;
}

export function secretCandidates(
  current: string,
  previous?: string,
): SecretCandidate[] {
  const candidates: SecretCandidate[] = [];
  if (current) candidates.push({ slot: "current", secret: current });
  if (previous && previous !== current) {
    candidates.push({ slot: "previous", secret: previous });
  }
  return candidates;
}

export async function verifyJwtWithRotation(
  token: string,
  env: JwtRotationEnv,
): Promise<Record<string, unknown> | null> {
  for (const candidate of secretCandidates(
    env.JWT_SECRET,
    env.JWT_SECRET_PREVIOUS,
  )) {
    const payload = await jwtVerify(token, candidate.secret);
    if (payload) return payload;
  }
  return null;
}

export function previousSecretConfigured(
  current: string,
  previous?: string,
): boolean {
  return Boolean(previous && previous !== current);
}
