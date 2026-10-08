import chalk from 'chalk';
import type { ContextManager } from '../../core/context/manager.js';
import { listSessions, loadSession, formatSessionEntry } from '../../core/session/store.js';
import { selectFromList } from '../../utils/select.js';

type SessionRecord = NonNullable<Awaited<ReturnType<typeof loadSession>>>;

/** The "resumed" status line shared by startup (--resume) and the /resume command. */
export function resumedMessage(session: Pick<SessionRecord, 'title' | 'messageCount'>): string {
  return chalk.gray(`  [session: resumed "${session.title.slice(0, 60)}" — ${session.messageCount} messages]\n`);
}

/**
 * Handle `/resume [id]` (input without the leading slash). With an id it loads that
 * session; without one it offers a picker. Returns the resumed session's id, or
 * undefined when nothing was resumed.
 */
export async function handleResumeCommand(
  trimmed: string,
  cwd: string,
  context: ContextManager,
  write: (text: string) => void,
): Promise<string | undefined> {
  const targetId = trimmed.split(/\s+/)[1];

  if (targetId) {
    const session = await loadSession(targetId);
    if (!session) {
      write(chalk.yellow(`  Session "${targetId}" not found.\n`));
      return undefined;
    }
    context.setMessages(session.messages);
    write(resumedMessage(session));
    return session.id;
  }

  const sessions = await listSessions(cwd);
  if (sessions.length === 0) {
    write(chalk.gray('  No saved sessions for this directory.\n'));
    return undefined;
  }
  const choices = sessions.map(s => ({ label: formatSessionEntry(s), value: s.id }));
  const picked = await selectFromList('Resume session:', choices);
  if (!picked) return undefined;
  const session = await loadSession(picked);
  if (!session) return undefined;
  context.setMessages(session.messages);
  write(resumedMessage(session));
  return session.id;
}
