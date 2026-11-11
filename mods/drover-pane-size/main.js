// ctrl-cmd-r: a resize mode for the focused pane. ← and → (or h and l) step it
// through a quarter, a third, half, two thirds and three quarters of its split,
// = makes every pane in the tab the same size, and Esc or Enter closes it.
//
// It sets weights with layout.resize, which accepts pane ids. Mods can't see how
// a tab is split, so the sizes come out exact when the tab's panes sit side by
// side in one row (or one column). In a nested split they are only roughly right.
// Mods can't read a pane's size either, so each pane's last step is remembered
// in shared("drover-pane-size"); a pane nobody stepped starts from half.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, nextCommand, props, closeOverlay, focused, panes, shared, setShared, theme, notify } from "herdr";

const STEPS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];
const LABELS = ["1/4", "1/3", "1/2", "2/3", "3/4"];
const HALF = 2;

export default class PaneSize extends View {
  init(_props, cx) {
    this.overlay = props()?.overlay;
    if (!this.overlay) return; // herdr-app check loads it without opening it
    const f = focused();
    this.pane = f?.pane;
    this.others = panes().filter((p) => p.tab === f?.tab && p.pane !== this.pane).map((p) => p.pane);
    if (!this.pane || this.others.length === 0) {
      notify({ title: "Nothing to resize", body: "This tab has only one pane.", timeout: 2000 });
      closeOverlay(this.overlay);
      return;
    }
    this.step = this.remembered()[this.pane] ?? HALF;
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The same steps as commands, for keys.json or `herdr-app do drover-pane-size.larger`.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "smaller") this.apply((this.step ?? HALF) - 1, cx);
        else if (c === "larger") this.apply((this.step ?? HALF) + 1, cx);
        else if (c === "even") this.even(cx);
      }
    });
  }

  remembered() {
    return shared("drover-pane-size") ?? {};
  }

  // The focused pane gets `share` of the split and the others split the rest.
  apply(step, cx) {
    this.step = Math.max(0, Math.min(STEPS.length - 1, step));
    const share = STEPS[this.step];
    const weight = (share * this.others.length) / (1 - share);
    run("layout.resize", { id: this.pane, weight });
    for (const id of this.others) run("layout.resize", { id, weight: 1 });
    const live = new Set(panes().map((p) => p.pane));
    const kept = Object.fromEntries(Object.entries(this.remembered()).filter(([id]) => live.has(id) && !this.others.includes(id)));
    setShared("drover-pane-size", { ...kept, [this.pane]: this.step });
    cx.notify();
  }

  even(cx) {
    for (const id of [this.pane, ...this.others]) run("layout.resize", { id, weight: 1 });
    const kept = Object.fromEntries(Object.entries(this.remembered()).filter(([id]) => id !== this.pane && !this.others.includes(id)));
    setShared("drover-pane-size", kept);
    this.step = this.others.length === 1 ? HALF : null;
    cx.notify();
  }

  render(cx) {
    if (!this.handle) return div();
    const th = theme().colors;
    const key = (k) => div().px(5).rounded(4).bg(th.hover).text_color(th.foreground).child(k);
    const size = this.step === null ? "even" : LABELS[this.step];
    return h_flex()
      .id("drover-pane-size")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "left" || e.key === "h") this.apply((this.step ?? HALF) - 1, cx);
        else if (e.key === "right" || e.key === "l") this.apply((this.step ?? HALF) + 1, cx);
        else if (e.key === "=") this.even(cx);
        else if (e.key === "escape" || e.key === "enter") closeOverlay(this.overlay);
      })
      .size_full().px(16).gap(10).items_center().bg(th.popover).text_size(12).text_color(th.muted)
      .child(div().text_size(13).font_semibold().text_color(th.foreground).child(`Pane ${size}`))
      .child(div().flex_1())
      .child(key("←")).child(key("→"))
      .child(key("=")).child(div().child("even"))
      .child(key("Esc"));
  }
}
