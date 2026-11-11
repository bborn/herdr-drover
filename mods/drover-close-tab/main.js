// cmd-w: asks before closing the shown tab. Closing parks its terminals
// (off screen, still running) instead of ending them, so cmd-shift-t
// (the drover-reopen-tab mod) can bring the tab back with its agents alive.
// Parked terminals are ended after KEEP_MINUTES.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, exec, nextCommand, props, closeOverlay, theme, focused, spaces, panes, shared, setShared, notify, appHome } from "herdr";

const KEEP_MINUTES = 30;
const STACK_KEY = "tab-undo.closed";
const STACK_MAX = 20;

export default class CloseTab extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.target = this.snapshot();
    // "drover-close-tab.confirm" presses Close from a script or another key.
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "confirm" && this.target) this.yes(cx);
      }
    });
  }

  snapshot() {
    const f = focused();
    if (!f) return null;
    const space = spaces().find((s) => s.id === f.space);
    const tab = space?.tabs.find((t) => t.id === f.tab);
    if (!space || !tab) return null;
    const own = panes().filter((p) => p.tab === tab.id);
    return {
      space: space.id,
      spaceName: space.name,
      tab: tab.id,
      name: tab.name,
      named: tab.named,
      index: tab.index,
      lastTab: space.tabs.length <= 1,
      terminals: own.filter((p) => p.terminal).map((p) => p.terminal),
      programs: own.map((p) => (p.status ? `${p.program?.name ?? "panel"} (${p.status})` : p.program?.name ?? "panel")),
    };
  }

  yes(cx) {
    const t = this.target;
    const overlay = props().overlay;
    if (!t || this.closing) return;
    this.closing = true;
    if (t.terminals.length === 0) {
      // Only mod panes: nothing to keep alive.
      closeOverlay(overlay);
      run("tab.close", { id: t.tab, confirmed: true });
      return;
    }
    const closedAt = Date.now();
    const stack = (shared(STACK_KEY) ?? []).slice(-(STACK_MAX - 1));
    stack.push({ ...t, closedAt });
    setShared(STACK_KEY, stack);
    for (const term of t.terminals) run("terminal.park", { terminal: term });
    cx.spawn(async () => {
      const dir = `${appHome()}/data/tab-undo`;
      await exec("mkdir", ["-p", dir]);
      for (const term of t.terminals) {
        const file = `${dir}/${term.replace(/[^A-Za-z0-9]/g, "_")}`;
        const token = String(closedAt);
        await exec("sh", ["-c", 'printf %s "$1" > "$2"', "sh", token, file]);
        await exec("sh", [
          "-c",
          'nohup "$0" "$@" >/dev/null 2>&1 &',
          `${appHome()}/mods/drover-close-tab/reap.sh`,
          String(KEEP_MINUTES * 60),
          file,
          token,
          term,
        ]);
      }
      // Closing the dialog ends this copy's tasks, so only after the cleanup is scheduled.
      closeOverlay(overlay);
    });
    notify({
      title: `Closed tab "${t.name}"`,
      body: `Press ⌘⇧T within ${KEEP_MINUTES} minutes to reopen it.`,
      level: "info",
      timeout: 6000,
      action: { name: "mod.open", args: { name: "drover-reopen-tab" } },
    });
  }

  render(cx) {
    const th = theme();
    const t = this.target;
    const close = () => closeOverlay(props().overlay);
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "no" ? th.input : bg).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    const title = t ? `Close tab "${t.name}"?` : "No tab to close";
    let detail = "";
    if (t) {
      detail = t.programs.length ? `Running: ${t.programs.join(", ")}.` : "";
      detail += ` You can reopen it with ⌘⇧T for ${KEEP_MINUTES} minutes.`;
      if (t.lastTab) detail += ` It's the last tab in ${t.spaceName}, so the space will close too.`;
    }
    return v_flex()
      .id("drover-close-tab")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && t) this.yes(cx);
        else if (e.key === "escape") close();
        else return;
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(th.popover)
      .text_size(13)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(th.foreground).truncate().child(title)).child(div().text_size(11).text_color(th.dim).child("Esc")))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_color(th.muted).child(detail.trim()))
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .text_size(12)
          .child(button("no", "Cancel", th.raised, th.foreground, close))
          .when(!!t, (el) => el.child(button("yes", "Close tab  ↵", th.solid, th.solid_foreground, (_e, cx) => this.yes(cx)))),
      );
  }
}
