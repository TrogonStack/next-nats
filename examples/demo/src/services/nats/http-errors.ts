import { Code, InvalidArgumentError, publicErrorResponse, SpecError, Visibility } from "@trogonstack/next-nats";

const DOMAIN = "demo.api";

export function badRequest(reason: string, message: string, subject?: string): Response {
  return publicErrorResponse(new InvalidArgumentError({ domain: DOMAIN, reason, message, subject, visibility: Visibility.PUBLIC }));
}

export function rateLimited(headers: Record<string, string>): Response {
  const error = new SpecError({
    code: Code.RESOURCE_EXHAUSTED,
    domain: DOMAIN,
    reason: "RATE_LIMITED",
    message: "Too many requests",
    visibility: Visibility.PUBLIC,
  });
  return publicErrorResponse(error, { headers });
}

export function unavailable(reason: string, message: string): Response {
  return publicErrorResponse(new SpecError({ code: Code.UNAVAILABLE, domain: DOMAIN, reason, message, visibility: Visibility.PUBLIC }));
}

export async function readJson<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch {
    return badRequest("INVALID_JSON", "Request body is not valid JSON");
  }
}
