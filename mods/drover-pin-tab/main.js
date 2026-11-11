// cmd-alt-p: pins the shown tab's agent to the top of the agent lists, or unpins it.
// It's the focused terminal's agent, else the first agent in the focused tab.
// Opens as an overlay so a key can reach it, does its job and closes at once.

import { View, div } from "gpui-kit";
import { agents, focused, run, notify, props, closeOverlay } from "herdr";

export default class PinTab extends View {
  init() {
    const overlay = props()?.overlay;
    if (!overlay) return; // herdr-app check loads it without opening it
    const f = focused();
    const list = agents();
    const a = list.find((x) => x.address === f?.terminal) ?? list.find((x) => x.tab === f?.tab);
    if (a) {
      run("terminal.pin", { terminal: a.address, pinned: !a.pinned });
      notify({ title: a.pinned ? "Unpinned" : "Pinned", body: a.tab_name || a.title || a.program?.name || "", timeout: 2000 });
    } else {
      notify({ title: "Nothing to pin", body: "This tab has no agent in it.", timeout: 2000 });
    }
    closeOverlay(overlay);
  }

  render() {
    return div();
  }
}
