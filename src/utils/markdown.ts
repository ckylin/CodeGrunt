import chalk from 'chalk';
import stringWidth from 'string-width';

/**
 * Streaming Markdown renderer for terminal output.
 * Supports: **bold**, *italic*, `inline code`, ```code blocks```,
 * # headers, - lists, > blockquotes, --- dividers, tables.
 */

type MdState =
  | { kind: 'text' }
  | { kind: 'code_block'; buf: string }
  | { kind: 'table'; rows: string[] };

const blue  = (s: string) => chalk.hex('#4A90D9')(s);
const muted = chalk.gray;

export class MarkdownRenderer {
  private state: MdState = { kind: 'text' };
  private lineBuf = '';
  private codeBlockLang = '';
  private fenceCount = 0;
  private pendingTableRow: string | null = null;

  feed(chunk: string): string {
    let out = '';
    for (const ch of chunk) {
      if (ch === '\n') {
        out += this.commitLine();
      } else {
        this.lineBuf += ch;
      }
    }
    return out;
  }

  flush(): string {
    if (this.state.kind === 'table') {
      const out = this.renderTable(this.state.rows);
      this.state = { kind: 'text' };
      if (this.lineBuf) return out + '\n' + this.renderLine(this.lineBuf);
      return out;
    }
    if (this.pendingTableRow !== null) {
      const pre = this.renderLine(this.pendingTableRow) + '\n';
      this.pendingTableRow = null;
      if (this.lineBuf) return pre + this.renderLine(this.lineBuf);
      return pre;
    }
    if (this.lineBuf) return this.renderLine(this.lineBuf);
    return '';
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private commitLine(): string {
    const raw = this.lineBuf;
    this.lineBuf = '';

    if (this.state.kind === 'code_block') {
      const s = this.state;
      if (/^```\s*$/.test(raw)) {
        this.fenceCount++;
        if (this.fenceCount >= 1) {
          const out = this.formatCodeBlock(s.buf);
          this.state = { kind: 'text' };
          this.codeBlockLang = '';
          this.fenceCount = 0;
          return out + '\n';
        }
      }
      if (s.buf) s.buf += '\n';
      s.buf += raw;
      return '';
    }

    if (this.state.kind === 'table') {
      if (this.isTableRow(raw)) {
        this.state.rows.push(raw);
        return '';
      }
      const out = this.renderTable(this.state.rows);
      this.state = { kind: 'text' };
      this.lineBuf = raw;
      return out + '\n' + this.commitLine();
    }

    const fenceMatch = raw.match(/^```(\S*)$/);
    if (fenceMatch) {
      let pre = '';
      if (this.pendingTableRow !== null) {
        pre = this.renderLine(this.pendingTableRow) + '\n';
        this.pendingTableRow = null;
      }
      this.state = { kind: 'code_block', buf: '' };
      this.codeBlockLang = fenceMatch[1] || '';
      this.fenceCount = 0;
      return pre;
    }

    if (this.isTableRow(raw)) {
      if (this.pendingTableRow !== null && this.isTableSeparator(raw)) {
        this.state = { kind: 'table', rows: [this.pendingTableRow, raw] };
        this.pendingTableRow = null;
        return '';
      }
      let pre = '';
      if (this.pendingTableRow !== null) {
        pre = this.renderLine(this.pendingTableRow) + '\n';
      }
      this.pendingTableRow = raw;
      return pre;
    }

    if (this.pendingTableRow !== null) {
      const pre = this.renderLine(this.pendingTableRow) + '\n';
      this.pendingTableRow = null;
      return pre + this.renderLine(raw) + '\n';
    }

    return this.renderLine(raw) + '\n';
  }

  private renderLine(line: string): string {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return '';

    const headerMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const text = this.renderInline(headerMatch[2]);
      if (level === 1) return chalk.bold.underline(text);
      if (level === 2) return chalk.bold(text);
      return chalk.bold.dim(text);
    }

    if (/^-{3,}$/.test(trimmed)) {
      return muted('─'.repeat(Math.min(process.stdout.columns || 80, 80)));
    }

    if (trimmed.startsWith('> ')) {
      const content = this.renderInline(trimmed.slice(2));
      return muted('│ ') + chalk.italic(content);
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const indent = trimmed.match(/^(\s*)/)?.[1] ?? '';
      const content = trimmed.replace(/^(\s*)[-*]\s+/, '');
      return indent + blue('• ') + this.renderInline(content);
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const match = trimmed.match(/^(\s*)(\d+)\.\s+(.*)/);
      if (match) {
        return match[1] + blue(match[2] + '. ') + this.renderInline(match[3]);
      }
    }

    return this.renderInline(trimmed);
  }

  private renderInline(text: string): string {
    let result = text;
    result = result.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t));
    result = result.replace(/__(.+?)__/g, (_, t) => chalk.bold(t));
    result = result.replace(/\*(.+?)\*/g, (_, t) => chalk.italic(t));
    result = result.replace(/_(.+?)_/g, (_, t) => chalk.italic(t));
    result = result.replace(/`([^`]+)`/g, (_, t) => blue(' ' + t + ' '));
    result = result.replace(/~~(.+?)~~/g, (_, t) => chalk.strikethrough(t));
    return result;
  }

  private formatCodeBlock(code: string): string {
    const lines = code.split('\n');
    const maxCols = Math.min(process.stdout.columns || 80, 100);
    const innerW = Math.min(maxCols - 2, 60);

    // Top border with language label
    const langLabel = this.codeBlockLang
      ? blue(' ' + this.codeBlockLang + ' ')
      : '';
    const langLabelLen = this.codeBlockLang ? this.codeBlockLang.length + 2 : 0;
    const topFill = Math.max(0, innerW - langLabelLen);
    let out = muted('╭─') + langLabel + muted('─'.repeat(topFill) + '╮') + '\n';

    for (const codeLine of lines) {
      const trimmed = codeLine.trimEnd();
      const truncated = this.truncateToWidth(trimmed, innerW - 2);
      const padded = truncated + ' '.repeat(Math.max(0, innerW - 2 - stringWidth(truncated)));
      out += muted('│ ') + chalk.white(padded) + muted(' │') + '\n';
    }

    out += muted('╰' + '─'.repeat(innerW) + '╯');
    return out;
  }

  private truncateToWidth(s: string, maxW: number): string {
    if (stringWidth(s) <= maxW) return s;
    let out = '';
    let w = 0;
    for (const ch of s) {
      const cw = stringWidth(ch);
      if (w + cw > maxW - 1) break;
      out += ch;
      w += cw;
    }
    return out + '…';
  }

  private isTableRow(line: string): boolean {
    const t = line.trimEnd();
    return t.startsWith('|') && t.endsWith('|') && t.length > 2;
  }

  private isTableSeparator(line: string): boolean {
    const t = line.trimEnd();
    if (!t.startsWith('|') || !t.endsWith('|')) return false;
    const cells = t.slice(1, -1).split('|');
    return cells.every(c => /^:?-+:?$/.test(c.trim()));
  }

  private parseTableRow(row: string): string[] {
    return row.trimEnd().slice(1, -1).split('|').map(c => c.trim());
  }

  private renderTable(rows: string[]): string {
    const headerRaw = this.parseTableRow(rows[0]);
    const dataRaw = rows.slice(2).map(r => this.parseTableRow(r));

    const header = headerRaw.map(c => this.renderInline(c));
    const data = dataRaw.map(row => row.map(c => this.renderInline(c)));

    const colCount = header.length;
    const widths: number[] = [];
    for (let i = 0; i < colCount; i++) {
      let maxW = stringWidth(header[i]);
      for (const row of data) {
        const w = stringWidth(row[i] ?? '');
        if (w > maxW) maxW = w;
      }
      widths.push(Math.max(maxW, 3));
    }

    const pad = (s: string, w: number): string => {
      const visual = stringWidth(s);
      return s + ' '.repeat(Math.max(0, w - visual));
    };

    const sep = muted(' │ ');
    let out = '';

    out += muted('┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐') + '\n';
    out += muted('│ ') + header.map((c, i) => chalk.bold(pad(c, widths[i]))).join(sep) + muted(' │') + '\n';
    out += muted('├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤') + '\n';

    for (const row of data) {
      const cells = [];
      for (let i = 0; i < colCount; i++) {
        cells.push(pad(row[i] ?? '', widths[i]));
      }
      out += muted('│ ') + cells.join(sep) + muted(' │') + '\n';
    }

    out += muted('└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘');
    return out;
  }
}
