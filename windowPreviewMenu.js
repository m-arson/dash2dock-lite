'use strict';

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const animation = () => BoxPointer.PopupAnimation?.FULL ?? true;

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

// PopupMenu provides the same focus navigation, Escape/outside-click dismissal
// and theme as the native app menu. Only its window rows are replaced here.
export const WindowPreviewMenu = class extends PopupMenu.PopupMenu {
  constructor(appIcon, {
    side = St.Side.TOP,
    getWindows = () => appIcon.app.get_windows(),
    onActivate = () => {},
    onOpenStateChanged = () => {},
  } = {}) {
    super(appIcon, 0.5, side);

    this._app = appIcon.app;
    this._getWindows = getWindows;
    this._onActivate = onActivate;
    this._onOpenStateChanged = onOpenStateChanged;
    this._rows = new Map();
    this._appConnections = [];
    this._sourceConnections = [];
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
    this._menuManager = new PopupMenu.PopupMenuManager(appIcon);
    this._menuManager.addMenu(this);

    this.connect('open-state-changed', (_menu, open) => {
      if (!open) this._releasePreviews();
      this._onOpenStateChanged(open);
    });
    connect(this._sourceConnections, appIcon, 'destroy', () => this.destroy());
  }

  // The app button's own activate handler opens the chooser for Enter/Space.
  // A second source-key handler would race its native app menu handler.
  _onKeyPress() {
    return Clutter.EVENT_PROPAGATE;
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
    this._menuManager?.ignoreRelease?.();
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
    this._menuManager?.removeMenu(this);
    this._menuManager = null;
    super.destroy();
    this._destroyed = true;
    this._destroying = false;
    this._app = null;
    this._getWindows = () => [];
    this._onActivate = () => {};
    this._onOpenStateChanged = () => {};
    this._scrollView = null;
  }
};
