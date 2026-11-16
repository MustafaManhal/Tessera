# Accessibility and localisation

Goal: WCAG 2.2 AA for the application chrome (NFR-10) and every user-facing word in one catalog (NFR-12).

## What is checked automatically

| Check | Where |
| --- | --- |
| No horizontal overflow at 900, 1280 and 1440 px, light and dark, on the main window and the Settings pages | `audit-ui.mjs` (agent-lead tool), run before release |
| Contrast of rendered text (4.5:1, 3:1 for large text, translucent layers composited) in both themes | same tool; clean on 8 routes |
| Target size of at least 24 x 24 px (WCAG 2.5.8) | same tool; the only remaining hit is xterm's off-screen input helper |
| No literal words in JSX text or in `label`, `title`, `placeholder`, `aria-label`, `alt` | `tests/unit/string-catalog.test.ts` |
| Every `t("key")` names an existing catalog key | same test (and the type checker) |
| Keyboard-only flows: Settings with a focus trap, New task, palette, About, What's new, Board, Automations; focus returns to the terminal after a dialog closes | `tests/ui/accessibility.spec.ts` |
| Focus indicator visible on dialog controls | same spec |
| Reduce motion and screen reader mode apply at once, and persist | same spec |

## What changed in this pass

- Switches are 40 x 24 px (were 32 x 20): target size.
- Dialogs opened by a shortcut gave the focus to the page body when they closed. They now restore the focus to what
  had it (usually the terminal), in the shared `DialogContent`.
- Settings, Appearance: **Reduce motion** (also follows the system setting) and **Screen reader mode** (terminals expose
  their text through xterm's accessibility tree; it can feel slower). Both are per device.

## Screen reader mode, in detail

- Terminals: `screenReaderMode` of xterm, which adds a live, off-screen text layer.
- Announcements (polite live region) already exist for task created, task archived or restored, agent attention, moved
  board cards and other actions; these are always on.

## To check by ear (cannot be run in this environment)

Please run these with VoiceOver on macOS (Cmd+F5) and NVDA on Windows, both with Screen reader mode on and off:

1. Open Tessera and press Ctrl or Cmd+K: the palette announces its field and results as you type.
2. Open Settings: the dialog is announced by name; Tab stays inside; Esc closes and the terminal is focused again.
3. Create a task with the keyboard: the creation is announced and the new tab's terminal is focused.
4. In a terminal, type a command and read its output with the review cursor (Screen reader mode on).
5. Open the board, lift a card with Space, move it with the arrow keys: each column is announced with its position.
6. Trigger an agent that needs input: the attention announcement is spoken once.
7. Check the status pills, error toasts and the update chip are read with their meaning, not only their colour.
