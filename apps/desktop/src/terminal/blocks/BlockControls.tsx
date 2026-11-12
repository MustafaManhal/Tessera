// The gutter's pointer controls (FR-15): hovering a block's dot shows a small toolbar (copy command, copy output,
// re-run, collapse, more); a right click on the dot (or "more") opens the block menu, which also lists the disabled
// "Send to agent" (M6.7). Every entry is also a palette action with a shortcut (registry, group "terminal").
// The re-run confirmation lives here too.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  getPlatform,
  IconButton,
  Icons,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  t,
} from "@tessera/ui";
import { runAction } from "../../actions/registry";
import { isFinished, outputLineCount } from "@tessera/term";
import { type RefObject, useEffect, useRef, useState } from "react";
import { primaryShortcut } from "../../actions/registry";
import type { BlockApi } from "./api";
import { type BlockController, describeBlock } from "./controller";
import type { RerunQuestion } from "./useBlocks";

const HIDE_AFTER_MS = 250;

interface Props {
  controller: BlockController | null;
  api: BlockApi | null;
  container: RefObject<HTMLDivElement | null>;
  rerunAsk: RerunQuestion | null;
  onRerunAnswer: (run: boolean) => void;
}

interface Hover {
  id: number;
  top: number;
  left: number;
}

export function BlockControls({ controller, api, container, rerunAsk, onRerunAnswer }: Props) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const [, setVersion] = useState(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const platform = getPlatform();
  const shortcut = (id: string) => primaryShortcut(id, platform);

  useEffect(() => {
    if (!controller) return;
    const cancelHide = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = null;
    };
    const stop = controller.onEvent((event) => {
      if (event.type === "change") setVersion((value) => value + 1);
      else if (event.type === "hover") {
        if (event.id === null || !event.rect) {
          cancelHide();
          hideTimer.current = setTimeout(() => setHover(null), HIDE_AFTER_MS);
          return;
        }
        cancelHide();
        const box = container.current?.getBoundingClientRect();
        if (!box) return;
        setHover({ id: event.id, top: event.rect.top - box.top, left: event.rect.right - box.left + 4 });
      } else if (event.type === "menu") {
        const box = container.current?.getBoundingClientRect();
        if (!box) return;
        setHover(null);
        setMenu({ id: event.id, x: event.x - box.left, y: event.y - box.top });
      }
    });
    return () => {
      stop();
      cancelHide();
    };
  }, [controller, container]);

  const hovered = hover && api ? api.block(hover.id) : null;
  const menuBlock = menu && api ? api.block(menu.id) : null;

  const keepOpen = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const closeSoon = () => {
    keepOpen();
    hideTimer.current = setTimeout(() => setHover(null), HIDE_AFTER_MS);
  };

  return (
    <>
      {hover && hovered && api && (
        <div
          role="toolbar"
          aria-label={t("block.actions")}
          data-block-toolbar={hover.id}
          className="absolute z-20 flex items-center gap-0.5 rounded-md border border-border bg-surface-3 p-0.5 shadow-popover"
          style={{ top: Math.max(0, hover.top - 6), left: hover.left }}
          onPointerEnter={keepOpen}
          onPointerLeave={closeSoon}
        >
          <span className="max-w-64 truncate px-1.5 text-sm text-muted">{describeBlock(hovered)}</span>
          <IconButton
            size="sm"
            icon={Icons.SquareChevronRight}
            label={t("action.block.copyCommand")}
            shortcut={shortcut("block.copyCommand")}
            disabled={!api.commandText(hover.id)}
            onClick={() => void api.copyCommand(hover.id)}
          />
          <IconButton
            size="sm"
            icon={Icons.Copy}
            label={t("action.block.copyOutput")}
            shortcut={shortcut("block.copyOutput")}
            disabled={outputLineCount(hovered) === 0}
            onClick={() => void api.copyOutput(hover.id)}
          />
          <IconButton
            size="sm"
            icon={Icons.RotateCw}
            label={t("action.block.rerun")}
            shortcut={shortcut("block.rerun")}
            disabled={!api.commandText(hover.id) || !isFinished(hovered)}
            onClick={() => api.rerun(hover.id)}
          />
          <IconButton
            size="sm"
            icon={hovered.collapsed ? Icons.ChevronsUpDown : Icons.ChevronsDownUp}
            label={t(hovered.collapsed ? "action.block.expand" : "action.block.collapse")}
            shortcut={shortcut("block.collapse")}
            disabled={!isFinished(hovered) || outputLineCount(hovered) === 0}
            onClick={() => api.toggleCollapsed(hover.id)}
          />
          <IconButton
            size="sm"
            icon={Icons.Ellipsis}
            label={t("block.actions")}
            onClick={(event) => {
              const box = container.current?.getBoundingClientRect();
              const rect = event.currentTarget.getBoundingClientRect();
              setHover(null);
              if (box) setMenu({ id: hover.id, x: rect.left - box.left, y: rect.bottom - box.top });
            }}
          />
        </div>
      )}
      <Menu open={menuBlock !== null} onOpenChange={(open) => !open && setMenu(null)}>
        <MenuTrigger asChild>
          <span aria-hidden className="pointer-events-none absolute size-px" style={{ left: menu?.x, top: menu?.y }} />
        </MenuTrigger>
        {menuBlock && api && (
          <MenuContent align="start" data-block-menu={menuBlock.id}>
            <MenuItem
              icon={Icons.SquareChevronRight}
              shortcut={shortcut("block.copyCommand")}
              disabled={!api.commandText(menuBlock.id)}
              onSelect={() => void api.copyCommand(menuBlock.id)}
            >
              {t("action.block.copyCommand")}
            </MenuItem>
            <MenuItem
              icon={Icons.Copy}
              shortcut={shortcut("block.copyOutput")}
              disabled={outputLineCount(menuBlock) === 0}
              onSelect={() => void api.copyOutput(menuBlock.id)}
            >
              {t("action.block.copyOutput")}
            </MenuItem>
            <MenuItem
              icon={Icons.TextCursorInput}
              shortcut={shortcut("block.selectCommand")}
              disabled={menuBlock.commandLine === null}
              onSelect={() => api.selectCommand(menuBlock.id)}
            >
              {t("action.block.selectCommand")}
            </MenuItem>
            <MenuItem
              icon={Icons.TextSelect}
              shortcut={shortcut("block.selectOutput")}
              disabled={outputLineCount(menuBlock) === 0}
              onSelect={() => api.selectOutput(menuBlock.id)}
            >
              {t("action.block.selectOutput")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Icons.RotateCw}
              shortcut={shortcut("block.rerun")}
              disabled={!api.commandText(menuBlock.id) || !isFinished(menuBlock)}
              onSelect={() => api.rerun(menuBlock.id)}
            >
              {t("action.block.rerun")}
            </MenuItem>
            <MenuItem
              icon={menuBlock.collapsed ? Icons.ChevronsUpDown : Icons.ChevronsDownUp}
              shortcut={shortcut("block.collapse")}
              disabled={!isFinished(menuBlock) || outputLineCount(menuBlock) === 0}
              onSelect={() => api.toggleCollapsed(menuBlock.id)}
            >
              {t(menuBlock.collapsed ? "action.block.expand" : "action.block.collapse")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Icons.Bot}
              shortcut={shortcut("block.sendToAgent")}
              disabled={!isFinished(menuBlock)}
              onSelect={() => runAction("block.sendToAgent")}
            >
              {t("action.block.sendToAgent")}
            </MenuItem>
          </MenuContent>
        )}
      </Menu>
      <Dialog open={rerunAsk !== null} onOpenChange={(open) => !open && onRerunAnswer(false)}>
        {rerunAsk && (
          <DialogContent hideClose role="alertdialog" onCloseAutoFocus={(event) => event.preventDefault()}>
            <DialogTitle>{t("block.rerun.title")}</DialogTitle>
            <DialogDescription>
              {[
                rerunAsk.long ? t("block.rerun.long", { duration: rerunAsk.long }) : null,
                rerunAsk.lines > 1 ? t("block.rerun.multiline", { count: rerunAsk.lines }) : null,
              ]
                .filter(Boolean)
                .join(" ")}
            </DialogDescription>
            <pre className="max-h-40 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-sm whitespace-pre-wrap break-all">
              {rerunAsk.command}
            </pre>
            <DialogFooter>
              <Button onClick={() => onRerunAnswer(false)}>{t("confirm.cancel")}</Button>
              <Button variant="primary" icon={Icons.RotateCw} onClick={() => onRerunAnswer(true)}>
                {t("block.rerun.run")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
