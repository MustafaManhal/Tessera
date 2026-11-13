// Dev-only component gallery (`/?gallery`, dev builds only): every base component in every state, in light, dark or
// the system theme, so reviewers can check them. Sample text lives in `demo` below on purpose: it is not product
// copy, so it stays out of the string catalog.
import {
  Button,
  type ButtonVariant,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  IconButton,
  Icons,
  Input,
  Kbd,
  Select,
  StatusPill,
  Switch,
  statuses,
  Tooltip,
  useToast,
} from "@tessera/ui";
import { type ReactNode, useEffect, useId, useState } from "react";

const demo = {
  title: "Component gallery",
  subtitle: "Design tokens and base components (03-UI-UX §2, §4). Dev builds only.",
  theme: "Theme",
  themes: { system: "System", light: "Light", dark: "Dark" },
  sections: {
    colours: "Colour roles",
    type: "Typography",
    spacing: "Spacing and radius",
    button: "Button",
    iconButton: "IconButton",
    tooltip: "Tooltip",
    kbd: "Kbd",
    input: "Input",
    switch: "Switch",
    select: "Select",
    dialog: "Dialog",
    toast: "Toast",
    status: "StatusPill",
    empty: "EmptyState",
  },
  states: {
    default: "Default",
    disabled: "Disabled",
    loading: "Loading",
    withIcon: "With icon",
    long: "Long label (truncates)",
    selectedRow: "On a selected row (--surface-3)",
    customLabel: "Custom label",
    mac: "macOS",
    windows: "Windows",
  },
  button: { label: "Start agent", long: "Start the agent in a new worktree and open the review panel" },
  iconButtons: { sidebar: "Toggle sidebar", search: "Search", settings: "Settings", newTab: "New tab" },
  tooltip: { plain: "Hover or focus me", plainTip: "Tooltips show on hover and keyboard focus" },
  input: {
    name: "Task name",
    namePlaceholder: "fix-login",
    branch: "Branch",
    branchValue: "tessera/fix-login",
    branchError: "Branch tessera/fix-login already exists. Rename the task or delete the old branch.",
    disabled: "Disabled field",
    disabledValue: "Can't edit this",
  },
  switch: {
    off: "Notifications",
    on: "Start on login",
    disabledOff: "Sync (signed out)",
    disabledOn: "Telemetry (locked)",
  },
  select: {
    agent: "Agent",
    agentPlaceholder: "Choose an agent",
    shell: "Shell",
    disabled: "Disabled select",
    invalid: "Model",
    invalidError: "Pick a model to continue.",
    options: [
      { value: "codex", label: "codex" },
      { value: "claude", label: "claude" },
      { value: "gemini", label: "gemini" },
      { value: "aider", label: "aider (not installed)", disabled: true },
      { value: "long", label: "an agent with a very long name that should truncate in the trigger" },
    ],
    shells: [
      { value: "zsh", label: "zsh" },
      { value: "bash", label: "bash" },
      { value: "pwsh", label: "PowerShell" },
    ],
  },
  dialog: {
    open: "Open dialog",
    title: "New task",
    description: "Start an agent in its own worktree.",
    cancel: "Cancel",
    create: "Create task",
    danger: "Delete task…",
    dangerTitle: "Delete fix-login?",
    dangerDescription: "2 commits not merged will be lost.",
    dangerConfirm: "Delete",
  },
  toast: {
    info: "Info",
    success: "Success",
    error: "Error",
    undo: "With undo",
    three: "Three at once",
    infoTitle: "codex is waiting for your approval in fix-login",
    successTitle: "Pull request #42 opened",
    errorTitle: "Couldn't create the worktree",
    errorDescription: "Branch tessera/fix-login already exists. Rename the task or delete the old branch.",
    errorDetails: "fatal: a branch named 'tessera/fix-login' already exists\nexit code 128",
    undoTitle: "Archived fix-login",
    undoneTitle: "Restored fix-login",
  },
  status: { custom: "Needs you · 2" },
  empty: { message: "No tasks yet.", action: "New task" },
} as const;

type ThemeChoice = keyof typeof demo.themes;

function applyTheme(theme: ThemeChoice) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function initialTheme(): ThemeChoice {
  const param = new URLSearchParams(window.location.search).get("theme");
  return param === "light" || param === "dark" ? param : "system";
}

