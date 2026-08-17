import type { Skill } from '../skills.js';
import type { SelectorItem } from '../../utils/select.js';

export type { Skill, SelectorItem };

export interface InputResult {
  text: string;
  cancelled: boolean;
}

export interface DropdownItem {
  value: string;
  label: string;
  desc?: string;
  kind?: 'builtin' | 'skill' | 'file';
}

export interface PromptInputProps {
  cwd: string;
  model?: string;
  skills: Skill[];
  activeSkill?: string;
  showMeta: boolean;
  onSubmit: (result: InputResult) => void;
  /** True while an agent turn is running. The input stays mounted (visually
   *  dimmed) instead of unmounting — see the output-channel.ts module doc
   *  for why that used to be impossible. Typed text and cursor position are
   *  preserved; submission is blocked; Esc still fires (via onCancelBusy)
   *  so the user can interrupt without losing whatever they'd started typing
   *  for their NEXT message. */
  busy?: boolean;
  /** Called when Esc is pressed while busy — the parent owns interrupting
   *  the actual agent run; this component only reports the keypress. */
  onCancelBusy?: () => void;
}

export interface DropdownProps {
  items: DropdownItem[];
  selectedIndex: number;
  visible: boolean;
}

export interface ListPickerProps {
  title: string;
  items: SelectorItem[];
  currentValue?: string;
  onSubmit: (value: string | null) => void;
}
