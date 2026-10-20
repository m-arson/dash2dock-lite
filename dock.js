'use strict';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Fav from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as DashModule from 'resource:///org/gnome/shell/ui/dash.js';
const { Dash } = DashModule;
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { TintEffect } from './effects/tint_effect.js';
import { MonochromeEffect } from './effects/monochrome_effect.js';

import { DockIcon, DockItemContainer, DockBackground } from './dockItems.js';
import { DockItemList } from './dockItemMenu.js';
import { AutoHide } from './autohide.js';
import { Animator } from './animator.js';
import { getDropSlot, planFavoriteDrop, resolveFavoriteDrop } from './dragOrder.js';
import {
  get_distance_sqr,
  get_distance,
  isInRect,
  isOverlapRect,
  tempPath,
} from './utils.js';

const Point = Graphene.Point;

export const DockPosition = {
  BOTTOM: 'bottom',
  LEFT: 'left',
  RIGHT: 'right',
  TOP: 'top',
};

export const DockAlignment = {
  CENTER: 'center',
  START: 'start',
  END: 'end',
};

const PREVIEW_FRAMES = 64;
const ANIM_DEBOUNCE_END_DELAY = 750;

const MIN_SCROLL_RESOLUTION = 4;
const MAX_SCROLL_RESOLUTION = 10;

// Gnome 50 dropped X11 and with it the affectsInputRegion chrome parameter;
// addChrome() throws on parameters it does not know
const SHELL_HAS_INPUT_REGION =
  parseInt(Config.PACKAGE_VERSION.split('.')[0]) < 50;

const inputRegionParam = (affectsInputRegion) =>
  SHELL_HAS_INPUT_REGION ? { affectsInputRegion } : {};

// Gnome 48 and older: Dash connects to these shared objects and never
// disconnects, so record what it connects and disconnect it ourselves
const DASH_LEAKS_SIGNALS = parseInt(Config.PACKAGE_VERSION.split('.')[0]) < 49;

// initializeDeferredWork() binds _redisplay during Dash construction. Override
// it on the class, before that binding happens, so queued work cannot invoke
// the upstream implementation after the dock has been destroyed.
const DockDash = GObject.registerClass(
  class DockDash extends Dash {
    _redisplay() {
      if (!this._d2dlDestroying) this._d2dlOwner?._redisplayDash(this);
    }

    _queueRedisplay() {
      if (!this._d2dlDestroying) super._queueRedisplay();
    }

    // Dock.layout owns icon sizing. The stock horizontal sizing code expects
    // every app's texture to exist, including during style/theme changes.
    _adjustIconSize() {}

    _syncLabel(item, appIcon) {
      if (this._d2dlDestroying || item._d2dlDestroying) return;
      super._syncLabel(item, appIcon);
    }

    _onItemDragBegin() {
      if (this._d2dlDestroying) return;
      if (this._dragMonitor) this._endItemDrag();
      super._onItemDragBegin();
      this._d2dlOwner?._ensureEmptyDashDropTarget(this);
      this._d2dlOwner?._setDragState(true);
    }

    _endItemDrag() {
      this._clearDragPlaceholder();
      this._clearEmptyDropTarget();
      this._showAppsIcon.setDragApp(null);
      if (this._dragMonitor) {
        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
      }
      this._d2dlOwner?._setDragState(false);
    }
  }
);

const createTrackedDash = () => {
  if (!DASH_LEAKS_SIGNALS) {
    return [new DockDash(), []];
  }
  let connections = [];
  let sources = [
    Shell.AppSystem.get_default(),
    Fav.getAppFavorites(),
    Main.overview,
  ];
  let saved = sources.map((source) => [
    source,
    Object.getOwnPropertyDescriptor(source, 'connect'),
  ]);
  sources.forEach((source) => {
    let connect = source.connect;
    source.connect = (...args) => {
      let id = connect.apply(source, args);
      connections.push([source, id]);
      return id;
    };
  });
  try {
    return [new DockDash(), connections];
  } catch (error) {
    for (const [source, id] of connections) source.disconnect(id);
    throw error;
  } finally {
    saved.forEach(([source, descriptor]) => {
      if (descriptor) {
        Object.defineProperty(source, 'connect', descriptor);
      } else {
        delete source.connect;
      }
    });
  }
};

// Root cause of the "logout while reordering pinned icons" crash:
// when a dash item is destroyed while its icon is hovered, Clutter re-picks
// synchronously, the parent button gains :hover, its style changes and
// BaseIcon.vfunc_style_changed() sees an empty _iconBin (the old StIcon was
// just removed) and calls _createIconTexture() -> a *new* child is added to
// the bin that clutter_actor_destroy_all_children() is emptying ->
// assertion (n_children < prev_n_children) -> gnome-shell aborts.
// Never let a BaseIcon re-create its texture once teardown has started.
const guardBaseIcon = (baseIcon, owner) => {
  if (!baseIcon || baseIcon._d2dlGuarded || !baseIcon._createIconTexture) {
    return;
  }
  baseIcon._d2dlGuarded = true;
  const markDestroying = () => {
    baseIcon._d2dlDestroying = true;
  };
  baseIcon.connect('destroy', markDestroying);
  if (owner && owner !== baseIcon) {
    owner.connect('destroy', markDestroying);
  }
  const create = baseIcon._createIconTexture;
  baseIcon._createIconTexture = function (...args) {
    if (this._d2dlDestroying || this._d2dlCreating) return;
    this._d2dlCreating = true;
    try {
      return create.apply(this, args);
    } finally {
      this._d2dlCreating = false;
    }
  };
};

const prepareIconDestroy = (item) => {
  if (!item) return;
  item._d2dlDestroying = true;
  const baseIcon = item?.icon ?? item?.child?.icon;
  if (baseIcon) baseIcon._d2dlDestroying = true;
  item?._label?.remove_all_transitions();
  item?.label?.remove_all_transitions();
};

const getAppFromSource = (source) => {
  try {
    if (Dash.getAppFromSource) return Dash.getAppFromSource(source);
    if (DashModule.getAppFromSource) return DashModule.getAppFromSource(source);
  } catch (err) {
    // fall through
  }
  if (source?.app) return source.app;
  if (source?.metaWindow) {
    return Shell.WindowTracker.get_default().get_window_app(source.metaWindow);
  }
  return null;
};

const isDashAppItem = (actor) =>
  !!(actor && actor.child && actor.child._delegate && actor.child._delegate.app);

