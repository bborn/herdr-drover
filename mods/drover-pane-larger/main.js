// ctrl-cmd-left / ctrl-cmd-right make the focused pane one step smaller or larger,
// through 1/4, 1/3, 1/2, 2/3 and 3/4 of its split; ctrl-cmd-= gives every pane in
// the tab the same size. This copy does "larger". The three mods are the same file
// apart from ACTION, because a key can only open a mod by name.
//
// Sizes are weights set with layout.resize, which accepts pane ids. Mods can't
// see how a tab is split, so they're exact when the tab's panes sit side by side
// in one row or one column, and only roughly right in a nested split. Mods can't
// read a pane's size either, so each pane's last step is kept in
// shared("pane-steps"); a pane nobody stepped starts from half.

import { View, div } from "gpui-kit";
import { run, props, closeOverlay, focused, panes, shared, setShared } from "herdr";

const ACTION = "larger";
const STEPS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];
const HALF = 2;

export default class PaneStep extends View {
  init() {
    const overlay = props()?.overlay;
    if (!overlay) return; // herdr-app check loads it without opening it
    const f = focused();
    const all = panes();
    const others = all.filter((p) => p.tab === f?.tab && p.pane !== f?.pane).map((p) => p.pane);
    if (f?.pane && others.length > 0) {
      const live = new Set(all.map((p) => p.pane));
      const steps = Object.fromEntries(Object.entries(shared("pane-steps") ?? {}).filter(([id]) => live.has(id) && !others.includes(id)));
      if (ACTION === "even") {
        for (const id of [f.pane, ...others]) run("layout.resize", { id, weight: 1 });
        delete steps[f.pane];
      } else {
        const step = Math.max(0, Math.min(STEPS.length - 1, (steps[f.pane] ?? HALF) + (ACTION === "larger" ? 1 : -1)));
        const share = STEPS[step];
        run("layout.resize", { id: f.pane, weight: (share * others.length) / (1 - share) });
        for (const id of others) run("layout.resize", { id, weight: 1 });
        steps[f.pane] = step;
      }
      setShared("pane-steps", steps);
    }
    closeOverlay(overlay);
  }

  render() {
    return div();
  }
}
