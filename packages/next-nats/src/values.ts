declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Subject = Brand<string, "Subject">;
export type StreamName = Brand<string, "StreamName">;
export type BucketName = Brand<string, "BucketName">;
export type DurableName = Brand<string, "DurableName">;

const SUBJECT_TOKEN = /^[^\s.]+$/;
const NAME = /^[A-Za-z0-9_-]+$/;

export function subject(value: string): Subject {
  const tokens = value.split(".");
  if (value.length === 0 || !tokens.every((t) => SUBJECT_TOKEN.test(t))) {
    throw new TypeError(`Invalid NATS subject "${value}"`);
  }
  return value as Subject;
}

function name<B extends string>(kind: string, value: string): Brand<string, B> {
  if (!NAME.test(value)) {
    throw new TypeError(`Invalid ${kind} "${value}": use letters, digits, "-" and "_"`);
  }
  return value as Brand<string, B>;
}

export const streamName = (value: string): StreamName => name<"StreamName">("stream name", value);
export const bucketName = (value: string): BucketName => name<"BucketName">("bucket name", value);
export const durableName = (value: string): DurableName => name<"DurableName">("durable name", value);
