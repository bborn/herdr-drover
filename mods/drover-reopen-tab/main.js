// cmd-shift-t: reopens the most recently closed tab (see drover-close-tab), with its
// terminals still running, back in its space under its old name and position.
// Opens as a small popup, does the work, and closes itself.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, props, closeOverlay, theme, spaces, terminals, shared, setShared, notify, appHome, home } from "herdr";

const STACK_KEY = "tab-undo.closed";

async function doCmd(name, args) {
  const r = await exec(`${home()}/.local/bin/herdr-app`, ["do", name, JSON.stringify(args)]);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: r.stderr || r.stdout };
  }
}

export default class ReopenTab extends View {
  init(_props, cx) {
    this.message = "Reopening…";
    cx.spawn(async (cx) => {
      this.message = await this.reopen();
      cx.notify();
      closeOverlay(props().overlay);
    });
  }

  async reopen() {
    const live = new Set(terminals().filter((t) => t.state === "live").map((t) => t.address));
    const stack = [...(shared(STACK_KEY) ?? [])];
    let entry = null;
    while (stack.length) {
      const e = stack.pop();
      const alive = e.terminals.filter((t) => live.has(t));
      if (alive.length) {
        entry = { ...e, terminals: alive };
        break;
      }
    }
    setShared(STACK_KEY, stack);
    if (!entry) {
      notify({ title: "No closed tab to reopen", level: "info", timeout: 3000 });
      return "Nothing to reopen";
    }

    const spaceStillThere = spaces().some((s) => s.id === entry.space);
    if (spaceStillThere) await doCmd("space.select", { id: entry.space });

    const [first, ...rest] = entry.terminals;
    const made = await doCmd("terminal.keep", { terminal: first, place: "tab" });
    if (made.error || !made.tab) {
      notify({ title: "Couldn't reopen the tab", body: made.error ?? "", level: "error" });
      return "Failed";
    }
    for (const term of rest) await doCmd("terminal.keep", { terminal: term, place: "right" });
    await doCmd("tab.rename", { id: made.tab, name: entry.named ? entry.name : "" });
    if (spaceStillThere) await doCmd("tab.move", { id: made.tab, index: entry.index });
    await doCmd("pane.focus", { terminal: first });

    // Stop this tab's pending cleanup.
    for (const term of entry.terminals) {
      await exec("rm", ["-f", `${appHome()}/data/tab-undo/${term.replace(/[^A-Za-z0-9]/g, "_")}`]);
    }
    if (!spaceStillThere) {
      notify({ title: `Reopened "${entry.name}" here`, body: `Its space, ${entry.spaceName}, had closed.`, level: "info", timeout: 4000 });
    }
    return `Reopened "${entry.name}"`;
  }

  render(cx) {
    const t = theme();
    return h_flex().size_full().px(16).items_center().bg(t.popover).text_size(13).text_color(t.foreground).child(div().truncate().child(this.message));
  }
}
