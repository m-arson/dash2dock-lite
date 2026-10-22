'use strict';

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const animation = () => BoxPointer.PopupAnimation?.FULL ?? true;
const hasInputRegion = parseInt(Config.PACKAGE_VERSION.split('.')[0]) < 50;

const actorContains = (actor, target) => !!actor && !!target &&
  (actor === target || !!actor.contains?.(target));

const pointInActor = (actor, x, y) => {
  if (!actor || actor.visible === false || ![x, y].every(Number.isFinite)) return false;
  const [left, top] = actor.get_transformed_position();
  const [width, height] = actor.get_transformed_size();
  return [left, top, width, height].every(Number.isFinite) && width > 0 && height > 0 &&
    x >= left && x < left + width && y >= top && y < top + height;
};

const disconnectAll = connections => {
  for (const [object, id] of connections.splice(0)) {
    try {
      object.disconnect(id);
    } catch {
      // A compositor actor may already be disposing during window removal.
    }
  }
};

const connect = (connections, object, signal, callback) => {
  if (!object?.connect) return;
  connections.push([object, object.connect(signal, callback)]);
};

// Reuse native menu rows, focus navigation and themes without its modal menu
// manager: a preview must leave other dock buttons and application windows
// available on the first click, even when no preview was selected.
export const WindowPreviewMenu = class extends PopupMenu.PopupMenu {
  constructor(appIcon, {
    side = St.Side.TOP,
    getWindows = () => appIcon.app.get_windows(),
    onActivate = () => {},
    onOpenStateChanged = () => {},
    onPointerMotion = () => {},
  } = {}) {
    super(appIcon, 0.5, side);

    this._app = appIcon.app;
    this._getWindows = getWindows;
    this._onActivate = onActivate;
    this._onOpenStateChanged = onOpenStateChanged;
    this._onPointerMotion = onPointerMotion;
    this._rows = new Map();
    this._appConnections = [];
    this._sourceConnections = [];
    this._inputConnections = [];
    this._inputTracked = false;
    this._removedWindows = new Set();
    this._deadSources = new WeakSet();
    this._side = side;
    this._destroyed = false;
    this._destroying = false;
    this._watching = false;

    this.actor.add_style_class_name('d2dl-window-preview-menu');

    // Keep PopupMenu.box and all native item bookkeeping intact, while making
    // a long window list scroll instead of extending beyond its monitor.
    this._boxPointer.bin.set_child(null);
    this._scrollView = new St.ScrollView({
      style_class: 'd2dl-window-preview-scrollview',
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
      clip_to_allocation: true,
    });
    if (this._scrollView.set_child) this._scrollView.set_child(this.box);
    else this._scrollView.add_actor(this.box);
    this._boxPointer.bin.set_child(this._scrollView);

    Main.uiGroup.add_child(this.actor);
    this.actor.hide();

    this.connect('open-state-changed', (_menu, open) => {
      if (open) this._watchInput();
      else this._releasePreviews();
      this._onOpenStateChanged(open);
    });
    connect(this._sourceConnections, appIcon, 'destroy', () => this.destroy());
  }

  // The app button handles Enter/Space itself. Only the arrow toward an already
  // open preview moves keyboard focus into its native, accessible window rows.
  _onKeyPress(_actor, event) {
    if (!this.isOpen || !event || !this.sourceActor?.reactive) return Clutter.EVENT_PROPAGATE;
    let state = event.get_state();
    state &= ~Clutter.ModifierType.LOCK_MASK;
    state &= ~Clutter.ModifierType.MOD2_MASK;
    state &= Clutter.ModifierType.MODIFIER_MASK;
    if (state) return Clutter.EVENT_PROPAGATE;
    const key = {
      [St.Side.TOP]: Clutter.KEY_Down,
      [St.Side.BOTTOM]: Clutter.KEY_Up,
      [St.Side.LEFT]: Clutter.KEY_Right,
      [St.Side.RIGHT]: Clutter.KEY_Left,
    }[this._boxPointer.arrowSide ?? this._side];
    if (event.get_key_symbol() === key && key !== undefined) {
      this.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }

  containsPoint(x, y) {
    if (Array.isArray(x)) [x, y] = x;
    return this.isOpen && pointInActor(this.actor, x, y);
  }

  _watchInput() {
    if (this._inputConnections.length) return;
    // GNOME 50 removed X11 input-region parameters. On older X11 sessions the
    // popup needs just its own rectangle, rather than a full-stage modal grab.
    if (hasInputRegion && !Meta.is_wayland_compositor() &&
        Main.layoutManager.trackChrome && Main.layoutManager.untrackChrome) {
      Main.layoutManager.trackChrome(this.actor, {
        affectsInputRegion: true, affectsStruts: false, trackFullscreen: false,
      });
      this._inputTracked = true;
    }
    connect(this._inputConnections, global.stage, 'captured-event',
      (_stage, event) => this._onCapturedEvent(event));
  }

  _onCapturedEvent(event) {
    if (!this.isOpen) return Clutter.EVENT_PROPAGATE;
    const type = event.type();
    if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
      const target = global.stage.get_event_actor?.(event) ?? event.get_source?.();
      let inside = actorContains(this.actor, target) || actorContains(this.sourceActor, target);
      if (!target) {
        const [x, y] = event.get_coords();
        inside = this.containsPoint(x, y) || pointInActor(this.sourceActor, x, y);
      }
      if (!inside) this.close(animation());
      // In particular, do not consume the click that closes the preview. The
      // other app icon/window must receive that same mouse or touch press.
    } else if (type === Clutter.EventType.KEY_PRESS) {
      const focus = global.stage.get_key_focus();
      const sourceFocused = actorContains(this.sourceActor, focus);
      if (event.get_key_symbol() === Clutter.KEY_Escape) {
        const ownsFocus = actorContains(this.actor, focus) || sourceFocused;
        this.close(animation());
        // Pointer previews keep focus in the previous app. Escape still
        // cancels the preview, while remaining available to that app too.
        return ownsFocus ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
      }
      // Capture this before the source's pre-existing native app-menu key
      // handler: otherwise the same arrow could open that menu first.
      if (sourceFocused && this._onKeyPress(this.sourceActor, event) === Clutter.EVENT_STOP)
        return Clutter.EVENT_STOP;
    } else if ([Clutter.EventType.MOTION, Clutter.EventType.ENTER,
      Clutter.EventType.LEAVE].includes(type)) {
      this._onPointerMotion(event.get_coords());
    }
    return Clutter.EVENT_PROPAGATE;
  }

  _releaseInput() {
    disconnectAll(this._inputConnections);
    if (this._inputTracked) {
      this._inputTracked = false;
      Main.layoutManager.untrackChrome(this.actor);
    }
  }

  setSide(side) {
    this._side = side;
    this._arrowSide = side;
    // BoxPointer may flip its arrow to fit the monitor; remember the requested
    // edge as well so a later allocation starts from the actual dock edge.
    this._boxPointer._userArrowSide = side;
    this._boxPointer.updateArrowSide?.(side);
    this._boxPointer.queue_relayout();
  }

  popup(side = this._side) {
    if (this._destroyed || this._destroying) return false;
    this.setSide(side);
    if (this.isOpen) {
      this.close(animation());
      return false;
    }
    this.open(animation());
    return this.isOpen;
  }

  open(animate = animation()) {
    if (this._destroyed || this._destroying || this.isOpen) return;
    this.sourceActor?._menu?.close(animation());
    this._updateDimensions();
    this._watching = true;
    connect(this._appConnections, this._app, 'windows-changed', () => this._syncWindows());
    try {
      this._syncWindows();
      if (this._rows.size) super.open(animate);
      if (!this.isOpen) this._releasePreviews();
    } catch (error) {
      this._releasePreviews();
      throw error;
    }
  }

  close(animate = animation()) {
    if (this._destroyed) return;
    super.close(animate);
    // Also handles a failed/empty open, for which no state signal was emitted.
    if (!this.isOpen) this._releasePreviews();
  }

  _updateDimensions() {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    this._scale = scale;
    let area = Main.layoutManager.primaryMonitor;
    try {
      const index = Main.layoutManager.findIndexForActor(this.sourceActor);
      area = Main.layoutManager.getWorkAreaForMonitor(index) ?? area;
    } catch {
      // A disappearing monitor/source can have no current work area.
    }
    const width = area?.width ?? 1024 * scale;
    const height = area?.height ?? 768 * scale;
    this._thumbnailWidth = Math.max(64, Math.min(192 * scale, width * 0.55));
    this._thumbnailHeight = Math.max(40, Math.min(112 * scale, height * 0.3));
    this._scrollView.set_style(`max-height: ${Math.floor(height * 0.75 / scale)}px;`);
  }

  _windows() {
    return [...new Set(this._getWindows() ?? [])]
      .filter(window => window && !window.skip_taskbar && !this._removedWindows.has(window));
  }

  _syncWindows() {
    if (!this._watching || this._destroyed || this._destroying) return;
    const windows = this._windows();
    const live = new Set(windows);
    for (const [window, row] of this._rows) {
      if (!live.has(window)) this._removeRow(row);
    }
    for (const [index, window] of windows.entries()) {
      const row = this._rows.get(window) ?? this._createRow(window);
      this.moveMenuItem(row.item, index);
    }
    if (!this._rows.size && this.isOpen) this.close(animation());
  }

  _createRow(window) {
    const item = new PopupMenu.PopupBaseMenuItem({style_class: 'd2dl-window-preview-item'});
    const content = new St.BoxLayout({
      vertical: true,
      style_class: 'd2dl-window-preview-content',
      x_expand: true,
    });
    const frame = new St.Bin({
      style_class: 'd2dl-window-preview-thumbnail',
      width: this._thumbnailWidth,
      height: this._thumbnailHeight,
      x_align: Clutter.ActorAlign.CENTER,
      reactive: false,
      clip_to_allocation: true,
    });
    const label = new St.Label({
      style_class: 'd2dl-window-preview-title',
      width: this._thumbnailWidth,
      x_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    label.clutter_text.single_line_mode = true;
    content.add_child(frame);
    content.add_child(label);
    item.add_child(content);
    item.label_actor = label;

    const row = {window, item, frame, label, connections: [], sourceConnections: [],
      source: null, preview: null, clone: null};
    this._rows.set(window, row);
    this._updateTitle(row);

    // Connect before PopupMenu's own itemActivated handler. Closing releases
    // every preview immediately, including this item's signal handlers.
    item.connect('activate', () => {
      if (!this.isOpen || !this._rows.has(window)) return;
      const activate = this._onActivate;
      this.close(animation());
      activate(window);
    });
    item.connect('key-focus-in', () => this._ensureVisible(item));
    this.addMenuItem(item);

    connect(row.connections, window, 'notify::title', () => this._updateTitle(row));
    connect(row.connections, window, 'size-changed', () => this._updatePreview(row));
    connect(row.connections, window, 'notify::minimized', () => this._updatePreview(row));
    connect(row.connections, window, 'unmanaged', () => {
      this._removedWindows.add(window);
      this._removeRow(row);
      if (!this._rows.size) this.close(animation());
    });
    this._updatePreview(row);
    return row;
  }

  _updateTitle(row) {
    row.label.text = row.window.get_title() || this._app.get_name?.() || 'Window';
  }

  _updatePreview(row) {
    if (!this._rows.has(row.window)) return;
    try {
      this._syncPreview(row);
    } catch {
      // Windows and compositor surfaces can disappear between list updates.
      // Keep this row selectable without discarding the other live previews.
      disconnectAll(row.sourceConnections);
      row.source = null;
      this._clearPreview(row);
      this._showFallback(row);
    }
  }

  _syncPreview(row) {
    let source = row.window.get_compositor_private();
    if (source && this._deadSources.has(source)) source = null;
    if (row.source !== source) {
      disconnectAll(row.sourceConnections);
      this._clearPreview(row);
      row.source = source;
      if (source) {
        connect(row.sourceConnections, source, 'notify::width', () => this._updatePreview(row));
        connect(row.sourceConnections, source, 'notify::height', () => this._updatePreview(row));
        connect(row.sourceConnections, source, 'destroy', () => {
          this._deadSources.add(source);
          disconnectAll(row.sourceConnections);
          row.source = null;
          this._clearPreview(row);
          this._showFallback(row);
        });
      }
    }

    const [width, height] = source?.get_size() ?? [0, 0];
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) {
      if (row.clone) this._clearPreview(row);
      this._showFallback(row);
      return;
    }
    const scale = Math.min(1, this._thumbnailWidth / width, this._thumbnailHeight / height);
    const cloneWidth = width * scale;
    const cloneHeight = height * scale;
    if (!row.clone) {
      this._clearPreview(row);
      // This is the native Alt-Tab clone strategy. It neither shows nor
      // unminimizes the source; minimized windows stay minimized until chosen.
      row.clone = new Clutter.Clone({
        source,
        width: cloneWidth,
        height: cloneHeight,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
        reactive: false,
      });
      row.preview = row.clone;
      row.frame.set_child(row.preview);
    } else {
      row.clone.set_size(cloneWidth, cloneHeight);
    }
  }

  _showFallback(row) {
    if (row.preview) return;
    const size = Math.min(48 * this._scale, this._thumbnailHeight / 2);
    try {
      row.preview = this._app.create_icon_texture?.(size);
    } catch {
      // An app disappearing with its final window may have no texture left.
    }
    row.preview ??= new St.Icon({
      icon_name: 'application-x-executable-symbolic',
      icon_size: size,
    });
    row.preview.reactive = false;
    row.preview.x_align = Clutter.ActorAlign.CENTER;
    row.preview.y_align = Clutter.ActorAlign.CENTER;
    row.frame.set_child(row.preview);
  }

  _clearPreview(row) {
    row.frame.set_child(null);
    row.preview?.destroy();
    row.preview = null;
    row.clone = null;
  }

  _ensureVisible(item) {
    // St.ScrollView's adjustment accessor changed after GNOME 44.
    const scroll = this._scrollView;
    const adjustment = scroll.vadjustment ?? scroll.vscroll?.adjustment ??
      scroll.get_vscroll_bar?.()?.get_adjustment();
    if (!adjustment) return;
    let actor = item;
    let y = 0;
    while (actor && actor !== scroll) {
      y += actor.get_allocation_box().y1;
      actor = actor.get_parent();
    }
    if (actor !== scroll) return;
    const top = adjustment.value;
    const bottom = top + adjustment.page_size;
    if (y < top) adjustment.value = Math.max(adjustment.lower, y);
    else if (y + item.height > bottom) {
      adjustment.value = Math.min(adjustment.upper - adjustment.page_size,
        y + item.height - adjustment.page_size);
    }
  }

  _removeRow(row) {
    if (!this._rows.delete(row.window)) return;
    disconnectAll(row.connections);
    disconnectAll(row.sourceConnections);
    this._clearPreview(row);
    row.source = null;
    row.item.destroy();
  }

  _releasePreviews() {
    this._watching = false;
    this._releaseInput();
    disconnectAll(this._appConnections);
    for (const row of this._rows.values()) this._removeRow(row);
    this._removedWindows.clear();
    this._deadSources = new WeakSet();
  }

  destroy() {
    if (this._destroyed || this._destroying) return;
    this._destroying = true;
    this.close(animation());
    this._releasePreviews();
    disconnectAll(this._sourceConnections);
    super.destroy();
    this._destroyed = true;
    this._destroying = false;
    this._app = null;
    this._getWindows = () => [];
    this._onActivate = () => {};
    this._onOpenStateChanged = () => {};
    this._onPointerMotion = () => {};
    this._scrollView = null;
  }
};
