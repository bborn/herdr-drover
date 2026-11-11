import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings } from "herdr";

// Drag a tab: past THRESHOLD px it lifts into a ghost that follows the pointer,
// a placeholder holds its slot, and the other tabs move aside as the pointer
// crosses their middle. Release drops it there. The spaces list reads "tab.drag"
// to move it to another space.
const THRESHOLD = 4;
const GAP = 3;
const SLIDE = { duration: 160, easing: "ease-out" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.drag = null;
    this.widths = {};
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  endDrag(cx) {
    if (this.drag?.lifted) setShared("tab.drag", null);
    this.drag = null;
    this.pressed = null;
    cx?.notify();
  }

  // The order to draw: the dragged tab taken out and a placeholder at its new slot.
  order(shown) {
    const d = this.drag;
    if (!d?.lifted) return shown.map(c => ({ tab: c }));
    const rest = shown.filter(c => c.id !== d.id).map(c => ({ tab: c }));
    rest.splice(Math.min(d.to, rest.length), 0, { placeholder: true });
    return rest;
  }

  // Where the dragged tab would land, from the pointer alone: the number of other
  // tabs whose middle sits left of the ghost's middle, laid out without it. Works
  // with the pointer anywhere, since it needs no hover on the tabs themselves.
  slotAt(shown) {
    const d = this.drag, mid = d.x - d.grab + d.width / 2;
    let x = d.origin, to = 0;
    for (const c of shown) {
      if (c.id === d.id) continue;
      const w = this.widths[c.id] ?? d.width;
      if (x + w / 2 < mid) to++;
      x += w + GAP;
    }
    return to;
  }

  // Follows the pointer, wherever it is once the drag started.
  track(e, cx, shown) {
    const d = this.drag;
    if (!d) return;
    // A move with no button held means it was let go somewhere nobody reported.
    if ("pressed_button" in e && e.pressed_button == null) return this.endDrag(cx);
    d.bar = e.bounds; d.x = e.position.x;
    if (!d.lifted && Math.abs(d.x - d.startX) >= THRESHOLD) {
      d.lifted = true;
      setShared("tab.drag", { id: d.id, space: d.space, name: d.name });
    }
    if (!d.lifted) return;
    if (this.windowMouse) d.to = this.slotAt(shown);
    cx.notify();
  }

  drop(cx) {
    const d = this.drag;
    if (d?.lifted && d.to !== d.from) run("tab.move", { id: d.id, index: d.to + 1 });
    this.endDrag(cx);
  }

  // Tabs stay in their real order while dragging and slide by a left offset, so
  // the move can be animated: the ones passed over shift one slot toward where
  // the dragged tab came from, and its placeholder slides by their total width.
  offset(shown, i) {
    const d = this.drag;
    if (!d?.lifted) return 0;
    const slot = w => w + GAP, { from, to } = d;
    if (i === from) {
      const [a, b] = to > from ? [from + 1, to] : [to, from - 1];
      let sum = 0;
      for (let k = a; k <= b; k++) sum += slot(this.widths[shown[k].id] ?? d.width);
      return to > from ? sum : -sum;
    }
    if (to > from && i > from && i <= to) return -slot(d.width);
    if (to < from && i >= to && i < from) return slot(d.width);
    return 0;
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i, floating = false) => {
      const pane = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = pane?.program;
      // Unnamed tab: the title its program set (Claude's "✳ fix login"), minus the
      // status glyph Herdr already shows; else the program's name.
      const title = (pane?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const name = !c.named ? title || program?.name || "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).relative().left(floating ? 0 : this.offset(shown, i)).when(!floating && !!this.drag?.lifted, el => el.transition("left", SLIDE)).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .when(!this.drag?.lifted, el => el.hover(s => s.bg(t.hover)))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          if (e.click_count === 2) { this.drag = null; run("tab.rename", { id: c.id }); return; }
          this.pressed = i;
          const b = e.bounds, width = b?.width ?? 120;
          this.widths[c.id] = width;
          let before = 0;
          for (let k = 0; k < i; k++) before += (this.widths[shown[k].id] ?? width) + GAP;
          this.drag = { id: c.id, space: space.id, name, from: i, to: i, startX: e.position.x, x: e.position.x, tabX: e.position.x,
            grab: e.local_position?.x ?? 0, width, origin: (b?.x ?? 0) - before, lifted: false };
        })
        .on_size_change(size => { this.widths[c.id] = size.width; })
        .on_mouse_move((e, cx) => {
          // Without window-wide moves: crossing a neighbour's middle in the direction of travel swaps it with the placeholder.
          this.widths[c.id] = e.bounds.width;
          const d = this.drag;
          if (this.windowMouse || !d?.lifted || c.id === d.id) return;
          const dir = e.position.x - d.tabX; d.tabX = e.position.x;
          const at = this.order(shown).findIndex(o => o.tab?.id === c.id), ph = d.to;
          const past = e.local_position.x >= e.bounds.width / 2;
          let to = ph;
          if (dir > 0 && at > ph && past) to = at;
          else if (dir < 0 && at < ph && !past) to = at;
          if (to !== ph) { d.to = to; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => {
          const d = this.drag;
          if (!d || d.lifted || d.id !== c.id) return; // a lifted drag is dropped by the bar
          this.endDrag(cx);
          run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const placeholder = () => div().id("tab-placeholder").relative().left(this.offset(shown, this.drag.from)).transition("left", SLIDE).h(29).flex_none().w(this.drag.width).rounded(7)
      .border(1).border_color(t.border).bg(t.hover).opacity(0.5);
    const ghost = () => {
      const d = this.drag, c = shown.find(x => x.id === d.id);
      const left = Math.max(0, Math.min(d.bar.width - d.width, d.x - d.bar.x - d.grab));
      return div().absolute().top((d.bar.height - 29) / 2).left(left).opacity(d.out ? 0.5 : 0.95).shadow_lg().rounded(7)
        .child(c ? item(c, d.from, true) : div());
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    const bar = h_flex();
    this.windowMouse = typeof bar.on_window_mouse_move === "function";
    return bar.size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .relative()
      .when(!!this.drag?.lifted, el => el.cursor_grabbing())
      // The fork reports moves and releases anywhere in the window, so the drag keeps
      // following a pointer that wandered off the bar. The stock app only reports
      // them over the bar; there, any press after a release outside ends the drag.
      .when(this.windowMouse, el => el
        .on_window_mouse_move((e, cx) => this.track(e, cx, shown))
        .on_window_mouse_up("left", (_e, cx) => { if (this.drag?.lifted) this.drop(cx); }))
      .when(!this.windowMouse, el => el
        .on_mouse_move((e, cx) => this.track(e, cx, shown))
        .on_mouse_up("left", (_e, cx) => this.drop(cx)))
      .on_hover((hovered, cx) => {
        const d = this.drag;
        if (!d) return;
        if (!d.lifted && !hovered && !this.windowMouse) return this.endDrag(cx);
        d.out = !hovered; cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => { if (this.drag) this.endDrag(cx); })
      .on_mouse_down_out((_e, cx) => { if (this.drag) this.endDrag(cx); })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(GAP).overflow_x_scrollbar().children(shown.map((c, i) => this.drag?.lifted && c.id === this.drag.id ? placeholder() : item(c, i))))
      .when(!!this.drag?.lifted && !!this.drag.bar, el => el.child(ghost()))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/drover-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/drover-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/drover-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
