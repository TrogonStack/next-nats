export interface SseReader {
  text(): string;
  waitFor(fragment: string, timeoutMs?: number): Promise<void>;
  close(): void;
}

export async function openSse(url: string): Promise<SseReader> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal, headers: { accept: "text/event-stream" } });
  if (!response.ok || !response.body) throw new Error(`SSE ${url} answered ${response.status}`);
  let received = "";
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        received += decoder.decode(value, { stream: true });
      }
    } catch {
      return;
    }
  })();
  return {
    text: () => received,
    async waitFor(fragment, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!received.includes(fragment)) {
        if (Date.now() > deadline) throw new Error(`SSE never delivered ${fragment}; received:\n${received}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    close: () => controller.abort(),
  };
}
