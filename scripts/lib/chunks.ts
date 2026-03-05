export interface Message {
  role: string;
  text: string;
  timestamp: number | null;
}

export interface Chunk {
  text: string;
  ts_start: number | null;
  ts_end: number | null;
}

export function* chunkMessages(
  messages: Message[],
  maxLen: number,
): Generator<Chunk> {
  let text = "";
  let tsStart: number | null = null;
  let tsEnd: number | null = null;

  for (const msg of messages) {
    const line = `${msg.role}: ${msg.text.slice(0, 2000)}\n`;

    if (text.length + line.length > maxLen && text.length > 0) {
      yield { text: text.trimEnd(), ts_start: tsStart, ts_end: tsEnd };
      text = "";
      tsStart = null;
      tsEnd = null;
    }

    text += line;
    if (msg.timestamp != null) {
      tsStart ??= msg.timestamp;
      tsEnd = msg.timestamp;
    }
  }

  if (text.length >= 50) {
    yield { text: text.trimEnd(), ts_start: tsStart, ts_end: tsEnd };
  }
}
