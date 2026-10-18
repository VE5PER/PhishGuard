import { PlaygroundScenarioListSchema, type PlaygroundScenarioList } from "@phishguard/types";

export class PlaygroundApiError extends Error {
  constructor(public readonly kind: "unreachable" | "rate_limited" | "other", message: string) {
    super(message);
  }
}

async function request(input: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new PlaygroundApiError("unreachable", "Gateway unreachable — check your connection and try again");
  }
  if (response.status === 429) {
    throw new PlaygroundApiError("rate_limited", "Rate limit reached — try again in a minute");
  }
  if (!response.ok) {
    throw new PlaygroundApiError("other", `Gateway returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new PlaygroundApiError("other", "Gateway returned an unreadable response");
  }
}

function parseOrThrow<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new PlaygroundApiError("other", "Gateway response did not match the expected contract");
  return result.data;
}

export async function fetchScenarios(): Promise<PlaygroundScenarioList> {
  return parseOrThrow(PlaygroundScenarioListSchema.safeParse(await request("/v1/playground/scenarios")));
}
