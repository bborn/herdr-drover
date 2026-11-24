// cmd-t: a new tab in the shown space, started in the space's own folder.
// The focused pane's folder is used instead only when it is inside the
// space's folder (a subfolder or worktree), so a session that started in ~
// doesn't send every new tab to ~.
// A folder that no longer exists (a removed worktree) is skipped: the next
// choice is the focused pane's folder, then home. Herdr reports a missing
// folder as "cannot start /bin/zsh", which hides the real cause.

import { View, div } from "gpui-kit";
import { run, props, closeOverlay, focused, spaces, exec, home } from "herdr";

const inside = (dir, root) => !!dir && !!root && (dir === root || dir.startsWith(root.replace(/\/$/, "") + "/"));

async function firstThatExists(dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    const r = await exec("test", ["-d", dir]).catch(() => null);
    if (r?.code === 0) return dir;
  }
  return null;
}

export default class NewTab extends View {
  init() {
    const overlay = props()?.overlay;
    if (!overlay) return; // not opened as an overlay (e.g. herdr-app check): do nothing
    const f = focused();
    const space = spaces().find((s) => s.id === f?.space);
    if (!space) {
      closeOverlay(overlay);
      return run("tab.new", {});
    }
    const preferred = inside(f?.cwd, space.folder) ? f.cwd : space.folder;
    firstThatExists([preferred, f?.cwd, home()]).then((folder) => {
      run("tab.new", folder ? { space: space.id, folder } : { space: space.id });
      closeOverlay(overlay);
    });
  }
  render() {
    return div();
  }
}
