// Consumes a server-sent-events stream (one JSON object per `data:` line,
// events separated by a blank line) until the underlying reader reports
// `done`. Returns whether a terminal event (`step: 'done'` or `step:
// 'error'`) was actually observed — a stream that ends without one (dropped
// connection, server crash) must be treated as a failure by the caller.
export async function pumpSSE<T extends { step: string }>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (evt: T) => void,
): Promise<boolean> {
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminal = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        const evt = JSON.parse(line.slice(5).trim()) as T;
        onEvent(evt);
        if (evt.step === 'done' || evt.step === 'error') sawTerminal = true;
      } catch {
        // ignore malformed event
      }
    }
  }

  return sawTerminal;
}