export let Dock = GObject.registerClass(
  {},
  class DashToDock extends St.Widget {
    _init(params) {
      super._init({
        // name: 'd2daDock',
        name: 'dashtodockContainer',
        style_class: 'bottom',
        reactive: false,
        track_hover: false,
        width: 0,
        height: 0,
        clip_to_allocation: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      this.extension = params.extension;
      this.connect('destroy', () => {
        this._destroyed = true;
        this.cancelAnimations();
        this._destroyList();
        this.autohider?.disable();
        this.animator?.disable();
        this.destroyDash();
      });

      this._alignment = DockAlignment.CENTER;
      this._monitorIndex = Main.layoutManager.primaryIndex;

      this._background = new DockBackground({ name: 'dash', style_class: 'd2da-background' });
      this._background._background = this._background;
      this.add_child(this._background);

      this.renderArea = new St.Widget({
        name: 'DockRenderArea',
        reactive: false,
        track_hover: false,
      });
      // Blur My Shell discovers the Dash-to-Dock slider and its named dash.
      // Use our real renderer/background so allocation, autohide and geometry
      // signals describe what is painted; a hidden dummy can never be ready.
      this.renderArea.get_child = () => this;
      this._slider = this.renderArea;
      this.renderArea.opacity = 0;
      this.add_child(this.renderArea);

      this.add_child(this.createDash());
      this._scrollCounter = 0;

      this.animator = new Animator();
      this.animator.dock = this;
      this.animator.extension = this.extension;
      this.animator.enable();

      this.autohider = new AutoHide();
      this.autohider.dock = this;
      this.autohider.extension = this.extension;
      if (this.extension.autohide_dash) {
        this.autohider.enable();
      }

      this.struts = new St.Widget({
        name: 'DockStruts',
      });
      if (SHELL_HAS_INPUT_REGION) {
        this.inputArea = new St.Widget({
          name: 'DockInputArea',
          reactive: true,
        });
      }
      this.dwell = new St.Widget({
        name: 'DockDwell',
        reactive: true,
        track_hover: true,
      });
      this.dwell.connectObject(
        'motion-event',
        this.autohider._onMotionEvent.bind(this.autohider),
        'enter-event',
        this.autohider._onEnterEvent.bind(this.autohider),
        'leave-event',
        this.autohider._onLeaveEvent.bind(this.autohider),
        this
      );

      // struts, inputArea and dwell are chrome of their own, not children
      this.connect('destroy', () => {
        this.struts.destroy();
        this.dwell.destroy();
        this.inputArea?.destroy();
      });
    }

    destroyDash() {
      const dash = this.dash;
      if (dash) {
        this._prepareDashDestroy(dash);
        dash.destroy();
      }
    }

    _prepareDashDestroy(dash) {
      if (!dash._d2dlDestroying) {
        dash._d2dlDestroying = true;
        this.cancelAnimations();
        this._cancelFavoriteDrop(dash);
        this._clearDashLabelTimeouts(dash);
        dash._endItemDrag();
        const items = [
          ...dash._box.get_children(),
          ...(this._extraIcons?.get_children() ?? []),
          dash._showAppsIcon,
        ];
        items.forEach(item => {
          prepareIconDestroy(item);
          this._cleanupIcon(item);
        });
        this._icons = null;
        this._layoutState = null;
        this._extraIconState = null;

        // destroy (not just remove) so the Dash drops its app system,
        // favorites, overview and ctrl-alt-tab hookups
        (this._dashConnections ?? []).forEach(([source, id]) => {
          try {
            source.disconnect(id);
          } catch (e) {}
        });
        this._dashConnections = [];
        try {
          dash.disconnectObject(this);
        } catch (e) {}
        Main.ctrlAltTabManager.removeGroup(dash);
        dash._d2dlOwner = null;
        this.dash = null;
        this._dashItems = [];
        this._separators = [];
        this._hoveredIcon = null;
        this._nearestIcon = null;
        this._lastHoveredIcon = null;
        this._trashIcon = null;
        this._recentFilesIcon = null;
        this._downloadsIcon = null;
        this._extraIcons = null;
        this._separator = null;
        // mounted icons?
      }
    }

    recreateDash() {
      this._hidden = false;
      this.opacity = 0;
      this.renderArea.opacity = 0;
      this.destroyDash();
      this.add_child(this.createDash());
      this._icons = null;
      this._trashIcon = null;
      this._recentFilesIcon = null;
      this._downloadsIcon = null;
      this._beginAnimation();
    }

    createItem(appinfo_filename) {
      let item = new DockItemContainer({
        appinfo_filename,
      });
      // size like the Dash does for app icons; the 96px default overflows
      // the item (Gnome 42 then allocates the icon no space to click)
      item.child.icon.setIconSize(this.dash.iconSize);
      item.dock = this;
      item._menu._onActivate = () => {
        this._maybeBounce(item);
      };
      this._extraIcons.add_child(item);
      return item;
    }

    dock() {
      if (!this.dash) {
        this.add_child(this.createDash());
      }
      this.animator.enable();
      this.addToChrome();
      this.layout();
      this._beginAnimation();
    }

    undock() {
      this._destroyList();
      this._endAnimation();
      this._removeIconEffect();
      this.autohider.disable();
      this.removeFromChrome();
      this.animator.disable();
    }

    _removeIconEffect() {
      this._effectTargets().forEach((target) => {
        if (!target) return;
        target.remove_effect_by_name('icon-effect');
        target.iconEffect = null;
      });
    }

    _onButtonPressEvent(evt) {
      return Clutter.EVENT_PROPAGATE;
    }

    _onMotionEvent(evt) {
      if (!this._monitor?.inFullscreen || this.extension._inOverview) {
        this._beginAnimation();
      }
      this.autohider._debounceCheckHide();
      return Clutter.EVENT_PROPAGATE;
    }
    _onEnterEvent(evt) {
      if (!this._monitor?.inFullscreen || this.extension._inOverview) {
        this._beginAnimation();
      }
      return Clutter.EVENT_PROPAGATE;
    }
    _onLeaveEvent(evt) {
      // A stationary hovered dock has no frame timer. Leaving must wake it
      // again so the rendered icons can return to their resting positions.
      this._beginAnimation();
      this.autohider._debounceCheckHide();
      this._debounceEndAnimation();
      return Clutter.EVENT_PROPAGATE;
    }

    _debouncedBeginAnimation() {
      if (this._destroyed || !this.dash) return;
      this.dash.opacity = 1;

      // this elaborate hack - mitigates nvim's "create window when deleting! hmmp"
      if (!this._debounceBeginAnimateSeq) {
        this._debounceBeginAnimateSeq = this.extension._loTimer.runDebounced(
          () => {
            this._beginAnimation();
            this.autohider._debounceCheckHide();
          },
          400,
          'debounceBeginAnimate'
        );
      } else {
        this.extension._loTimer.runDebounced(this._debounceBeginAnimateSeq);
      }
    }

    _onFocusWindow(evt) {
      // this._debouncedBeginAnimation();
      this._beginAnimation();
      this.autohider._debounceCheckHide();
      return Clutter.EVENT_PROPAGATE;
    }
    _onFullScreen() {
      // this._debouncedBeginAnimation();
      this._beginAnimation();
      this.autohider._debounceCheckHide();
      return Clutter.EVENT_PROPAGATE;
    }
    _onRestacked() {
      // this._debouncedBeginAnimation();
      this._beginAnimation();
      this.autohider._debounceCheckHide();
      return Clutter.EVENT_PROPAGATE;
    }
    _onAppsChanged(evt) {
      this._favorite_ids = Fav.getAppFavorites()._getIds();
      this._icons = null;
      // this._debouncedBeginAnimation();
      this._beginAnimation();
      this.autohider._debounceCheckHide();
      return Clutter.EVENT_PROPAGATE;
    }
    _onClock() {
      this._clock?.redraw();
    }
    _onCalendar() {
      this._calendar?.redraw();
    }

    _createEffect(idx) {
      let effect = null;
      switch (idx) {
        case 1: {
          effect = new TintEffect({
            name: 'color',
            color: this.extension.icon_effect_color,
          });
          effect.preload(this.extension.path);
          break;
        }
        case 2: {
          effect = new MonochromeEffect({
            name: 'color',
            color: this.extension.icon_effect_color,
          });
          effect.preload(this.extension.path);
          break;
        }
      }
      return effect;
    }

    _effectTargets() {
      return [this.renderArea, this._list?._box];
    }

    _updateIconEffect() {
      let targets = this._effectTargets();
      targets.forEach((target) => {
        if (!target) return;
        target.remove_effect_by_name('icon-effect');
        let effect = this._createEffect(this.extension.icon_effect);
        if (effect) {
          effect.color = this.extension.icon_effect_color;
          target.add_effect_with_name('icon-effect', effect);
        }
        target.iconEffect = effect;
      });
    }

    _updateIconEffectColor(color) {
      let targets = this._effectTargets();
      targets.forEach((target) => {
        try {
          if (target && target.iconEffect) {
            target.iconEffect.color = color;
          }
        } catch(err) {
          // console.log(err)
        }
      });
    }

    slideIn() {
      if (this._hidden) {
        this._hidden = false;
        this._beginAnimation();
      }
    }

    slideOut() {
      if (this._list && this._list.visible) {
        return;
      }
      if (!this._hidden) {
        this._hidden = true;
        this._beginAnimation();
      }
    }

    getMonitor() {
      // docks from config.json keep the monitor they were created for
      if (!this._config) {
        this._monitorIndex = this.extension._queryDisplay(this._monitorIndex);
      }
      let m =
        Main.layoutManager.monitors[this._monitorIndex] ||
        Main.layoutManager.primaryMonitor;
      this._monitor = m;
      return m;
    }

    createDash() {
      this._pauseAllBounce(1500);
      if (this.dash) {
        this.destroyDash();
      }

      this.Dash = Dash;
      let dash;
      [dash, this._dashConnections] = createTrackedDash();
      dash._d2dlOwner = this;

      let orig = dash._createAppItem;
      orig = orig.bind(dash);
      dash._createAppItem = function (app) {
        let item = orig.call(this, app);
        this.opacity = 0;
        item.child.visible = false;
        guardBaseIcon(item.child?.icon, item.child);
        return item;
      };

      dash.handleDragOver = (source, actor, x, y, time) =>
        this._handleDashDragOver(dash, source, x, y);
      dash.acceptDrop = (source, actor, x, y, time) =>
        this._acceptDashDrop(dash, source, x, y);
      // Reuse a placeholder as it moves and remove it synchronously. Stock
      // Dash animates old placeholders out, blocking subsequent positions.
      dash._clearDragPlaceholder = () => this._clearDashPlaceholder(dash);
      dash._clearEmptyDropTarget = () => this._clearEmptyDashDropTarget(dash);
      dash.connect('destroy', () => this._prepareDashDestroy(dash));

      this.dash = dash;
      this.dash._background.visible = false;
      this.dash._box.clip_to_allocation = false;

      this._extraIcons = new St.BoxLayout();
      this.dash._box.add_child(this._extraIcons);

      // null these - needed when calling recreateDash
      this._trashIcon = null;

      this._separator = new St.Widget({
        style_class: 'dash-separator',
        y_align: Clutter.ActorAlign.CENTER,
        height: 48,
      });
      this._separator.name = 'separator';
      this._extraIcons.add_child(this._separator);

      this.dash.reactive = true;
      this.dash.track_hover = true;
      this.dash.connectObject(
        'scroll-event',
        this._onScrollEvent.bind(this),
        'button-press-event',
        this._onButtonPressEvent.bind(this),
        'motion-event',
        this._onMotionEvent.bind(this),
        'enter-event',
        this._onEnterEvent.bind(this),
        'leave-event',
        this._onLeaveEvent.bind(this),
        'destroy',
        () => {},
        this
      );

      this.dash.opacity = 0;
      return dash;
    }

    _clearDashLabelTimeouts(dash) {
      for (const name of ['_showLabelTimeoutId', '_resetHoverTimeoutId']) {
        if (dash[name]) GLib.source_remove(dash[name]);
        dash[name] = 0;
      }
      dash._labelShowing = false;
    }

    _redisplayDash(dash) {
      if (dash !== this.dash || dash._d2dlDestroying || this._destroyed) return;
      const favorites = Fav.getAppFavorites().getFavorites();
      const favoriteIds = new Set(favorites.map(app => app.get_id()));
      const apps = [...favorites];
      for (const app of dash._appSystem.get_running()) {
        if (!favoriteIds.has(app.get_id())) apps.push(app);
      }
      const wanted = new Set(apps.map(app => app.get_id()));
      const items = new Map();
      for (const item of dash._box.get_children().filter(isDashAppItem)) {
        const id = item.child._delegate.app.get_id();
        if (!wanted.has(id) || items.has(id)) {
          this._clearDashLabelTimeouts(dash);
          prepareIconDestroy(item);
          this._cleanupIcon(item);
          item.destroy();
        } else {
          items.set(id, item);
        }
      }
      // Reordering favorites preserves AppIcon, its texture and active drag
      // gesture. Destroy/recreate during a hovered reorder can abort Clutter.
      apps.forEach((app, index) => {
        let item = items.get(app.get_id());
        if (!item) {
          item = dash._createAppItem(app);
          dash._box.insert_child_at_index(item, index);
          item.show(false);
        } else {
          dash._box.set_child_at_index(item, index);
        }
      });
      if (favoriteIds.size > 0 && favoriteIds.size < apps.length) {
        if (!dash._separator) {
          dash._separator = new St.Widget({style_class: 'dash-separator'});
          dash._box.add_child(dash._separator);
        }
        dash._box.set_child_at_index(dash._separator, favorites.length);
      } else if (dash._separator) {
        dash._separator.destroy();
        dash._separator = null;
      }
      if (this._extraIcons?.get_parent() === dash._box)
        dash._box.set_child_above_sibling(this._extraIcons, null);
      if (dash._dragPlaceholder) this._positionDashPlaceholder(dash);
      dash._shownInitially = true;
      this._icons = null;
      this._favorite_ids = [...favoriteIds];
      this._beginAnimation();
    }

    _setDragState(dragging, icon = null) {
      this._dragging = dragging;
      this._dragged = dragging ? icon ?? this._dragged : null;
      this._icons = null;
      if (!this._destroyed && this.dash && !this.dash._d2dlDestroying) {
        this._beginAnimation();
        this.autohider?._debounceCheckHide();
      }
    }

    _getDashDrop(dash, source, x, y) {
      if (dash !== this.dash || dash._d2dlDestroying || this._destroyed ||
          !global.settings.is_writable('favorite-apps')) return null;
      const app = getAppFromSource(source);
      if (!app || app.is_window_backed?.() || !app.get_id) return null;
      const favorites = Fav.getAppFavorites().getFavorites();
      const ids = favorites.map(favorite => favorite.get_id());
      const byId = new Map(dash._box.get_children().filter(item =>
        isDashAppItem(item) && item.visible && !item.animatingOut
      ).map(item => [item.child._delegate.app.get_id(), item]));
      const vertical = this.isVertical();
      const centers = [];
      for (const id of ids) {
        const item = byId.get(id);
        // A favorites signal is queued for redisplay. Wait until geometry
        // matches the favorite list, rather than selecting the wrong slot.
        if (!item) return null;
        const target = item._renderer?.visible ? item._renderer : item;
        const [cx, cy] = target.get_transformed_position();
        const [cw, ch] = target.get_transformed_size();
        centers.push(vertical ? cy + ch / 2 : cx + cw / 2);
      }
      // DND coordinates are local to _box, including touch drags; querying
      // global.get_pointer() would use an unrelated mouse position on touch.
      const [boxX, boxY] = dash._box.get_transformed_position();
      const [boxW, boxH] = dash._box.get_transformed_size();
      const pointer = vertical
        ? boxY + y * (dash._box.height ? boxH / dash._box.height : 1)
        : boxX + x * (dash._box.width ? boxW / dash._box.width : 1);
      const reversed = !vertical &&
        dash._box.text_direction === Clutter.TextDirection.RTL;
      const slot = getDropSlot(pointer, centers, reversed);
      return slot === null ? null : {app, ids, slot};
    }

    _clearDashPlaceholder(dash) {
      const placeholder = dash._dragPlaceholder;
      dash._dragPlaceholder = null;
      dash._dragPlaceholderPos = -1;
      dash._d2dlDropSource = null;
      placeholder?.destroy();
    }

    _ensureEmptyDashDropTarget(dash) {
      if (dash._emptyDropTarget) return;
      const favorites = new Set(Fav.getAppFavorites().getFavorites().map(app => app.get_id()));
      const hasApplications = dash._box.get_children().some(item =>
        isDashAppItem(item) && item.visible && !item.animatingOut &&
        (!this.extension.favorites_only || favorites.has(item.child._delegate.app.get_id()))
      );
      const hasExtras = this._extraIcons?.visible &&
        this._extraIcons.get_children().some(item => isDashAppItem(item) && item.visible);
      if (hasApplications || hasExtras) return;

      // The stock Dash checks child count, but our always-present extras box
      // prevents its empty target even when every application is hidden.
      const target = new St.Bin({ style_class: 'empty-dash-drop-target', reactive: false });
      const size = Math.max(1, (this._iconSizeScaledDown || dash.iconSize) * (this._scaleFactor || 1));
      target.set_size(size, size);
      dash._emptyDropTarget = target;
      dash._box.insert_child_at_index(target, 0);
    }

    _clearEmptyDashDropTarget(dash) {
      const target = dash._emptyDropTarget;
      dash._emptyDropTarget = null;
      target?.destroy();
    }

    _positionDashPlaceholder(dash) {
      const placeholder = dash._dragPlaceholder;
      const apps = dash._box.get_children().filter(isDashAppItem);
      const numFavorites = Fav.getAppFavorites().getFavorites().length;
      const anchor = dash._separator && dash._dragPlaceholderPos >= numFavorites
        ? dash._separator : apps[dash._dragPlaceholderPos] ?? this._extraIcons;
      dash._box.set_child_below_sibling(placeholder, anchor);
    }

    _handleDashDragOver(dash, source, x, y) {
      const drop = this._getDashDrop(dash, source, x, y);
      if (!drop) {
        this._clearDashPlaceholder(dash);
        return DND.DragMotionResult.NO_DROP;
      }
      const id = drop.app.get_id();
      if (planFavoriteDrop(drop.ids, id, drop.slot).unchanged) {
        this._clearDashPlaceholder(dash);
        return DND.DragMotionResult.CONTINUE;
      }
      if (!dash._dragPlaceholder) {
        dash._dragPlaceholder = new St.Bin({
          style_class: 'placeholder',
          reactive: false,
        });
        dash._box.add_child(dash._dragPlaceholder);
      }
      const size = this._iconSizeScaledDown || dash.iconSize;
      const scale = this._scaleFactor || 1;
      dash._dragPlaceholder.set_size(
        Math.max(1, size * scale * (this.isVertical() ? 1 : 0.5)),
        Math.max(1, size * scale * (this.isVertical() ? 0.5 : 1))
      );
      dash._dragPlaceholderPos = drop.slot;
      dash._d2dlDropSource = id;
      this._positionDashPlaceholder(dash);
      return DND.DragMotionResult.MOVE_DROP;
    }

    _cancelFavoriteDrop(dash) {
      if (!dash._d2dlFavoriteLater) return;
      global.compositor.get_laters().remove(dash._d2dlFavoriteLater);
      dash._d2dlFavoriteLater = 0;
    }

    _acceptDashDrop(dash, source, x, y) {
      const drop = this._getDashDrop(dash, source, x, y);
      if (!drop) return false;
      const id = drop.app.get_id();
      const slot = dash._d2dlDropSource === id && dash._dragPlaceholder
        ? dash._dragPlaceholderPos : drop.slot;
      const plan = planFavoriteDrop(drop.ids, id, slot);
      if (plan.unchanged) return true;
      this._cancelFavoriteDrop(dash);
      dash._d2dlFavoriteLater = global.compositor.get_laters().add(
        Meta.LaterType.BEFORE_REDRAW,
        () => {
          dash._d2dlFavoriteLater = 0;
          if (dash !== this.dash || dash._d2dlDestroying || this._destroyed ||
              !global.settings.is_writable('favorite-apps')) return GLib.SOURCE_REMOVE;
          const favorites = Fav.getAppFavorites();
          const ids = favorites.getFavorites().map(app => app.get_id());
          // A favorite removed elsewhere while this move was queued stays
          // removed. Dragging a new app into the dock still pins it.
          if (drop.ids.includes(id) && !ids.includes(id)) return GLib.SOURCE_REMOVE;
          const position = resolveFavoriteDrop(ids, id, plan);
          if (ids.includes(id)) favorites.moveFavoriteToPos(id, position);
          else favorites.addFavoriteAtPos(id, position);
          return GLib.SOURCE_REMOVE;
        }
      );
      return true;
    }

    addToChrome() {
      if (this._onChrome) {
        return;
      }

      this._updateIconEffect();

      Main.layoutManager.addChrome(this.struts, {
        affectsStruts: !this.extension.autohide_dash,
        ...inputRegionParam(false),
        trackFullscreen: false,
      });

      // X11 only: the struts span the whole monitor edge, so they can't be
      // the input region too - that swallowed clicks along the entire edge.
      // This actor follows the dock background instead (see animator).
      if (SHELL_HAS_INPUT_REGION) {
        Main.layoutManager.addChrome(this.inputArea, {
          affectsStruts: false,
          ...inputRegionParam(true),
          trackFullscreen: true,
        });
      }

      Main.layoutManager.addChrome(this, {
        affectsStruts: false,
        ...inputRegionParam(false),
        trackFullscreen: true,
      });

      Main.layoutManager.addChrome(this.dwell, {
        affectsStruts: false,
        ...inputRegionParam(false),
        trackFullscreen: false,
      });

      this._onChrome = true;
    }

    removeFromChrome() {
      if (!this._onChrome) {
        return;
      }
      if (SHELL_HAS_INPUT_REGION && this.inputArea) {
        Main.layoutManager.removeChrome(this.inputArea);
      }
      Main.layoutManager.removeChrome(this.struts);
      Main.layoutManager.removeChrome(this);
      Main.layoutManager.removeChrome(this.dwell);
      this._onChrome = false;
      this._removeIconEffect();
    }

    isVertical() {
      return (
        this._position == DockPosition.LEFT ||
        this._position == DockPosition.RIGHT
      );
    }

    _preferredIconSize() {
      let preferredIconSizes = this._preferredIconSizes;
      let iconSize = 64;
      if (!preferredIconSizes) {
        preferredIconSizes = [32];
        for (let i = 16; i <= 128; i += 4) {
          preferredIconSizes.push(i);
        }
        this._preferredIconSizes = preferredIconSizes;
      }

      //! why the need for upscaling
      let upscale = 1 + (2 - this._scaleFactor) || 1;
      if (upscale < 1) {
        upscale = 1; // does scaleFactor go beyond 2x?
      }
      // console.log(`scaleFactor:${this._scaleFactor} upscale:${upscale}`);
      iconSize =
        upscale *
        (preferredIconSizes[
          Math.floor(this.extension.icon_size * preferredIconSizes.length)
        ] || 64);
      iconSize *= this.extension.scale;

      if (this.extension._config.icon_size) {
        iconSize = this.extension._config.icon_size;
      }

      this._iconSize = iconSize;
      return iconSize;
    }

    // Structure for dash icon container widgets - g42,g43,g44,g45,g46
    /**
     *  DashItemContainer
     *    > child (DashIcon[appwell])
     *      > .icon (IconGrid)
     *        > .icon (StIcon)
     *      > ._dot
     *    > .label
     *
     *  ShowAppsIcon extends DashItemContainer
     *    > .icon (IconGrid)
     *      > .icon
     *    > ._iconActor
     */

    // Helper: robustly get the StIcon from a DashIcon/AppIcon instance
    // Supports both GNOME 46 (old) and GNOME 50 (new) structures
    _getStIconFromAppwell(appwell) {
      if (!appwell || !appwell.icon) return null;
      let baseIcon = appwell.icon; // BaseIcon or old IconGrid

      if (baseIcon instanceof St.Icon) return baseIcon;

      // Try direct .icon property (works after setIconSize is called)
      if (baseIcon.icon) return baseIcon.icon;
      // GNOME 50: try _iconBin.child
      if (baseIcon._iconBin && baseIcon._iconBin.child) return baseIcon._iconBin.child;
      // Style initialization owns texture creation. Recreating a missing
      // texture here can run while Clutter is destroying or allocating it.
      return null;
    }
    
    _inspectIcon(c) {
      if (!c.visible || c.animatingOut || c._d2dlDestroying) return false;

      /* release any reference once destroyed */
      if (!c._destroyConnectId) {
        c._destroyConnectId = c.connect('destroy', () => {
          c._d2dlDestroying = true;
          if (c._icon === this._dragged) this._setDragState(false);
          this._cleanupIcon(c);
          this._icons = null;
          c._label = null;
          c._icon = null;
          c._appwell = null;
          c._prev = null;
          c._next = null;
        });
      }

      /* separator */
      c._cls = c._cls || c.get_style_class_name();
      if (c._cls === 'dash-separator') {
        this._separators.push(c);
        this._dashItems.push(c);
        c.visible = true;
        c.style = 'margin-left: 8px; margin-right: 8px;';
        return false;
      }

      /* ShowAppsIcon - GNOME 50: has .icon (BaseIcon) directly and .child (toggleButton) */
      /* ShowAppsIcon - GNOME 46: has .icon.icon (StIcon) */
      if (c.icon /* BaseIcon or old IconGrid */) {
        guardBaseIcon(c.icon, c);
        let stIcon = null;
        // GNOME 50: icon is BaseIcon, icon.icon might be null initially
        stIcon = this._getStIconFromAppwell(c);
        if (!stIcon && c.icon.icon) {
          stIcon = c.icon.icon;
        }
        if (stIcon) {
          c._icon = stIcon;
          // GNOME 50: child is toggleButton; GNOME 46: child is the button directly
          c._button = c.child;
          try {
            c.icon.style = 'background-color: transparent !important;';
          } catch (err) {
            // ignore
          }
        }
      } else if (c.child /* DashIcon/AppIcon */) {
        let appwell = c.child;
        let stIcon = null;
        if (appwell.icon /* BaseIcon or old IconGrid */) {
          guardBaseIcon(appwell.icon, appwell);
          stIcon = this._getStIconFromAppwell(appwell);
          if (!stIcon && appwell.icon.icon) {
            stIcon = appwell.icon.icon;
          }
        }
        if (stIcon) {
          c._grid = appwell.icon; // BaseIcon or old IconGrid
          c._icon = stIcon;
          c._appwell = appwell;
          if (c._appwell) {
            c._appwell.visible = true;
            c._dot = c._appwell._dot;

            let app = c._appwell.app;
            let appId = app ? app.get_id() : '';

            // hide icons if favorites only
            if (
              !c.custom_icon &&
              this._favorite_ids &&
              !this._favorite_ids.includes(appId)
            ) {
              if (this.extension.favorites_only) {
                c._appwell.visible = false;
                c.width = -1;
                c.height = -1;
                return false;
              } else if (!c._found) {
                c._found = true;
              }
            }
          }
          if (c._dot) {
            c._dot.opacity = 0;
          }
        }
      }
      
      if (c._icon) {
        const texture = c._icon;
        if (!texture._d2dlInvalidationConnected) {
          texture._d2dlInvalidationConnected = true;
          texture.connectObject('destroy', () => {
            if (this._dragged === texture) this._setDragState(false);
            if (c._icon === texture) c._icon = null;
            this._icons = null;
          }, c);
        }
        // renderer takes care of displaying an icon
        c._icon.opacity = 0;
        c._label = c.label;

        if (c._label && !c._destroyLabelConnectId) {
          c._destroyLabelConnectId = c._label.connect('destroy', () => {
            c._label = null;
          });
        }

        // limitation: vertical layout cannot do apps_icon_front
        if (
          c == this.dash._showAppsIcon &&
          this.extension.apps_icon_front &&
          !this.isVertical()
        ) {
          this._icons.unshift(c);
          this._dashItems.unshift(c);
        } else {
          this._icons.push(c);
          this._dashItems.push(c);
        }
        return true;
      }

      return false;
    }

    _cleanupIcon(c) {
      if (c._image && c._image.get_parent()) {
        if (this._clock === c._image) this._clock = null;
        if (this._calendar === c._image) this._calendar = null;
        c._image.destroy();
      }
      c._image = null;
      c._clock = null;
      c._calendar = null;
      // Menus are parented in Main.uiGroup, so destroying an item does not
      // destroy its popup actor. Detach managers before removing that actor,
      // and clear both references when custom items share the same menu.
      const appwell = c.child;
      const menus = new Set([c._menu, appwell?._menu].filter(Boolean));
      c._menu = null;
      if (appwell) appwell._menu = null;
      for (const menu of menus) {
        menu.close();
        c._menuManager?.removeMenu(menu);
        appwell?._menuManager?.removeMenu(menu);
        menu.destroy();
      }
      c._label = null;
      c._prev = null;
      c._next = null;
    }

    _destroyDockItem(item) {
      prepareIconDestroy(item);
      this._cleanupIcon(item);
      item.destroy();
      this._icons = null;
    }

    _findIcons() {
      if (this._icons && !this._dragging) {
        let _boxIconsLength = this.dash._box.get_children().length;
        if (_boxIconsLength != this._boxIconsLength) {
          this._icons = null;
        }
        this._boxIconsLength = _boxIconsLength;
        if (this._extraIcons) {
          let _extraIconsLength = this._extraIcons.get_children().length;
          if (_extraIconsLength != this._extraIconsLength) {
            this._icons = null;
          }
          this._extraIconsLength = _extraIconsLength;
        }
      }

      if (this._icons) {
        // use icons cache
        return this._icons;
      }

      this._dashItems = [];
      this._separators = [];
      this._icons = [];

      if (!this.dash) return [];

      //--------------------
      // find favorites and running apps icons
      //--------------------
      this.dash._box.get_children().forEach((icon) => {
        this._inspectIcon(icon);
      });

      // hide separator between running apps and favorites - if not needed
      if (this.dash._separator) {
        this.dash._separator.visible = !this.extension.favorites_only;
      }

      //--------------------
      // find custom icons (trash, mounts, downloads, etc...)
      //--------------------
      if (this._extraIcons) {
        this._extraIcons.get_children().forEach((icon) => {
          this._inspectIcon(icon);
        });
        this._extraIcons.visible = this._extraIcons.get_children().length > 1;
      }

      //--------------------
      // find the showAppsIcon
      //--------------------
      if (this.dash._showAppsIcon) {
        this.dash._showAppsIcon.visible = this.extension.apps_icon;
        if (this._inspectIcon(this.dash._showAppsIcon)) {
          // presses on the icon bubble up to the item; handle them there
          // since the icon may be allocated no space (Gnome 42 to 46)
          let appsIcon = this.dash._showAppsIcon;
          if (!appsIcon._pressConnected) {
            appsIcon._pressConnected = true;
            appsIcon.reactive = true;
            appsIcon.connectObject(
              'button-press-event',
              () => {
                const showAppsButton = Main.overview.dash.showAppsButton ??
                  Main.overview.dash._showAppsIcon?.toggleButton;
                if (Main.overview.visible && showAppsButton && showAppsButton.checked) {
                  Main.overview.hide();
                } else {
                  Main.overview.showApps();
                }
                return Clutter.EVENT_STOP;
              },
              'enter-event',
              () => {
                if (!appsIcon._d2dlDestroying) appsIcon.showLabel();
              },
              'leave-event',
              () => {
                if (!appsIcon._d2dlDestroying) appsIcon.hideLabel();
              },
              this
            );
          }
        }
      }

      let noAnimation = !this.extension.animate_icons_unmute;

      let pv = new Point();
      pv.x = 0.5;
      pv.y = 0.5;
      this._icons.forEach((c) => {
        if (!c._showLabel && c.showLabel) {
          c._showLabel = c.showLabel;
          c.showLabel = () => {
            if (this.extension.hide_labels) {
              return;
            }
            if (c._label) {
              c._showLabel();
            }
          };
        }
        c._icon.pivot_point = pv;
        if (c._button) {
          c._button.reactive = noAnimation;
          c._button.track_hover = noAnimation;
          c.toggle_mode = false;
        }
        if (c._grid) {
          // c._grid.style = noAnimation ? '' : 'background: none !important;';
          c._grid.style = 'background: none !important;';
        }
        if (c._appwell && !c._appwell._activate) {
          c._appwell._activate = c._appwell.activate;
          c._appwell.activate = (button) => {
            try {
              if (!c._menu) {
                this._maybeBounce(c);
              }
              this._maybeMinimizeOrMaximize(c._appwell.app, button);
              // pass the button on: middle click opens a new window
              c._appwell._activate(button);
            } catch (err) {
              // happens with dummy DashIcons
            }
          };
        }
        let { _draggable } = c.child || {};
        if (_draggable && !_draggable._dragBeginId) {
          _draggable._dragBeginId = _draggable.connect('drag-begin', () => {
            this._setDragState(true, c._icon);
          });
          _draggable._dragEndId = _draggable.connect('drag-end', () => {
            this._setDragState(false);
          });
          _draggable._dragCancelledId = _draggable.connect('drag-cancelled', () => {
            this._setDragState(false);
          });
          c.connect('destroy', () => {
            for (const name of ['_dragBeginId', '_dragEndId', '_dragCancelledId']) {
              if (_draggable[name]) _draggable.disconnect(_draggable[name]);
              _draggable[name] = 0;
            }
          });
        }
      });

      // link list the dash items
      //! optimize this. there has to be a better way to get the separators _prev and _next
      let prev = null;
      this._dashItems.forEach((c) => {
        if (prev) {
          prev._next = c;
        }
        c._prev = prev;
        c._next = null;
        prev = c;
      });

      return this._icons;
    }

    _updateExtraIcons() {
      if (!this._extraIcons || this._dragging) {
        return;
      }
      const services = this.extension.services;
      const mounted = this.extension.mounted_icon ? Object.keys(services._mounts) : [];
      const state = [this._extraIcons, this.extension.downloads_icon,
        this.extension.trash_icon, services._downloadsDir, mounted.join('\0')];
      if (this._extraIconState?.every((value, index) => value === state[index])) return;

      // check these intermittently!
      //---------------
      // the mount icons
      //---------------
      {
        //! avoid creating app_info & /tmp/*.desktop files
        let extras = [...this._extraIcons.get_children()];
        let extraMountPaths = extras.map((e) => e._mountPath);

        extras.forEach((extra) => {
          if (!extra._mountType) {
            return;
          }
          if (!mounted.includes(extra._mountPath)) {
            this._destroyDockItem(extra);
          }
        });

        mounted.forEach((mount) => {
          if (!extraMountPaths.includes(mount)) {
            let mountedIcon = this.createItem(mount);
            mountedIcon._mountType = true;
            mountedIcon._mountPath = mount;
            this._icons = null;
          }
        });
      }

      //---------------
      // the folder icons
      //---------------
      //! add explanations
      let folders = [
        {
          icon: '_downloadsIcon',
          folder: this.extension.services._downloadsDir?.get_path(),
          //! find a way to avoid this
          path: tempPath('downloads-dash2dock-lite.desktop'),
          show: this.extension.downloads_icon,
          items: '_downloadFiles',
          itemsLength: '_downloadFilesLength',
          prepare: (() => {
            this.extension.services._debounceCheckDownloads();
          }).bind(this),
          cleanup: () => {},
        },
      ];

      folders.forEach((f) => {
        if (this[f.icon] && f.show && this[f.icon]._folder !== f.folder) {
          this._destroyDockItem(this[f.icon]);
          this[f.icon] = null;
        }
        if (!this[f.icon] && f.show) {
          this[f.icon] = DockItemList.createItem(this, f);
          this[f.icon]._folder = f.folder;
          this._icons = null;
        } else if (this[f.icon] && !f.show) {
          // unpin downloads icon
          this._destroyDockItem(this[f.icon]);
          this[f.icon] = null;
        }
        f.cleanup();
      });

      //---------------
      // the trash icon
      //---------------
      if (!this._trashIcon && this.extension.trash_icon) {
        // pin trash icon
        //! avoid creating app_info & /tmp/*.desktop files
        this._trashIcon = this.createItem(
          tempPath('trash-dash2dock-lite.desktop')
        );
        this._icons = null;
      } else if (this._trashIcon && !this.extension.trash_icon) {
        // unpin trash icon
        this._destroyDockItem(this._trashIcon);
        this._trashIcon = null;
      } else if (this._trashIcon && this.extension.trash_icon) {
        // move trash icon to the end
        if (this._extraIcons.last_child != this._trashIcon) {
          this._extraIcons.remove_child(this._trashIcon);
          this._extraIcons.add_child(this._trashIcon);
        }
      }
      this._extraIconState = state;
    }

    _snapToContainerEdge(container, child, edge = true) {
      child.x = container.width / 2 - child.width / 2;
      child.y = container.height / 2 - child.height / 2;
      if (edge) {
        if (this.isVertical()) {
          if (this._position == DockPosition.LEFT) {
            child.x = 0;
          } else {
            child.x = container.width - child.width;
          }
        } else {
          if (this._position == DockPosition.TOP) {
            child.y = 0;
          } else {
            child.y = container.height - child.height;
          }
        }
      }
    }

    layout() {
      if (this._destroyed || !this.dash || !this.dash.last_child) return;

      const locations = [
        DockPosition.BOTTOM,
        DockPosition.LEFT,
        DockPosition.RIGHT,
        DockPosition.TOP,
      ];
      this._position =
        locations[this.extension.dock_location] || DockPosition.BOTTOM;

      if (this._config) {
        if (this._config['position']) {
          this._position = this._config['position'];
        }
      }

      this._updateExtraIcons();

      let m = this.getMonitor();
      if (!m) {
        return false;
      }

      let scaleFactor = m.geometry_scale || 1;
      let vertical = this.isVertical();
      this._scaleFactor = scaleFactor;

      this._icons = this._findIcons();
      const settings = this.extension;
      const state = [this.dash, this.dash.last_child, this._extraIcons,
        this._icons, this._icons.length, m, m.x, m.y, m.width, m.height,
        scaleFactor, this.dash.width, this.dash.height, this._position,
        settings.apps_icon_front, settings.icon_size, settings.scale,
        settings._config.icon_size, settings.icon_spacing,
        settings.animation_spread, settings.animation_magnify,
        settings.edge_distance, settings.panel_mode];
      if (this._layoutState?.every((value, index) => value === state[index])) return true;

      this.dash.last_child.text_direction = settings.apps_icon_front
        ? Clutter.TextDirection.RTL : Clutter.TextDirection.LTR;
      this.dash._box.text_direction = Clutter.TextDirection.LTR;
      let animation_spread = this.extension.animation_spread;
      // let animation_magnify = this.extension.animation_magnify;

      let iconMargins = 0;
      let iconStyle = '';
      if (this.extension.icon_spacing > 0) {
        let margin = 8 * this.extension.icon_spacing;
        if (vertical) {
          iconStyle = `margin-top: ${margin}px; margin-bottom: ${margin}px;`;
        } else {
          iconStyle = `margin-left: ${margin}px; margin-right: ${margin}px;`;
        }
        iconMargins = margin * 2 * this._icons.length;
      }

      let iconSize = this._preferredIconSize();
      //! why not use icon_spacing? animation spread should only be when animated
      let iconSizeSpaced = iconSize + 2 + 8 * animation_spread;

      let projectedWidth =
        iconSize +
        // (this.animated ? iconSizeSpaced : 0) +
        iconSizeSpaced * (this._icons.length > 3 ? this._icons.length : 3);
      projectedWidth += iconMargins;

      let scaleDown = 1.0;
      let limit = vertical ? 0.96 : 0.98; // use dock_size_limit
      let maxWidth = (vertical ? m.height : m.width) * limit;
      if (projectedWidth * scaleFactor > maxWidth * 0.98) {
        scaleDown = (maxWidth - iconSize / 2) / (projectedWidth * scaleFactor);
      }

      iconSize *= scaleDown;
      iconSizeSpaced *= scaleDown;
      projectedWidth *= scaleDown;

      // make multiple of 2
      iconSize = Math.floor(iconSize / 2) * 2;
      iconSizeSpaced = Math.floor(iconSizeSpaced / 2) * 2;
      projectedWidth = Math.floor(projectedWidth / 2) * 2;

      this._projectedWidth = projectedWidth;
      this._margin = iconMargins;

      this._edge_distance =
        (this.extension.edge_distance || 0) * 20 * scaleFactor;

      if (this.extension.panel_mode) {
        this._edge_distance = 0;
      }

      this._icons.forEach((icon) => {
        icon.width = Math.floor(iconSizeSpaced * scaleFactor);
        icon.height = Math.floor(iconSizeSpaced * scaleFactor);
        if (icon.style != iconStyle) {
          icon.style = iconStyle;
        }
      });

      //! check with multi-monitor and scaled displays
      // reorient and reposition the dash
      let orientation = vertical
        ? Clutter.Orientation.VERTICAL
        : Clutter.Orientation.HORIZONTAL;
      this.dash.last_child.layout_manager.orientation = orientation;
      this.dash._box.layout_manager.orientation = orientation;
      if (this._extraIcons) {
        this._extraIcons.layout_manager.orientation = orientation;
      }

      // hug the edge
      // if (vertical) {
      //   this.dash.x = this.width * f.edgeX + this.dash.width * f.offsetX;
      //   this.dash.y = this.height / 2 - this.dash.height / 2;
      // } else {
      //   this.dash.x = this.width / 2 - this.dash.width / 2;
      //   this.dash.y = this.height * f.edgeY + this.dash.height * f.offsetY;
      // }

      // computation derived from animation scale
      let magnify = this.extension.animation_magnify * 1.8;
      let fp = iconSize * 2 + iconSize * (0.6 * (1 + magnify));
      // Assign the final bounds directly. Resizing to a whole monitor before
      // shrinking every frame invalidates allocations and offscreen textures.
      this.width = vertical ? fp * scaleFactor : m.width;
      this.height = vertical ? m.height : fp * scaleFactor;
      this._snapToContainerEdge(m, this, true);
      this.x += m.x;
      this.y += m.y;
      this._snapToContainerEdge(this, this.dash, true);

      this._iconSizeScaledDown = iconSize;
      this._scaledDown = scaleDown;

      // dwell
      //! add scaleFactor?
      let dwellHeight = 2;
      if (vertical) {
        this.dwell.width = dwellHeight;
        this.dwell.height = this.height;
        this.dwell.x = m.x;
        this.dwell.y = this.y;
        if (this._position == DockPosition.RIGHT) {
          this.dwell.x = m.x + m.width - dwellHeight;
        }
      } else {
        this.dwell.width = this.width;
        this.dwell.height = dwellHeight;
        this.dwell.x = this.x;
        this.dwell.y = this.y + this.height - this.dwell.height;
        if (this._position == DockPosition.TOP) {
          this.dwell.y = this.y;
        }
      }

      this._layoutState = state;
      return true;
    }

    _updateTransparenies() {
      let transparent =
        (Main.overview.visible || this.extension._inOverview) &&
        this.extension.overview_transparent_background;

      this._background.opacity = transparent ? 0 : 255;

      if (this.animator._bms && this.animator._bms.first_child) {
        this.animator._bms.first_child.visible =
          !transparent && this.extension.blur_background;
      }

      this.extension._updatePanelTransparency(
        this.extension.customize_topbar &&
        (Main.overview.visible || this.extension._inOverview) &&
        this.extension.overview_transparent_topbar_background
      );
    }

    preview() {
      this._preview = PREVIEW_FRAMES;
      this.animator._computed = null;
    }

    animate(dt = 15) {
      if (this._destroyed || !this.dash || this.dash._d2dlDestroying) return;
      if (this._preview) {
        let p = null;

        if (this._icons && this._icons.length) {
          let icon = this._icons[this._icons.length >> 1];
          p = icon._icon.get_transformed_position();
          let s = icon._icon.get_transformed_size();
          p[0] += s[0] / 2;
          p[1] += s[1] / 2;
        }

        if (!p) {
          p = this.dash.get_transformed_position();
          p[0] += this.dash.width / 2;
          p[1] += this.dash.height / 2;
        }

        this.simulated_pointer = p;
        this._preview--;
      }

      //! add layout here instead of at the
      this.animator.animate(dt);

      this.simulated_pointer = null;

      if (this._pauseBounce && this._pauseBounce > 0) {
        this._pauseBounce -= dt;
      }
    }

    //! move these generic functions outside of this class
    _isWithinDash(p) {
      if (this._hidden) {
        return false;
      }
      let xy = this.struts.get_transformed_position();
      let wh = [this.struts.width, this.struts.height];
      if (isInRect([xy[0], xy[1], wh[0], wh[1]], p, 20)) {
        return true;
      }
      return false;
    }

    _beginAnimation(caller) {
      if (this._destroyed || !this.dash || this.dash._d2dlDestroying) return;
      if (this.extension.debug_visual) {
        this.add_style_class_name('hi');
        this.struts.add_style_class_name('hi');
        this.dwell.add_style_class_name('hi');
      }

      if (!this._favorite_ids) this._favorite_ids = Fav.getAppFavorites()._getIds();

      // if (caller) {
      //   console.log(`animation triggered by ${caller}`);
      // }
      if (this.extension._hiTimer && this.debounceEndSeq) {
        this.extension._loTimer.runDebounced(this.debounceEndSeq);
        // this.extension._loTimer.cancel(this.debounceEndSeq);
      }

      this.animationInterval = this.extension.animationInterval;
      if (this.extension._hiTimer) {
        if (!this._animationSeq) {
          this._animationSeq = this.extension._hiTimer.runLoop(
            (s) => {
              this.animate(s._delay);
            },
            this.animationInterval,
            'animationTimer'
          );
        } else {
          this.extension._hiTimer.runLoop(this._animationSeq);
        }
      }
    }

    _endAnimation() {
      if (this._destroyed || !this.dash || this.dash._d2dlDestroying) return;
      if (this.extension.debug_visual) {
        this.remove_style_class_name('hi');
        this.struts.remove_style_class_name('hi');
        this.dwell.remove_style_class_name('hi');
      }

      this._settleAnimation();
      this.autohider._debounceCheckHide();

      let icons = this._icons || this._findIcons();
      if (icons) {
        icons.forEach((c) => {
          if (c._icon) {
            c._icon.set_scale(1, 1);
            c._icon.translation_x = 0;
            c._icon.translation_y = 0;
          }
          if (c.child) {
            c.child.translation_x = 0;
            c.child.translation_y = 0;
          }
          c._scale = 1;
          c._targetScale = 1;
          c._locked = false;
          c._positionCache = null;
        });
      }

      this._icons = null;
      this._dragged = null;
      this._lastHoveredIcon = null;
    }

    _settleAnimation() {
      this._updateFocusedIcon();
      this.extension._hiTimer?.cancel(this._animationSeq);
      this.extension._loTimer?.cancel(this.debounceEndSeq);
      this._animationSeq = null;
      this.debounceEndSeq = null;
      if (this.extension.debug_visual) {
        this.remove_style_class_name('hi');
        this.struts.remove_style_class_name('hi');
        this.dwell.remove_style_class_name('hi');
      }
    }

    _destroyList() {
      if (this._list) {
        this._list.destroy();
        this._list = null;
      }
    }

    _debounceEndAnimation() {
      if (this._destroyed || !this.dash || this.dash._d2dlDestroying) return;
      if (this.extension._loTimer) {
        if (!this.debounceEndSeq) {
          this.debounceEndSeq = this.extension._loTimer.runDebounced(
            () => {
              this._endAnimation();
            },
            ANIM_DEBOUNCE_END_DELAY + this.animationInterval,
            'debounceEndAnimation'
          );
        } else {
          this.extension._loTimer.runDebounced(this.debounceEndSeq);
        }
      }
    }

    cancelAnimations() {
      for (const sequence of this._deferredActions ?? [])
        this.extension._hiTimer?.cancel(sequence);
      this._deferredActions?.clear();
      this._lockedCycle = false;
      this.animator?.cancelAnimations();
      this.extension._hiTimer?.cancel(this._animationSeq);
      this._animationSeq = null;
      this.extension._hiTimer?.cancel(this.autohider?._animationSeq);
      if (this.autohider) this.autohider._animationSeq = null;
      // pending debounced callbacks would otherwise touch a destroyed dock
      this.extension._loTimer?.cancel(this.debounceEndSeq);
      this.debounceEndSeq = null;
      this.extension._loTimer?.cancel(this._debounceBeginAnimateSeq);
      this._debounceBeginAnimateSeq = null;
      this.extension._loTimer?.cancel(this.autohider?._debounceCheckSeq);
      if (this.autohider) this.autohider._debounceCheckSeq = null;
    }

    _updateFocusedIcon() {
      // apply focus
      this._icons?.forEach((icon) => {
        if (!icon._renderer) return;
        if (icon._appwell?.app) {
          let app = icon._appwell?.app;
          if (!app.get_windows) return;
          let windows = this.getAppWindowsFiltered(app);
          windows.forEach((w) => {
            if (w.has_focus()) {
              icon._renderer.set_style_class_name('icon-focused');
              // icon._renderer.style = 'background-color: rgba(255,0,0,0.2); border-radius: 8px;'
            }
          });
        }
      });
    }

    _maybeMinimizeOrMaximize(app, button) {
      if (this._destroyed || !this.dash) return;
      if (!app.get_windows) {
        return;
      }

      // let windows = app.get_windows();
      let windows = this.getAppWindowsFiltered(app);
      if (!windows.length) {
        return;
      }

      let event = Clutter.get_current_event();
      let modifiers = event ? event.get_state() : 0;
      let pressed = event?.type() == Clutter.EventType.BUTTON_PRESS;
      let button1 = (modifiers & Clutter.ModifierType.BUTTON1_MASK) != 0;
      let button2 = (modifiers & Clutter.ModifierType.BUTTON2_MASK) != 0;
      let button3 = (modifiers & Clutter.ModifierType.BUTTON3_MASK) != 0;
      let shift = (modifiers & Clutter.ModifierType.SHIFT_MASK) != 0;
      let isMiddleButton = button == Clutter.BUTTON_MIDDLE || button2;
      let isCtrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) != 0;
      let openNewWindow =
        app.can_open_new_window() &&
        app.state == Shell.AppState.RUNNING &&
        (isCtrlPressed || isMiddleButton);
      if (openNewWindow) return;

      let workspaceManager = global.workspace_manager;
      let activeWs = workspaceManager.get_active_workspace();
      let focusedWindow = null;

      windows.forEach((w) => {
        if (w.has_focus()) {
          focusedWindow = w;
        }
      });

      // delay - allow dash to actually call 'activate' first
      if (focusedWindow) {
        this._runDeferredAction(() => {
          const current = new Set(app.get_windows());
          if (!current.has(focusedWindow)) return;
          if (shift) {
            // Gnome 49 dropped the Meta.MaximizeFlags argument
            let flags = focusedWindow.set_maximize_flags
              ? []
              : [Meta.MaximizeFlags.BOTH];
            if (
              (focusedWindow.is_maximized && focusedWindow.is_maximized()) ||
              (focusedWindow.get_maximized &&
                focusedWindow.get_maximized() == 3)
            ) {
              focusedWindow.unmaximize(...flags);
            } else {
              focusedWindow.maximize(...flags);
            }
          } else {
            windows.forEach((w) => {
              if (current.has(w)) w.minimize();
            });
          }
        }, 50);
      } else {
        const hidden = windows.filter((w) => {
          return w.is_hidden();
        });

        // multi-monitors fix -- where focus can seem to get lost
        if (!hidden.length) {
          let windows = app.get_windows().filter((w) => {
            return w.get_monitor() == this._monitor?.index;
          });
          if (windows.length > 0) {
            this._runDeferredAction(() => {
              const window = app.get_windows().find(w => windows.includes(w));
              if (window) this._raiseAndFocus(window);
            }, 50);
          }
          return;
        }

        this._runDeferredAction(() => {
          const current = new Set(app.get_windows());
          windows.forEach((w) => {
            if (current.has(w) && w.is_hidden()) {
              w.unminimize();
              if (w.has_focus()) {
                w.raise();
              }
            }
          });
        }, 50);
      }
    }

    _pauseAllBounce(t = 250) {
      this._pauseBounce = t;
    }

    _maybeBounce(container, just_do_it) {
      if (this._pauseBounce && this._pauseBounce > 0) {
        return;
      }
      if (!this.extension.open_app_animation) {
        return;
      }
      if (
        !container.child.app ||
        (container.child.app &&
          container.child.app.get_n_windows &&
          !container.child.app.get_n_windows())
      ) {
        if (container.child) {
          this.animator.bounceIcon(container.child);
          return;
        }
      }
      // bounce the custom icons
      if (container.custom_icon || just_do_it) {
        this.animator.bounceIcon(container.child);
      }
    }

    getAppWindowsFiltered(app) {
      var apply_filtering = this.extension.multi_monitor_filter != 0;

      // no filtering needed for a single dock
      if (apply_filtering && this.extension.multi_monitor_preference == 0) {
        apply_filtering = false;
      }

      // no filtering needed on single monitor desktop
      if (apply_filtering && Main.layoutManager.monitors.length == 1) {
        apply_filtering = false;
      }

      // apply filtering only if app appears on multiple monitors
      // 2 - whenever applicable
      if (apply_filtering && this.extension.multi_monitor_filter == 2) {
        var on_current_monitor = false;
        var on_other_monitor = false;

        app.get_windows().forEach((w) => {
          on_current_monitor =
            on_current_monitor || w.get_monitor() == this._monitor.index;
          on_other_monitor =
            on_other_monitor || w.get_monitor() != this._monitor.index;
        });

        if (!(on_current_monitor && on_other_monitor)) {
          apply_filtering = false;
        }
      }

      if (apply_filtering) {
        return app.get_windows().filter((w) => {
          return w.get_monitor() == this._monitor.index;
        });
      }
      return app.get_windows();
    }

    _onScrollEvent(obj, evt) {
      this._lastScrollEvent = evt;
      let pointer = global.get_pointer();
      let target = this._nearestIcon; // this._hoveredIcon;
      // console.log(`${target == this._hoveredIcon}`);
      if (target) {
        if (this._scrollCounter < -2 || this._scrollCounter > 2)
          this._scrollCounter = 0;

        let icon = target;

        // touchpads arrive here as discrete steps that mutter emulates at
        // about one per wheel click, so weigh them like the scrollwheel;
        // a lower weight left touchpad swipes unable to switch windows
        let multiplier = 5;

        let SCROLL_RESOLUTION =
          MIN_SCROLL_RESOLUTION +
          MAX_SCROLL_RESOLUTION -
          (MAX_SCROLL_RESOLUTION * this.extension.scroll_sensitivity || 0);

        if (icon._appwell && icon._appwell.app) {
          this._lastScrollObject = icon;
          let direction = evt.get_scroll_direction();
          switch (direction) {
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.LEFT:
              this._scrollCounter += (1 / SCROLL_RESOLUTION) * multiplier;
              break;
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.RIGHT:
              this._scrollCounter -= (1 / SCROLL_RESOLUTION) * multiplier;
              break;
          }
          this._cycleWindows(icon._appwell.app, evt);
        }
      }
    }

    // an overly sensitive setting will make window cycle too fast. allow a half second pause after each cycle
    _lockCycle() {
      if (this._lockedCycle) return;
      this._lockedCycle = true;
      this._runDeferredAction(() => {
        this._lockedCycle = false;
      }, 150);
    }

    _runDeferredAction(callback, delay) {
      if (this._destroyed || !this.dash || !this.extension._hiTimer) return;
      this._deferredActions ??= new Set();
      const dash = this.dash;
      const sequence = this.extension._hiTimer.runOnce(() => {
        this._deferredActions.delete(sequence);
        if (!this._destroyed && this.dash === dash && !dash._d2dlDestroying)
          callback();
      }, delay);
      if (sequence) this._deferredActions.add(sequence);
      return sequence;
    }

    _raiseAndFocus(w) {
      if (this._destroyed || !w) return;
      let workspaceManager = global.workspace_manager;
      let activeWs = workspaceManager.get_active_workspace();
      const workspace = w.get_workspace();
      if (!workspace) return;
      const time = global.get_current_time();
      if (activeWs == workspace) {
        w.raise();
        w.focus(time);
      } else {
        workspace.activate_with_focus(w, time);
      }
    }

    _cycleWindows(app, evt) {
      if (this._lockedCycle) {
        this._scrollCounter = 0;
        return false;
      }

      let focusId = 0;
      let workspaceManager = global.workspace_manager;
      let activeWs = workspaceManager.get_active_workspace();

      // let windows = app.get_windows();
      let windows = this.getAppWindowsFiltered(app);

      if (evt.get_state() & Clutter.ModifierType.CONTROL_MASK) {
        windows = windows.filter((w) => {
          return activeWs == w.get_workspace();
        });
      }

      let nw = windows.length;
      windows.sort((w1, w2) => {
        return w1.get_id() > w2.get_id() ? -1 : 1;
      });

      //! add explanations
      if (nw > 1) {
        for (let i = 0; i < nw; i++) {
          if (windows[i].has_focus()) {
            focusId = i;
          }
          if (windows[i].is_hidden()) {
            windows[i].unminimize();
            windows[i].raise();
          }
        }

        let current_focus = focusId;

        if (this._scrollCounter < -1 || this._scrollCounter > 1) {
          // one window per step; rounding could skip back to the same one
          focusId = (focusId + Math.sign(this._scrollCounter) + nw) % nw;
          this._scrollCounter = 0;
        }

        if (current_focus == focusId) return;
      } else if (nw == 1) {
        if (windows[0].is_hidden()) {
          windows[0].unminimize();
          windows[0].raise();
        }
      }

      let window = windows[focusId];
      if (window) {
        this._lockCycle();
        this._raiseAndFocus(window);
      }
    }
  }
);
