// cmd-\: puts the keyboard back in the shown tab's pane (the last one you
// were in), from the agents list or any other sidebar panel.

import { View, div } from "gpui-kit";
import { run, props, closeOverlay, focused, panes } from "herdr";

export default class FocusMain extends View {
  init() {
    const overlay = props()?.overlay;
    if (!overlay) return; // not opened as an overlay (e.g. herdr-app check)
    closeOverlay(overlay);
    const f = focused();
    const here = panes().filter((p) => p.tab === f?.tab);
    const pane = f?.pane ?? (here.find((p) => p.focused) ?? here[0])?.pane;
    if (pane) run("pane.focus", { pane });
  }
  render() {
    return div();
  }
}
