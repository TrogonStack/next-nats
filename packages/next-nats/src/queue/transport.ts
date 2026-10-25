export interface Transport<T = unknown> {
  serialize(value: T): Buffer | ReadableStream<Uint8Array>;
  deserialize(stream: ReadableStream<Uint8Array>): Promise<T>;
  finalize?(payload: T): Promise<void>;
  contentType: string;
}

export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function bufferToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

export class JsonTransport<T = unknown> implements Transport<T> {
  readonly contentType = "application/json";
  readonly replacer?: Parameters<typeof JSON.stringify>[1];
  readonly reviver?: Parameters<typeof JSON.parse>[1];

  constructor(options: { replacer?: Parameters<typeof JSON.stringify>[1]; reviver?: Parameters<typeof JSON.parse>[1] } = {}) {
    this.replacer = options.replacer;
    this.reviver = options.reviver;
  }

  serialize(value: T): Buffer {
    return Buffer.from(JSON.stringify(value, this.replacer as never), "utf8");
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<T> {
    const buffer = await streamToBuffer(stream);
    return JSON.parse(buffer.toString("utf8"), this.reviver as never) as T;
  }
}

export class BufferTransport implements Transport<Buffer> {
  readonly contentType = "application/octet-stream";

  serialize(value: Buffer): Buffer {
    return value;
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    return streamToBuffer(stream);
  }
}

export class StreamTransport implements Transport<ReadableStream<Uint8Array>> {
  readonly contentType = "application/octet-stream";

  serialize(value: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return value;
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
    return stream;
  }

  async finalize(payload: ReadableStream<Uint8Array>): Promise<void> {
    const reader = payload.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
}
