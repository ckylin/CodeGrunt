import React, { useState, useEffect } from 'react';
import { Box, Static, Text, render } from 'ink';
import { PromptInput } from './PromptInput.js';
import { StatusBar } from './StatusBar.js';
import { ListPicker } from './ListPicker.js';
import {
  registerSink, unregisterSink, registerPickerHandler, unregisterPickerHandler,
} from './output-channel.js';
import type { LiveToolInfo, OutputChannelSink, PickerHandler } from './output-channel.js';
import type { InputResult, Skill, SelectorItem } from './types.js';

// ── Imperative facade over the persistent Ink tree ───────────────────────
// repl.ts's main loop is a plain imperative `while (true) { await ...; ... }`
// async loop — rewriting it into a React state machine was explicitly out of
// scope (a much larger change than "keep the input mounted while the agent
// runs"). This module bridges the two: mountApp() renders the tree exactly
// once for the whole session and returns an AppHandle whose promptForInput()
// resolves the same way the old per-turn render()/unmount() cycle used to,
// but without ever tearing the tree down.
//
// The bridge works through a small set of mutable closures captured when
// <Root> mounts (state setters, a pending-promise resolver) rather than refs
// threaded through props — simpler to reason about since there's exactly one
// <Root> instance for the process's whole lifetime, so "the closures were
// captured once and never go stale" is trivially true.

let historySeq = 0;
interface HistoryEntry {
  id: number;
  text: string;
}

interface AppProps {
  cwd: string;
  model: string;
  gitBranch: string | null;
  skills: Skill[];
  activeSkill?: string;
  showMeta: boolean;
  onReady: (bridge: RootBridge) => void;
}

interface RootBridge {
  setBusy(busy: boolean): void;
  setTotalTokens(tokens: number): void;
  setOnCancelBusy(handler: (() => void) | null): void;
  setOnSubmit(handler: (result: InputResult) => void): void;
}

interface ActivePicker {
  title: string;
  items: SelectorItem[];
  currentValue?: string;
  resolve: (value: string | null) => void;
}

