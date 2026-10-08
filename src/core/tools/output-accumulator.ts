import { createWriteStream, type WriteStream } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail, type TruncationResult } from './truncate.js';

export interface OutputSnapshot {
  content: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
}

/**
 * Tracks streaming command output with bounded memory: keeps a decoded tail
 * for display, counts total lines/bytes, and spills the raw stream to a temp
 * file once the output no longer fits the limits so nothing is lost.
 */
export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly decoder = new TextDecoder();

  private rawChunks: Buffer[] = [];
  private tailText = '';
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private openLine = false;
  private tempFilePath: string | undefined;
  private tempFile: WriteStream | undefined;

  constructor(options: { maxLines?: number; maxBytes?: number } = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  append(data: Buffer): void {
    this.totalRawBytes += data.length;
    this.appendText(this.decoder.decode(data, { stream: true }));
    if (this.tempFile || this.overLimit()) {
      this.ensureTempFile();
      this.tempFile?.write(data);
    } else {
      this.rawChunks.push(data);
    }
  }

  finish(): void {
    this.appendText(this.decoder.decode());
    if (this.overLimit()) this.ensureTempFile();
  }

  snapshot(): OutputSnapshot {
    const tail = truncateTail(this.tailText, { maxLines: this.maxLines, maxBytes: this.maxBytes });
    const totalLines = this.completedLines + (this.openLine ? 1 : 0);
    const truncated = totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncation: TruncationResult = {
      ...tail,
      truncated,
      truncatedBy: truncated ? (tail.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? 'bytes' : 'lines')) : null,
      totalLines,
      totalBytes: this.totalDecodedBytes,
    };
    if (truncated) this.ensureTempFile();
    return { content: truncation.content, truncation, fullOutputPath: this.tempFilePath };
  }

  async closeTempFile(): Promise<void> {
    const stream = this.tempFile;
    if (!stream) return;
    this.tempFile = undefined;
    await new Promise<void>((res, rej) => {
      stream.once('error', rej);
      stream.once('finish', () => res());
      stream.end();
    });
  }

  private appendText(text: string): void {
    if (!text) return;
    this.totalDecodedBytes += Buffer.byteLength(text, 'utf-8');
    this.tailText += text;
    // Rolling window: keep roughly 2x the display budget, trim from the front.
    const cap = this.maxBytes * 2;
    if (this.tailText.length > cap * 2) this.tailText = this.tailText.slice(this.tailText.length - cap);

    let newlines = 0;
    let last = -1;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      newlines++;
      last = i;
    }
    if (newlines === 0) {
      this.openLine = true;
    } else {
      this.completedLines += newlines;
      this.openLine = last < text.length - 1;
    }
  }

  private overLimit(): boolean {
    const lines = this.completedLines + (this.openLine ? 1 : 0);
    return this.totalRawBytes > this.maxBytes || lines > this.maxLines;
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;
    this.tempFilePath = join(tmpdir(), `codegrunt-shell-${randomBytes(6).toString('hex')}.log`);
    this.tempFile = createWriteStream(this.tempFilePath);
    for (const chunk of this.rawChunks) this.tempFile.write(chunk);
    this.rawChunks = [];
  }
}
