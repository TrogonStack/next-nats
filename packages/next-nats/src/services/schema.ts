import { Code, SpecError, Visibility } from "../errors.js";
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export type ParserFn<T> = (raw: unknown) => T | Promise<T>;
export type Parser<T> = StandardSchemaV1<any, T> | ParserFn<T>;

function pointerOf(issue: StandardSchemaIssue): string | undefined {
  if (!issue.path || issue.path.length === 0) return undefined;
  const segments = issue.path.map((p) => String(typeof p === "object" ? p.key : p).replaceAll("~", "~0").replaceAll("/", "~1"));
  return `/${segments.join("/")}`;
}

export class ValidationError extends SpecError {
  readonly issues: ReadonlyArray<StandardSchemaIssue>;

  constructor(issues: ReadonlyArray<StandardSchemaIssue>) {
    super({
      code: Code.INVALID_ARGUMENT,
      domain: "next-nats.services",
      reason: "VALIDATION_FAILED",
      message: issues.map((i) => i.message).join("; ") || "Validation failed",
      visibility: Visibility.PUBLIC,
      causes: issues.map(
        (issue) =>
          new SpecError({
            code: Code.INVALID_ARGUMENT,
            domain: "next-nats.services",
            reason: "INVALID_FIELD",
            message: issue.message,
            visibility: Visibility.PUBLIC,
            subject: pointerOf(issue),
          }).spec,
      ),
    });
    this.name = "ValidationError";
    this.issues = issues;
  }
}

function isStandardSchema<T>(parser: Parser<T>): parser is StandardSchemaV1<any, T> {
  return (typeof parser === "object" || typeof parser === "function") && parser !== null && "~standard" in parser;
}

export async function runParser<T>(parser: Parser<T>, raw: unknown): Promise<T> {
  if (isStandardSchema(parser)) {
    const result = await parser["~standard"].validate(raw);
    if (result.issues) throw new ValidationError(result.issues);
    return result.value;
  }
  try {
    return await (parser as ParserFn<T>)(raw);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError([{ message: error instanceof Error ? error.message : String(error) }]);
  }
}
