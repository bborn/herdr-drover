// cmd-t: a new tab in the shown space, started in the space's own folder.
// The focused pane's folder is used instead only when it is inside the
// space's folder (a subfolder or worktree), so a session that started in ~
// doesn't send every new tab to ~.

import { View, div } from "gpui-kit";
import { run, props, closeOverlay, focused, spaces } from "herdr";

const inside = (dir, root) => !!dir && !!root && (dir === root || dir.startsWith(root.replace(/\/$/, "") + "/"));

export default class NewTab extends View {
  init() {
    const f = focused();
    const space = spaces().find((s) => s.id === f?.space);
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
    else return; // not opened as an overlay (e.g. herdr-app check): do nothing
    if (!space) return run("tab.new", {});
    const folder = inside(f?.cwd, space.folder) ? f.cwd : space.folder;
    run("tab.new", folder ? { space: space.id, folder } : { space: space.id });
  }
  render() {
    return div();
  }
}
