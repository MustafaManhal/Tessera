// The pane's BlockController and the BlockApi over it (copy, re-run with its confirmation, gutter toggle), plus the
// long-command alert when a block ends (FR-18).
import type { Block, TerminalEngine } from "@tessera/term";
import { t } from "@tessera/ui";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { isPaneVisible, type PaneId } from "../../layout";
import { notifications } from "../../notify";
import { longCommandAlert } from "../../notify/alerts";
import { store } from "../../store";
import { useAppDispatch } from "../../store/hooks";
import type { TerminalSettings } from "../../store/settingsSlice";
import { announce } from "../../store/uiSlice";
import { writeClipboard } from "../clipboard";
import type { BlockApi } from "./api";
import { BlockController } from "./controller";

export interface RerunQuestion {
  id: number;
  command: string;
  long: string | null;
  lines: number;
}

interface Options {
  engine: TerminalEngine | null;
  host: RefObject<HTMLDivElement | null>;
  paneId: PaneId;
  settings: RefObject<TerminalSettings>;
  cwd: () => string | null;
  write: (text: string) => void;
  onRunningProcessChange: (process: string | null) => void;
}

function paneFocused(paneId: PaneId): boolean {
  const { layout } = store.getState();
  const tab = layout.tabs.find((candidate) => candidate.id === layout.activeTab);
  return tab?.focusedPane === paneId && isPaneVisible(layout, paneId);
}

export function useBlocks({ engine, host, paneId, settings, cwd, write, onRunningProcessChange }: Options) {
  const dispatch = useAppDispatch();
  const [controller, setController] = useState<BlockController | null>(null);
  const [rerunAsk, setRerunAsk] = useState<RerunQuestion | null>(null);
  /** Per-pane override of `terminal.block_gutter` (the "Show/Hide command blocks" action). */
  const [gutterOverride, setGutterOverride] = useState<boolean | null>(null);
  const latest = useRef({ cwd, write, onRunningProcessChange });
  latest.current = { cwd, write, onRunningProcessChange };

  // biome-ignore lint/correctness/useExhaustiveDependencies: one controller per engine; callbacks are read through refs.
  useEffect(() => {
    const element = host.current;
    if (!engine || !element) return;
    const alerted = new Set<number>();
    const created = new BlockController(engine, element, {
      cwd: () => latest.current.cwd(),
      write: (text) => latest.current.write(text),
      onRunningProcessChange: (process) => latest.current.onRunningProcessChange(process),
      trimTrailingWhitespace: () => settings.current.trimTrailingWhitespace,
      onFinished: (block: Block) => {
        const state = store.getState();
        const alert = longCommandAlert({
          block,
          enabled: state.settings.terminal.longCommandAlert,
          thresholdSeconds: state.settings.terminal.longCommandSeconds,
          paneFocused: paneFocused(paneId),
          windowFocused: state.ui.windowFocused,
          alerted,
        });
        if (!alert) return;
        alerted.add(block.id);
        notifications().notify({ paneId, title: "", body: alert.body, badge: alert.badge, source: "longCommand" });
      },
    });
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [engine, paneId]);

  const setting = useRef(settings.current.blockGutter);
  setting.current = settings.current.blockGutter;
  const gutter = gutterOverride ?? settings.current.blockGutter;
  useEffect(() => {
    controller?.setGutter(gutter);
  }, [controller, gutter]);

  const api = useMemo((): BlockApi | null => {
    if (!controller || !engine) return null;
    const idOf = (id?: number) => id ?? controller.current()?.id ?? null;
    const run = (id: number) => {
      controller.rerun(id);
      engine.focus();
    };
    return {
      current: () => controller.current(),
      block: (id) => controller.block(id),
      canJump: (direction) => controller.canJump(direction),
      jump: (direction) => {
        controller.jump(direction);
      },
      commandText: (id) => {
        const target = idOf(id);
        return target === null ? null : controller.commandText(target);
      },
      selectCommand: (id) => {
        const target = idOf(id);
        if (target !== null) controller.selectCommand(target);
      },
      selectOutput: (id) => {
        const target = idOf(id);
        if (target !== null) controller.selectOutput(target);
      },
      copyCommand: async (id) => {
        const target = idOf(id);
        const text = target === null ? null : controller.commandText(target);
        if (!text) return;
        await writeClipboard(text);
        dispatch(announce(t("block.copiedCommand")));
      },
      copyOutput: async (id) => {
        const target = idOf(id);
        if (target === null) return;
        let lines = 0;
        const text = controller.outputText(target).then((output) => {
          lines = output?.result.lines ?? 0;
          return output?.text ?? "";
        });
        await writeClipboard(text);
        dispatch(announce(t("block.copiedOutput", { count: lines.toLocaleString() })));
      },
      outputText: async (id) => {
        const target = idOf(id);
        if (target === null) return null;
        const output = await controller.outputText(target);
        return output ? { text: output.text } : null;
      },
      rerun: (id) => {
        const target = idOf(id);
        if (target === null) return;
        const question = controller.rerunQuestion(target);
        const command = controller.commandText(target);
        if (!command) return;
        if (question) setRerunAsk({ id: target, command, ...question });
        else run(target);
      },
      toggleCollapsed: (id) => {
        const target = idOf(id);
        if (target !== null) controller.toggleCollapsed(target);
      },
      gutterVisible: () => controller.gutterVisible,
      toggleGutter: () => {
        const next = !controller.gutterVisible;
        setGutterOverride(next === setting.current ? null : next);
        dispatch(announce(t(next ? "block.gutterOn" : "block.gutterOff")));
      },
    };
  }, [controller, engine, dispatch]);

  const answerRerun = (runIt: boolean) => {
    const question = rerunAsk;
    setRerunAsk(null);
    if (runIt && question && controller) controller.rerun(question.id);
    engine?.focus();
  };

  return { controller, api, rerunAsk, answerRerun };
}