function App({ cwd, model, gitBranch, skills, activeSkill, showMeta, onReady }: AppProps): React.ReactElement {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [liveText, setLiveText] = useState('');
  const [liveTool, setLiveTool] = useState<LiveToolInfo | null>(null);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [onCancelBusy, setOnCancelBusy] = useState<(() => void) | null>(null);
  const [onSubmitHandler, setOnSubmitHandler] = useState<((result: InputResult) => void) | null>(null);
  const [activePicker, setActivePicker] = useState<ActivePicker | null>(null);

  useEffect(() => {
    const sink: OutputChannelSink = {
      writeLine: (text) => {
        setHistory((prev) => [...prev, { id: historySeq++, text }]);
      },
      setLiveText,
      setLiveTool,
    };
    registerSink(sink);
    // See output-channel.ts's "Picker delegation" doc — this is what makes
    // /model, /resume, /restore etc. render their picker INSIDE this
    // persistent tree instead of select.ts calling Ink's render() a second
    // time (which would silently replace this whole tree, not coexist with it).
    const pickerHandler: PickerHandler = (title, items, currentValue) => {
      return new Promise((resolve) => {
        setActivePicker({ title, items, currentValue, resolve });
      });
    };
    registerPickerHandler(pickerHandler);
    onReady({
      setBusy: (busy) => setBusySince(busy ? Date.now() : null),
      setTotalTokens,
      setOnCancelBusy: (handler) => setOnCancelBusy(() => handler),
      setOnSubmit: (handler) => setOnSubmitHandler(() => handler),
    });
    return () => {
      unregisterSink();
      unregisterPickerHandler();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ticks the visible "Ns" elapsed counter while busy. Restarts cleanly
  // whenever busySince changes (including transitioning to null, which just
  // clears the interval via the effect cleanup and never reschedules).
  useEffect(() => {
    if (busySince === null) return undefined;
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - busySince) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [busySince]);

  const handleSubmit = (result: InputResult): void => {
    if (result.text) {
      setHistory((prev) => [...prev, { id: historySeq++, text: `> ${result.text}` }]);
    }
    onSubmitHandler?.(result);
  };

  const handlePickerSubmit = (value: string | null): void => {
    activePicker?.resolve(value);
    setActivePicker(null);
  };

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(entry) => <Text key={entry.id}>{entry.text}</Text>}
      </Static>
      {liveTool && (
        <Text dimColor>{`  ${liveTool.frame} ${liveTool.name}  ${liveTool.argPreview}`}</Text>
      )}
      {liveText && <Text>{liveText}</Text>}
      <StatusBar
        model={model}
        gitBranch={gitBranch}
        totalTokens={totalTokens}
        busySince={busySince}
        elapsedSeconds={elapsedSeconds}
      />
      {activePicker ? (
        // A picker (from /model, /resume, /restore, ...) replaces the
        // prompt entirely while active — matches the pre-existing UX where
        // selectFromList's own render() briefly took over the whole
        // terminal instead of showing the prompt underneath.
        <ListPicker
          title={activePicker.title}
          items={activePicker.items}
          currentValue={activePicker.currentValue}
          onSubmit={handlePickerSubmit}
        />
      ) : (
        <PromptInput
          cwd={cwd}
          model={model}
          skills={skills}
          activeSkill={activeSkill}
          showMeta={showMeta}
          busy={busySince !== null}
          onCancelBusy={() => onCancelBusy?.()}
          onSubmit={handleSubmit}
        />
      )}
    </Box>
  );
}

export interface AppHandle {
  /** Resolves the next time the user submits (or cancels) input, exactly
   *  like the old readMultilineInput()'s returned promise. */
  promptForInput(): Promise<InputResult>;
  /** Marks the input as busy/idle — drives PromptInput's dimmed rendering
   *  and the status bar's elapsed-time display. */
  setBusy(busy: boolean): void;
  /** Registers the callback invoked when the user presses Esc/Ctrl+C while
   *  busy — the caller wires this to its InterruptController's abort(). */
  onCancelBusy(handler: () => void): void;
  /** Updates the token count shown in the status bar. */
  setTotalTokens(tokens: number): void;
  unmount(): void;
}

export interface MountAppOptions {
  cwd: string;
  model: string;
  gitBranch: string | null;
  skills: Skill[];
  activeSkill?: string;
  showMeta: boolean;
  /** Injectable for tests — ink-testing-library's render() has the same
   *  signature (React.ReactElement, RenderOptions) => { unmount }, so a test
   *  can pass it here to drive <App> against a fake stdin/stdout instead of
   *  the real process streams mountApp uses by default. */
  renderFn?: typeof render;
}

export function mountApp(props: MountAppOptions): AppHandle {
  const doRender = props.renderFn ?? render;
  let bridge: RootBridge | null = null;
  let pendingResolve: ((result: InputResult) => void) | null = null;

  const instance = doRender(
    <App
      cwd={props.cwd}
      model={props.model}
      gitBranch={props.gitBranch}
      skills={props.skills}
      activeSkill={props.activeSkill}
      showMeta={props.showMeta}
      onReady={(b) => {
        bridge = b;
        bridge.setOnSubmit((result) => {
          const resolve = pendingResolve;
          pendingResolve = null;
          resolve?.(result);
        });
      }}
    />,
    { exitOnCtrlC: false },
  );

  return {
    promptForInput(): Promise<InputResult> {
      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    },
    setBusy(busy: boolean): void {
      bridge?.setBusy(busy);
    },
    onCancelBusy(handler: () => void): void {
      bridge?.setOnCancelBusy(handler);
    },
    setTotalTokens(tokens: number): void {
      bridge?.setTotalTokens(tokens);
    },
    unmount(): void {
      unregisterSink();
      unregisterPickerHandler();
      instance.unmount();
    },
  };
}