function Section({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn("flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4", className)}
    >
      <h2 id={`${id}-title`} className="text-sm font-semibold text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label && <span className="text-xs text-muted">{label}</span>}
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const colourRoles = [
  ["bg", "bg-bg"],
  ["surface", "bg-surface"],
  ["surface-2", "bg-surface-2"],
  ["surface-3", "bg-surface-3"],
  ["border", "bg-border"],
  ["border-strong", "bg-border-strong"],
  ["text", "bg-fg"],
  ["text-muted", "bg-muted"],
  ["accent", "bg-accent"],
  ["danger", "bg-danger"],
  ["success", "bg-success"],
  ["warning", "bg-warning"],
] as const;

const spacing = [
  ["2", "w-0.5"],
  ["4", "w-1"],
  ["6", "w-1.5"],
  ["8", "w-2"],
  ["12", "w-3"],
  ["16", "w-4"],
  ["20", "w-5"],
  ["24", "w-6"],
  ["32", "w-8"],
] as const;

const radii = [
  ["sm 4", "rounded-sm"],
  ["md 6", "rounded-md"],
  ["lg 8", "rounded-lg"],
  ["xl 12", "rounded-xl"],
] as const;

const variants: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
const shortcuts = ["Mod+Shift+P", "Mod+K", "Ctrl+Alt+Enter", "Mod+Shift+Backspace", "Alt+ArrowUp", "Escape"];

export default function Gallery() {
  const [theme, setTheme] = useState<ThemeChoice>(initialTheme);
  const [agent, setAgent] = useState("codex");
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const { toast } = useToast();
  const ids = useId();

  useEffect(() => applyTheme(theme), [theme]);

  const showError = () =>
    toast({
      kind: "error",
      title: demo.toast.errorTitle,
      description: demo.toast.errorDescription,
      details: demo.toast.errorDetails,
    });
  const showUndo = () =>
    toast({ title: demo.toast.undoTitle, onUndo: () => toast({ kind: "success", title: demo.toast.undoneTitle }) });

  return (
    <div className="min-h-full bg-bg text-fg">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{demo.title}</h1>
          <p className="text-base text-muted">{demo.subtitle}</p>
        </div>
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">{demo.theme}</legend>
          <span aria-hidden className="text-sm text-muted">
            {demo.theme}
          </span>
          {(Object.keys(demo.themes) as ThemeChoice[]).map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant={theme === choice ? "primary" : "secondary"}
              aria-pressed={theme === choice}
              data-theme-choice={choice}
              onClick={() => setTheme(choice)}
            >
              {demo.themes[choice]}
            </Button>
          ))}
        </fieldset>
      </header>

      <main className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-4 p-6">
        <Section id="colours" title={demo.sections.colours}>
          <div className="grid grid-cols-2 gap-2">
            {colourRoles.map(([name, swatch]) => (
              <div key={name} className="flex min-w-0 items-center gap-2">
                <span className={cn("size-5 shrink-0 rounded-sm border border-border", swatch)} />
                <code className="truncate font-mono text-xs">--{name}</code>
              </div>
            ))}
          </div>
        </Section>

        <Section id="type" title={demo.sections.type}>
          <p className="text-xl font-semibold">xl 20 · semibold</p>
          <p className="text-lg font-medium">lg 15 · medium</p>
          <p className="text-base">base 13 · regular</p>
          <p className="text-sm text-muted">sm 12 · muted</p>
          <p className="text-xs text-muted">xs 11 · muted</p>
          <p className="font-mono text-base leading-term">mono · ~/shop-api $ git status</p>
        </Section>

        <Section id="spacing" title={demo.sections.spacing}>
          <div className="flex flex-col gap-1">
            {spacing.map(([px, width]) => (
              <div key={px} className="flex items-center gap-2">
                <span className="w-6 text-end text-xs text-muted">{px}</span>
                <span className={cn("h-2 rounded-sm bg-accent", width)} />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            {radii.map(([name, radius]) => (
              <div key={name} className="flex flex-col items-center gap-1">
                <span className={cn("size-10 border border-border-strong bg-surface-2", radius)} />
                <span className="text-xs text-muted">{name}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section id="button" title={demo.sections.button} className="sm:col-span-2">
          {(["md", "sm"] as const).map((size) => (
            <Row key={size} label={`${demo.states.default} · ${size}`}>
              {variants.map((variant) => (
                <Button key={variant} variant={variant} size={size}>
                  {variant}
                </Button>
              ))}
            </Row>
          ))}
          <Row label={demo.states.withIcon}>
            <Button variant="primary" icon={Icons.Plus}>
              {demo.button.label}
            </Button>
            <Button icon={Icons.SquareTerminal}>{demo.button.label}</Button>
            <Button variant="danger" icon={Icons.Trash2} size="sm">
              {variants[3]}
            </Button>
          </Row>
          <Row label={demo.states.disabled}>
            {variants.map((variant) => (
              <Button key={variant} variant={variant} disabled>
                {variant}
              </Button>
            ))}
          </Row>
          <Row label={demo.states.loading}>
            {variants.map((variant) => (
              <Button key={variant} variant={variant} loading>
                {variant}
              </Button>
            ))}
          </Row>
          <Row label={demo.states.long}>
            <div className="w-56 max-w-full">
              <Button variant="primary" icon={Icons.Plus}>
                {demo.button.long}
              </Button>
            </div>
          </Row>
        </Section>

        <Section id="icon-button" title={demo.sections.iconButton}>
          <Row label="ghost · md">
            <IconButton icon={Icons.PanelLeft} label={demo.iconButtons.sidebar} shortcut="Mod+B" />
            <IconButton icon={Icons.Search} label={demo.iconButtons.search} shortcut="Mod+K" />
            <IconButton icon={Icons.Settings} label={demo.iconButtons.settings} shortcut="Mod+," />
          </Row>
          <Row label="secondary · sm">
            <IconButton
              icon={Icons.Plus}
              label={demo.iconButtons.newTab}
              shortcut="Mod+T"
              variant="secondary"
              size="sm"
            />
            <IconButton icon={Icons.Search} label={demo.iconButtons.search} variant="secondary" size="sm" />
          </Row>
          <Row label={demo.states.disabled}>
            <IconButton icon={Icons.Settings} label={demo.iconButtons.settings} disabled />
            <IconButton icon={Icons.Plus} label={demo.iconButtons.newTab} variant="secondary" disabled />
          </Row>
        </Section>

        <Section id="tooltip" title={demo.sections.tooltip}>
          <Row>
            <Tooltip label={demo.tooltip.plainTip}>
              <Button>{demo.tooltip.plain}</Button>
            </Tooltip>
            <Tooltip label={demo.iconButtons.search} shortcut="Mod+Shift+P">
              <Button icon={Icons.Search}>{demo.iconButtons.search}</Button>
            </Tooltip>
          </Row>
        </Section>

        <Section id="kbd" title={demo.sections.kbd}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <span className="text-xs text-muted">{demo.states.mac}</span>
            <span className="text-xs text-muted">{demo.states.windows}</span>
            {shortcuts.map((shortcut) => (
              <div key={shortcut} className="contents">
                <span>
                  <Kbd shortcut={shortcut} platform="mac" />
                </span>
                <span>
                  <Kbd shortcut={shortcut} platform="windows" />
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section id="input" title={demo.sections.input}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-name`} className="text-sm font-medium">
              {demo.input.name}
            </label>
            <Input id={`${ids}-name`} placeholder={demo.input.namePlaceholder} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-branch`} className="text-sm font-medium">
              {demo.input.branch}
            </label>
            <Input
              id={`${ids}-branch`}
              defaultValue={demo.input.branchValue}
              invalid
              aria-describedby={`${ids}-branch-error`}
            />
            <p id={`${ids}-branch-error`} className="text-sm text-danger">
              {demo.input.branchError}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-disabled`} className="text-sm font-medium">
              {demo.input.disabled}
            </label>
            <Input id={`${ids}-disabled`} defaultValue={demo.input.disabledValue} disabled />
          </div>
        </Section>

        <Section id="switch" title={demo.sections.switch}>
          {(
            [
              ["off", demo.switch.off, off, setOff, false],
              ["on", demo.switch.on, on, setOn, false],
              ["disabled-off", demo.switch.disabledOff, false, undefined, true],
              ["disabled-on", demo.switch.disabledOn, true, undefined, true],
            ] as const
          ).map(([key, label, checked, setChecked, disabled]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <label htmlFor={`${ids}-${key}`} className={cn("text-base", disabled && "text-muted")}>
                {label}
              </label>
              <Switch id={`${ids}-${key}`} checked={checked} onCheckedChange={setChecked} disabled={disabled} />
            </div>
          ))}
        </Section>

        <Section id="select" title={demo.sections.select}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-agent`} className="text-sm font-medium">
              {demo.select.agent}
            </label>
            <Select id={`${ids}-agent`} options={demo.select.options} value={agent} onValueChange={setAgent} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-shell`} className="text-sm font-medium">
              {demo.select.shell}
            </label>
            <Select id={`${ids}-shell`} options={demo.select.shells} placeholder={demo.select.agentPlaceholder} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-model`} className="text-sm font-medium">
              {demo.select.invalid}
            </label>
            <Select id={`${ids}-model`} options={demo.select.shells} invalid aria-describedby={`${ids}-model-error`} />
            <p id={`${ids}-model-error`} className="text-sm text-danger">
              {demo.select.invalidError}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-select-disabled`} className="text-sm font-medium text-muted">
              {demo.select.disabled}
            </label>
            <Select id={`${ids}-select-disabled`} options={demo.select.shells} defaultValue="zsh" disabled />
          </div>
        </Section>

        <Section id="dialog" title={demo.sections.dialog}>
          <Row>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="primary" icon={Icons.Plus}>
                  {demo.dialog.open}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>{demo.dialog.title}</DialogTitle>
                <DialogDescription>{demo.dialog.description}</DialogDescription>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${ids}-dialog-name`} className="text-sm font-medium">
                    {demo.input.name}
                  </label>
                  <Input id={`${ids}-dialog-name`} placeholder={demo.input.namePlaceholder} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${ids}-dialog-agent`} className="text-sm font-medium">
                    {demo.select.agent}
                  </label>
                  <Select id={`${ids}-dialog-agent`} options={demo.select.options} defaultValue="codex" />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor={`${ids}-dialog-switch`} className="text-base">
                    {demo.switch.on}
                  </label>
                  <Switch id={`${ids}-dialog-switch`} defaultChecked />
                </div>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button>{demo.dialog.cancel}</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button variant="primary">{demo.dialog.create}</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="danger" icon={Icons.Trash2}>
                  {demo.dialog.danger}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>{demo.dialog.dangerTitle}</DialogTitle>
                <DialogDescription>{demo.dialog.dangerDescription}</DialogDescription>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button>{demo.dialog.cancel}</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button variant="danger">{demo.dialog.dangerConfirm}</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </Row>
        </Section>

        <Section id="toast" title={demo.sections.toast}>
          <Row>
            <Button onClick={() => toast({ title: demo.toast.infoTitle })}>{demo.toast.info}</Button>
            <Button onClick={() => toast({ kind: "success", title: demo.toast.successTitle })}>
              {demo.toast.success}
            </Button>
            <Button onClick={showError}>{demo.toast.error}</Button>
            <Button onClick={showUndo}>{demo.toast.undo}</Button>
            <Button
              variant="primary"
              onClick={() => {
                toast({ title: demo.toast.infoTitle });
                showUndo();
                showError();
              }}
            >
              {demo.toast.three}
            </Button>
          </Row>
        </Section>

        <Section id="status" title={demo.sections.status}>
          <Row>
            {statuses.map((status) => (
              <StatusPill key={status} status={status} />
            ))}
          </Row>
          <Row label={demo.states.selectedRow}>
            <div className="flex flex-wrap gap-2 rounded-md bg-surface-3 p-2">
              {statuses.map((status) => (
                <StatusPill key={status} status={status} />
              ))}
            </div>
          </Row>
          <Row label={demo.states.customLabel}>
            <StatusPill status="needs" label={demo.status.custom} />
          </Row>
        </Section>

        <Section id="empty" title={demo.sections.empty}>
          <div className="rounded-md border border-border">
            <EmptyState
              icon={Icons.Inbox}
              message={demo.empty.message}
              action={{
                label: demo.empty.action,
                icon: Icons.Plus,
                onClick: () => toast({ title: demo.empty.action }),
              }}
            />
          </div>
        </Section>
      </main>
    </div>
  );
}
