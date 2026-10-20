'use strict';

import St from 'gi://St';

import { Dot } from './apps/dot.js';
import { DockPosition } from './dock.js';

import { DockItemDotsOverlay, DockItemBadgeOverlay } from './dockItems.js';
import {
  Bounce,
  Linear,
  CubicEaseOut,
  QuadraticEaseOut,
} from './effects/easing.js';

const ANIM_POSITION_PER_SEC = 550 / 1000;
const ANIM_SIZE_PER_SEC = 250 / 1000;
const ANIM_ICON_RAISE = 0.5;
const ANIM_ICON_SCALE = 1.5;
const ANIM_ICON_HIT_AREA = 2.5;
const ANIMATE_CACHE_LOOKUP = 4;

const DOT_CANVAS_SIZE = 96;

export let Animator = class {
  enable() {
    if (this._enabled) return;
    this._enabled = true;
    this._bounceTargets = new Map();
    if (!this._renderers) {
      this._renderers = [];
      this._dots = [];
      this._badges = [];
    }
    this._computed = null;
  }

  disable() {
    this._enabled = false;
    this.cancelAnimations();
    this.dock?._restoreIconInputs?.();
    if (this._target) {
      this._target.destroy_all_children();
    }
    this._renderers = [];
    this._dots = [];
    this._badges = [];
    this._target = null;
    this._dwellIcon = null;
    this._dwellTick = 0;
    this._bms = null;
    this._blur_effects = null;
    this._bmsLayout = null;
    this._computed = null;
  }

  _precreateResources(dock) {
    if (!dock._icons) {
      return false;
    }

    let count = dock._icons.filter(icon => icon._icon).length;
    if (dock.renderArea.get_n_children() === 0) {
      this._renderers = [];
      this._dots = [];
      this._badges = [];
    }
    this._target = dock.renderArea;

    while (this._renderers.length < count) {
      // renderer
      let target = dock.renderArea;
      let renderer = new St.Icon({
        icon_name: 'file',
        name: 'd2daIcon',
        reactive: false,
        icon_size: 24,
      });
      renderer.visible = false;
      target.add_child(renderer);
      this._renderers.push(renderer);

      // Most pinned apps have neither windows nor notifications. Allocate
      // their Cairo surfaces only when an indicator actually has content.
      this._dots.push(null);
      this._badges.push(null);
    }

    while (this._renderers.length > count) {
      this._renderers.pop().destroy();
      this._dots.pop()?.destroy();
      this._badges.pop()?.destroy();
    }

    return true;
  }

  _getOverlay(pool, index, Overlay) {
    if (!pool[index]) {
      const overlay = new Overlay(new Dot(DOT_CANVAS_SIZE));
      overlay.reactive = false;
      this._target.add_child(overlay);
      pool[index] = overlay;
    }
    return pool[index];
  }

  //! begin optimization
  animate(dt) {
    let dock = this.dock;
    if (!this._enabled || !dock || dock._destroyed || !dock.dash) {
      return;
    }
    dt = Number.isFinite(dt) ? Math.max(1, Math.min(dt, 100)) : 15;
    if (dock._hoveredIcon) {
      dock._lastHoveredIcon = dock._hoveredIcon;
    }

    let simulation = false;

    if (!dock.layout()) {
      return;
    }

    if (!this._precreateResources(dock)) {
      return;
    }

    // opacity
    let didFadeIn = false;
    if (dock.opacity < 255) {
      let opacityPerSecond = 255 / 500;
      didFadeIn = true;
      let step = Math.max(1, Math.round(opacityPerSecond * dt));
      dock.opacity = Math.min(255, dock.opacity + step);
      if (dock.renderArea.opacity < 255 && dock.opacity > 50) {
        dock.renderArea.opacity = dock.opacity;
      }
    } else if (dock.renderArea.opacity < 255) {
      dock.renderArea.opacity = 255;
    }

    let m = dock.getMonitor();
    let pointer = global.get_pointer();

    // simulated or transformed pointers
    if (dock.extension.simulated_pointer) {
      pointer = [...dock.extension.simulated_pointer];
      simulation = true;
    }
    if (dock.simulated_pointer) {
      pointer = [...dock.simulated_pointer];
      simulation = true;
    }
    // disable icon scale animation upon hovering an item
    if (
      dock._list &&
      dock._list.visible &&
      dock._list._box &&
      dock._lastHoveredIcon == dock._list._target
    ) {
      pointer[1] -= dock._iconSize * dock._scaleFactor;
    }

    let [px, py] = pointer;

    let vertical = dock.isVertical();
    let isWithin = dock._isWithinDash([px, py]);

    if (m.inFullscreen && !dock.extension._inOverview) {
      isWithin = false;
    }

    let animated = isWithin;
    dock.animated = animated;

    let animateIcons = dock._icons.filter(icon => icon._icon);
    let iconSize = dock._iconSizeScaledDown;
    let scaleFactor = dock._scaleFactor;
    if (!Number.isFinite(iconSize) || iconSize <= 0 ||
        !Number.isFinite(scaleFactor) || scaleFactor <= 0) {
      return;
    }

    let nearestIcon = null;
    let nearestDistance = -1;

    let iconCenterOffset = (iconSize * scaleFactor) / 2;
    let hitArea = iconSize * ANIM_ICON_HIT_AREA * scaleFactor;
    hitArea *= hitArea;

    let idx = 0;
    let prevIcon = null;
    animateIcons.forEach((icon) => {
      if (!icon._icon) return;
      let pos = icon.get_transformed_position();

      if (icon._found && !icon._handled) {
        icon._handled = true;
        dock._maybeBounce(icon, true);
      }

      icon._pos = pos;

      // get nearest
      const dx = pos[0] + iconCenterOffset - px;
      const dy = pos[1] + iconCenterOffset - py;
      const dst = dx * dx + dy * dy;

      if (
        isWithin &&
        (nearestDistance == -1 || nearestDistance > dst) &&
        dst < hitArea
      ) {
        nearestDistance = dst;
        nearestIcon = icon;
        icon._distance = dst;
      }

      icon._targetScale = 1;

      icon._idx = idx++;

      icon._prev = prevIcon;
      icon._next = null;
      if (prevIcon) {
        prevIcon._next = icon;
      }
      prevIcon = icon;
    });

    let noAnimation = !dock.extension.animate_icons_unmute;
    if (dock._dragging) {
      noAnimation = true;
      isWithin = true;
    }
    if ((!simulation && !isWithin) || noAnimation) {
      nearestIcon = null;
    }
    dock._nearestIcon = nearestIcon;

    let didScale = false;
    let didBounce = false;

    //------------------------
    // animation behavior
    //------------------------
    let edge_distance = dock._edge_distance;
    let rise = dock.extension.animation_rise * ANIM_ICON_RAISE;
    let magnify = dock.extension.animation_magnify * ANIM_ICON_SCALE;
    let spread = dock.extension.animation_spread;

    // when not much spreading, minimize magnification
    if (spread < 0.2) {
      magnify *= 0.8;
    }
    // when too much magnification, increase spreading
    if (magnify > 0.15 && spread < 0.55) {
      spread = 0.55 + spread * 0.2;
    }

    let threshold = (iconSize + 10) * 2.5 * scaleFactor;
    if (animated && edge_distance < 0) {
      edge_distance = 0;
    }

    // animate
    const iconTable = animateIcons;

    let scaleAtMax = 1;
    if (magnify != 0) {
      scaleAtMax = 1 + magnify;
    }

    let Ease = QuadraticEaseOut;
    if (dock.extension.animation_rise_curve == 1) {
      Ease = CubicEaseOut;
    }

    animateIcons.forEach((icon) => {
      if (!icon._icon) return;
      let original_pos = icon._pos;

      original_pos[0] += icon.width / 2;
      original_pos[1] += icon.height / 2;

      icon._translate = 0;
      icon._translateRise = 0;

      let scale = 1;
      let dx = original_pos[0] - px;
      if (vertical) {
        dx = original_pos[1] - py;
      }

      //! _p replace with a more descriptive variable name
      icon._p = 0;
      if (dx * dx < threshold * threshold && nearestIcon) {
        let adx = Math.abs(dx);
        let p = 1.0 - adx / threshold;
        // let fp = p * 0.6 * (1 + magnify);
        icon._p = p;

        // affect scale;
        if (magnify != 0) {
          // scale += fp;
          scale = scaleAtMax * Ease(p);
          if (scale < 1) scale = 1;
        }

        // affect rise
        // let sz = iconSize * fp * scaleFactor;
        let sz = iconSize * (scale - 1) * scaleFactor;
        icon._translateRise = sz * rise;
      }

      icon._scale = scale;
      icon._targetScale = scale;

      //! what is the difference between set_size and set_icon_size? and effects
      // set_icon_size resizes the image... avoid changing per frame
      // set_size resizes the widget
      // icon._icon.set_size(iconSize * scale, iconSize * scale);

      //! png image makes this extremely slow -- this may be the cause of "lag" experienced by some users
      //! some themes or apps use PNG instead of SVG... set_scale is apparently resource hog
      if (
        icon._icon.gicon &&
        icon._icon.gicon.file != null &&
        !icon._icon.gicon.file?.get_path()?.toLowerCase().endsWith('svg')
      ) {
        // skip scaling image files!... too costly
      } else {
        icon._icon.set_scale(scale, scale);
      }

      if (!icon._pos) {
        return;
      }
    });

    let largestIconScale = 1;

    //! use better collision test here?
    let hoveredIcon = nearestIcon ?? dock._lastHoveredIcon;
    for (let i = 0; i < iconTable.length; i++) {
      if (iconTable.length < 2) break;
      let icon = iconTable[i];

      if (icon._targetScale > largestIconScale) {
        largestIconScale = icon._targetScale;
        hoveredIcon = icon;
      }

      // if (icon._icon && icon._icon.hover) {
      //   hoveredIcon = icon;
      // }

      let scale = icon._scale;
      if (scale > 1.1) {
        // affect spread
        let offset = Math.floor(
          1.25 * (scale - 1) * iconSize * scaleFactor * spread * 0.5
        );
        // left
        for (let j = i - 1; j >= 0; j--) {
          let left = iconTable[j];
          left._translate -= offset;
        }
        // right
        for (let j = i + 1; j < iconTable.length; j++) {
          let right = iconTable[j];
          right._translate += offset;
        }
      }
    }

    // re-center to hovered icon
    dock._hoveredIcon = hoveredIcon;
    let TRANSLATE_COEF = 24;
    if (nearestIcon) {
      if (magnify > 0) nearestIcon._targetScale += 0.1;
      let adjust = nearestIcon._translate / 2;
      animateIcons.forEach((icon) => {
        if (!icon._icon) return;
        if (icon._scale > 1) {
          let o = -adjust * (2 - icon._scale);
          let nt = icon._translate - o;
          icon._translate =
            (icon._translate * TRANSLATE_COEF + nt) / (TRANSLATE_COEF + 1);
        }
      });
    }

    //-------------------
    // interpolation / animation
    //-------------------
    let renderOffset = dock.renderArea.get_transformed_position();

    let first = animateIcons[0];
    let last = animateIcons[animateIcons.length - 1];

    let slowDown = dock.extension._config.speed_up || 1;
    let hasZoom = animateIcons.some((icon) => {
      let currentScale = icon._icon?.scale_x ?? 1;
      let tx = Math.abs(icon._icon?.translation_x ?? 0);
      let ty = Math.abs(icon._icon?.translation_y ?? 0);
      return Math.abs(currentScale - 1) > 0.01 ||
        Math.abs(icon._targetScale - 1) > 0.01 || tx > 0.5 || ty > 0.5;
    });
    if (!hasZoom) {
      slowDown = 0.5;
    }

    let lockPosition =
      nearestIcon && first && last && first._p == 0 && last._p == 0;

    if (dock._preview) {
      lockPosition = false;
    }

    animateIcons.forEach((icon) => {
      if (!icon._icon) return;
      // this fixes jittery hovered icon
      if (icon._targetScale > 1.9) icon._targetScale = 2;

      icon._scale = icon._targetScale;

      //! make these computation more readable even if more verbose
      let rdir =
        dock._position == DockPosition.TOP ||
        dock._position == DockPosition.LEFT
          ? 1
          : -1;

      let translationX = icon._translate;
      let translationY = icon._translateRise * rdir;
      if (vertical) {
        translationX = icon._translateRise * rdir;
        translationY = icon._translate;
      }

      //-------------------
      // animate position
      //-------------------
      {
        let speed = ANIM_POSITION_PER_SEC * slowDown;
        if (!Number.isFinite(translationX)) translationX = 0;
        if (!Number.isFinite(translationY)) translationY = 0;
        let cx = icon._icon?.translation_x ?? 0;
        let cy = icon._icon?.translation_y ?? 0;
        if (!Number.isFinite(cx)) cx = 0;
        if (!Number.isFinite(cy)) cy = 0;
        const dx = translationX - cx;
        const dy = translationY - cy;
        const distance = Math.hypot(dx, dy);
        const step = speed * dt;
        if (distance > step) {
          translationX = cx + dx * step / distance;
          translationY = cy + dy * step / distance;
        }
      }

      // fix jitterness
      if (lockPosition && icon._p == 0) {
        icon._positionCache = icon._positionCache || [];
        var lockThreshold = 48;
        if (
          (icon._prev && icon._prev._locked) ||
          (icon._next && icon._next._locked)
        ) {
          lockThreshold = 32;
        }
        if (icon._positionCache.length > lockThreshold) {
          [translationX, translationY] =
            icon._positionCache[icon._positionCache.length - 1];
          icon._locked = true;
        } else {
          icon._positionCache.push([translationX, translationY]);

          let edgeItems = ANIMATE_CACHE_LOOKUP;
          if (icon._positionCache.length > edgeItems) {
            let tx = 0; //translationX;
            let ty = 0; //translationY;
            for (let i = 0; i < edgeItems; i++) {
              tx +=
                icon._positionCache[
                  icon._positionCache.length - edgeItems + i
                ][0];
              ty +=
                icon._positionCache[
                  icon._positionCache.length - edgeItems + i
                ][1];
            }
            translationX = tx / edgeItems;
            translationY = ty / edgeItems;
          }
        }
      } else {
        icon._positionCache = null;
        icon._locked = false;
      }

      let curX = icon._icon.translation_x ?? 0;
      let curY = icon._icon.translation_y ?? 0;
      if (!Number.isFinite(curX)) curX = 0;
      if (!Number.isFinite(curY)) curY = 0;
      if (dock.extension.animation_fps <= 0) {
        //! retain this for smoothness at high fps
        if (Math.abs(curX - translationX) > 0.01)
          translationX = (curX + translationX * 3) / 4;
        if (Math.abs(curY - translationY) > 0.01)
          translationY = (curY + translationY * 3) / 4;
      }
      if (Math.abs(curX - translationX) > 0.01 ||
          Math.abs(curY - translationY) > 0.01) didScale = true;
      icon._icon.translation_x = translationX;
      icon._icon.translation_y = translationY;

      // track bounce animation without clearing prematurely
      if (icon._appwell?._bounce) {
        didBounce = true;
      }
    });

    //--------------
    // renderer
    //--------------
    animateIcons.forEach((icon) => {
      if (!icon._icon) return;
      // dock.renderArea.opacity = 100;
      {
        let icon_name = icon._icon.icon_name;
        let app_name =
          icon._appwell?.app?.app_info?.get_id()?.replace('.desktop', '') ??
          null;
        let gicon = null;

        // override icons here
        if (dock.extension.icon_map || dock.extension.app_map) {
          // override via icon name
          if (
            dock.extension.icon_map_cache &&
            dock.extension.icon_map_cache[icon_name]
          ) {
            gicon = dock.extension.icon_map_cache[icon_name];
          }
          if (
            !gicon &&
            dock.extension.icon_map &&
            dock.extension.icon_map[icon_name]
          ) {
            icon_name = dock.extension.icon_map[icon_name];
          }

          // override via app name
          if (
            app_name &&
            dock.extension.app_map_cache &&
            dock.extension.app_map_cache[app_name]
          ) {
            gicon = dock.extension.app_map_cache[app_name];
          }
          if (
            !gicon &&
            dock.extension.app_map &&
            app_name &&
            dock.extension.app_map[app_name]
          ) {
            icon_name = dock.extension.app_map[app_name];
          }
        }

        icon._renderer = this._renderers[icon._idx];
        icon._renderer._icon = icon._icon;
        if (icon._renderer.style_class) {
          icon._renderer.set_style_class_name('');
        }

        if (!icon._appwell?._bounce) {
          icon._renderer.translation_y = 0;
          icon._renderer.translation_x = 0;
        }

        let renderer = icon._renderer;
        if (gicon) {
          // apply override
          if (renderer.gicon !== gicon) renderer.gicon = gicon;

          // replace PNG with override SVG
          if (icon._icon.gicon && icon._icon.gicon.file && icon._icon.gicon !== gicon) {
            icon._icon.gicon = gicon;
          }
        } else {
          if (icon_name) {
            if (renderer.icon_name !== icon_name) renderer.icon_name = icon_name;
          } else {
            if (icon._icon.gicon) {
              if (renderer.gicon !== icon._icon.gicon) renderer.gicon = icon._icon.gicon;
            }
          }
        }

        //-------------------
        // animate scaling at renderer
        //-------------------
        let unscaledIconSize = dock._iconSizeScaledDown * scaleFactor;
        let targetSize = unscaledIconSize * icon._targetScale;
        let currentSize = renderer.icon_size * renderer.scale_x;
        if (!Number.isFinite(currentSize) || currentSize <= 0) {
          currentSize = unscaledIconSize;
        }
        {
          let dst = targetSize - currentSize;
          let mag = Math.abs(dst);
          let dir = Math.sign(dst);
          let accel = 0;
          let pixelOverTime = ANIM_SIZE_PER_SEC * slowDown;
          let deltaSize = pixelOverTime * dir * dt;
          let appliedSize = deltaSize;
          appliedSize += accel;
          if (Math.abs(appliedSize) >= mag) {
            appliedSize = dst;
          }
          targetSize = currentSize + appliedSize;
          if (mag > 0.25) didScale = true;
          icon._deltaSize = appliedSize;
          icon._targetSize = targetSize;
        }
        // compute icon scale based on size
        icon._scale = targetSize / unscaledIconSize;

        let baseSize = 32 * (dock.extension.icon_quality || 1);
        if (renderer.icon_size != baseSize) {
          renderer.set_size(baseSize, baseSize);
          renderer.set_icon_size(baseSize);
        }
        let scaleToTarget = targetSize / baseSize;
        if (renderer.scale_x !== scaleToTarget || renderer.scale_y !== scaleToTarget)
          renderer.set_scale(scaleToTarget, scaleToTarget);

        const pX = icon._pos[0] - icon.width / 2;
        const pY = icon._pos[1] - icon.height / 2;
        let adjustX = icon.width / 2 - targetSize / 2;
        let adjustY = icon.height / 2 - targetSize / 2;

        if (targetSize > icon.height) {
          let rise = (targetSize - icon.height) * 0.5;
          if (vertical) {
            adjustX += rise * (dock._position == 'left' ? 1 : -1);
          } else {
            adjustY += rise * (dock._position == 'bottom' ? -1 : 1);
          }
        }

        //-------------------
        // commit position
        //-------------------
        if (Number.isFinite(pX) && Number.isFinite(pY)) {
          let iconContainer = icon._icon?.get_parent?.();
          if (iconContainer) {
            if (vertical) {
              iconContainer.translation_x = adjustX / 2;
              iconContainer.translation_y = 0;
            } else {
              iconContainer.translation_y = adjustY / 2;
              iconContainer.translation_x = 0;
            }
          }

          let itx = icon._icon?.translation_x ?? 0;
          let ity = icon._icon?.translation_y ?? 0;
          if (isNaN(itx)) itx = 0;
          if (isNaN(ity)) ity = 0;

          let ry = pY + adjustY + ity - renderOffset[1];
          const rx = pX + adjustX + itx - renderOffset[0];
          if (renderer.x !== rx || renderer.y !== ry) renderer.set_position(rx, ry);

          renderer.visible = true;
          icon._px = pX - renderOffset[0];
          icon._py = pY - renderOffset[1];
        }

        let hideLabel = true;

        // label
        if (
          icon === hoveredIcon &&
          !dock.extension.hide_labels &&
          icon._label &&
          icon._label.text &&
          icon._label.text.length
        ) {
          let tSize = renderer.get_transformed_size();
          // let tPos = icon._icon.get_transformed_position();
          let tPos = renderer.get_transformed_position();
          if (isNaN(tPos[0]) || isNaN(tPos[1])) {
            tPos[0] = 0;
            tPos[1] = 0;
          }
          let sw = !isNaN(tSize[0]) ? tSize[0] : 0;
          let sh = !isNaN(tSize[1]) ? tSize[1] : 0;

          if (this._dwellIcon === icon) {
            this._dwellTick += dt;
            if (icon._targetScale > 1 && this._dwellTick <= 450)
              didScale = true;
            if (this._dwellTick > 450 && icon._targetScale > 1) {
              try {
                hideLabel = false;
                if (icon._label.opacity < 255 - 25) {
                  icon._label.opacity += 25;
                  didScale = true;
                } else {
                  icon._label.opacity = 255;
                }
              } catch (err) {
                // label not ready?
              }
            }
          } else {
            this._dwellTick = 0;
            if (icon._targetScale > 1) didScale = true;
          }
          this._dwellIcon = icon;

          // icon._label.style = 'font-size: 32pt';
          // icon._label.set_scale(0.5, 0.5);
          let lsz = icon._label.get_transformed_size();
          if (!isNaN(lsz[0]) && !isNaN(lsz[1])) {
            icon._label.x = tPos[0] + sw / 2 - lsz[0] / 2;
            icon._label.y = tPos[1] + sh / 2 - lsz[1] / 2;
            if (vertical) {
              if (dock._position == DockPosition.LEFT) {
                icon._label.x += sh / 1.5 + icon._label.width / 2;
              } else {
                icon._label.x -= sh / 1.5 + icon._label.width / 2;
              }
              icon._label.y += 2 * (m.geometry_scale || 1);
            } else {
              if (magnify == 0 || dock._iconSize <= 4) {
                sh *= 1.5;
              }
              if (dock._position == DockPosition.BOTTOM) {
                icon._label.y -= sh / 1.25;
              } else {
                icon._label.y += sh / 1.25;
              }
              icon._label.x += 2 * (m.geometry_scale || 1);
            }
          }
        }

        if (hideLabel && icon._label) {
          icon._label.opacity = 0;
        }

        //! todo... add placeholder opacity when dragging
        renderer.opacity =
          icon._icon == dock._dragged && dock._dragging ? 75 : 255;
      }

      // badges
      //! ***badge location at scaling is messed up***
      const appNotices = icon._appwell
        ? dock.extension.services?._appNotices?.[icon._appwell.app.get_id()]
        : null;
      const noticesCount = appNotices?.count ?? 0;
      if (icon._icon != dock._dragged && noticesCount > 0) {
        const badge = this._getOverlay(this._badges, icon._idx, DockItemBadgeOverlay);
        icon._badge = badge;
        badge.update(icon, {
          noticesCount,
          position: dock._position,
          vertical,
          extension: dock.extension,
        });
        // badge.x = icon._renderer.x + 3 * icon._scale;
        // badge.y = icon._renderer.y - 3 * icon._scale;

        // if (dock._position == DockPosition.TOP) {
        //   badge.y = icon._renderer.y + (icon.height - 6) * icon._scale;
        // }

        badge.width = icon._renderer.width * icon._renderer.scale_x;
        badge.height = badge.width;
        badge.x = icon._renderer.x;
        badge.y = icon._renderer.y;

        badge.set_scale(icon._scale, icon._scale);
        if (!badge.visible) badge.show();
      } else {
        this._badges[icon._idx]?.destroy();
        this._badges[icon._idx] = null;
        icon._badge = null;
      }

      // dots
      //! ***dot requires a little more aligning at dock position other than bottom***
      let appCount = 0;
      if (
        icon._icon != dock._dragged &&
        icon._appwell &&
        icon._appwell.app &&
        icon._appwell.app.get_n_windows
      ) {
        appCount = dock.getAppWindowsFiltered(icon._appwell.app).length;
      }
      if (appCount > 0) {
        const dots = this._getOverlay(this._dots, icon._idx, DockItemDotsOverlay);
        dots.update(icon, {
          appCount,
          position: dock._position,
          vertical,
          extension: dock.extension,
          dock,
        });

        dots.width = icon._renderer.width * icon._renderer.scale_x;
        dots.height = dots.width;
        dots.x = icon._renderer.x;
        dots.y = icon._renderer.y;
        dots.set_scale(icon._scale, icon._scale);
        if (!dots.visible) dots.show();
      } else {
        this._dots[icon._idx]?.destroy();
        this._dots[icon._idx] = null;
      }

      // custom icons
      if (dock.extension.services) {
        dock.extension.services.updateIcon(icon, {
          scaleFactor,
          iconSize,
          dock,
        });
      }
    });

    // separators
    dock._separators.forEach((actor) => {
      let prev = actor._prev; // get_previous_sibling() || actor._prev;
      let next = actor._next; // get_next_sibling();
      if (prev && next && prev._icon && next._icon) {
        actor.translation_x =
          (prev._icon.translation_x + next._icon.translation_x) / 2;
        actor.translation_y =
          (prev._icon.translation_y + next._icon.translation_y) / 2;
        let thickness = dock.extension.separator_thickness || 0;
        //! use ifs for more readability
        actor.width = !vertical
          ? thickness + 0.5
          : iconSize * 0.5 * scaleFactor;
        actor.height = vertical
          ? thickness + 0.5
          : iconSize * 0.75 * scaleFactor;
        actor.visible = thickness > 0;
      }

      let any = next ?? prev;
      if (!vertical && any) {
        actor.translation_y = any.height / 2 - actor.height / 2;
      } else if (vertical && any) {
        // actor.translation_x = any.width / 2 - actor.width / 2;
      }
    });

    let targetX = 0;
    let targetY = 0;
    if (dock._hidden && dock.extension.autohide_dash) {
      if (isWithin) {
        dock.slideIn();
      }
    }

    //! use a more descriptive variable name
    let ed =
      dock._position == DockPosition.BOTTOM ||
      dock._position == DockPosition.RIGHT
        ? 1
        : -1;

    // if (!animated && !dock._hidden && dock.extension.peek_hidden_icons) {
    //   edge_distance = -dock._iconSizeScaledDown * scaleFactor / 1.5;
    // }

    //-------------------
    // animate slide in slide out
    //-------------------
    if (dock._hidden) {
      if (vertical) {
        if (dock._position == DockPosition.LEFT) {
          targetX =
            -(dock._background.width + edge_distance * -ed * 2) * scaleFactor;
        } else {
          targetX =
            (dock._background.width - edge_distance * -ed * 2) * scaleFactor;
        }
      } else {
        if (dock._position == DockPosition.BOTTOM) {
          targetY =
            (dock._background.height - edge_distance * -ed * 2) * scaleFactor;
        } else {
          targetY =
            -(dock._background.height + edge_distance * -ed * 2) * scaleFactor;
        }
      }
    }

    // edge
    //! use ifs for more readability
    targetX += vertical ? edge_distance * -ed : 0;
    targetY += !vertical ? edge_distance * -ed : 0;

    // dock translation
    {
      let autohide_slowDown = 1;
      let translationX = targetX;
      let translationY = targetY;
      let speed =
        ((150 + 300 * dock.extension.autohide_speed * scaleFactor) / 1000) *
        autohide_slowDown;

      const dx = targetX - dock.dash.translation_x;
      const dy = targetY - dock.dash.translation_y;
      if (Math.hypot(dx, dy) > 0.5) {
        translationX = dock.dash.translation_x + dx * speed;
        translationY = dock.dash.translation_y + dy * speed;
        didScale = true;
      }

      dock.dash.translation_x = translationX;
      dock.dash.translation_y = translationY;
    }

    // background
    {
      if (dock._background.style != dock.extension._backgroundStyle) {
        dock._background.style = dock.extension._backgroundStyle;
      }
      dock._background.update({
        first,
        last,
        iconSize: dock._iconSizeScaledDown,
        scaleFactor,
        position: dock._position,
        vertical: vertical,
        panel_mode: dock.extension.panel_mode,
        dock,
      });

      // allied areas
      //! this should be at the layout -- make independent of background
      if (dock.inputArea) {
        const [inputX, inputY] = dock._background.get_transformed_position();
        dock.inputArea.x = inputX;
        dock.inputArea.y = inputY;
        dock.inputArea.width = dock._background.width;
        dock.inputArea.height = dock._background.height;
        dock.inputArea.visible = !dock._hidden && dock._background.opacity > 0;
      }

      // struts
      if (vertical) {
        dock.struts.width = Math.max(0,
          dock._background.width +
          iconSize * 0.2 * scaleFactor +
          edge_distance -
          dock._background._padding * scaleFactor);
        // reset what autohide or the previous position left behind
        dock.struts.y = dock.y;
        dock.struts.height = dock.height;

        if (dock.extension.autohide_dash) {
          dock.struts.y = dock._background.y + dock._monitor.y;
          dock.struts.height = dock._background.height;
          // X11 .. click through fix ..
          // dock.struts.width *= 1.25;
        }

        if (dock._position == DockPosition.RIGHT) {
          dock.struts.x = dock.x + dock.width - dock.struts.width;
        } else {
          dock.struts.x = dock.x;
        }
      } else {
        dock.struts.x = dock.x;
        dock.struts.width = dock.width;
        dock.struts.height = Math.max(0,
          dock._background.height +
          iconSize * 0.2 * scaleFactor +
          edge_distance -
          dock._background._padding * scaleFactor);

        if (dock.extension.autohide_dash) {
          dock.struts.x = dock._background.x + dock._monitor.x;
          dock.struts.width = dock._background.width;
          // X11 .. click through fix ..
          // dock.struts.height *= 1.25;
        }

        if (dock._position == DockPosition.BOTTOM) {
          dock.struts.y = dock.y + dock.height - dock.struts.height;
        } else {
          dock.struts.y = dock.y;
        }
      }

      dock._updateTransparenies();
    }

    dock.struts.visible = !dock._hidden;
    dock.dash.opacity = 255;
    for (const icon of animateIcons) dock._syncIconInput?.(icon);
    dock._syncPointerWatch?.(animateIcons.some(icon =>
      icon._scale > 1.01 || Math.abs(icon._icon.translation_x) > 0.5 ||
      Math.abs(icon._icon.translation_y) > 0.5));

    //---------------------
    // animate the list
    //---------------------
    if (dock._list && dock._list.visible && dock._list._target) {
      didScale = dock._list.animate(dt) || didScale;
    }

    if (didFadeIn || didScale || dock._dragging || didBounce || dock._preview) {
      dock.autohider._debounceCheckHide();
      dock._debounceEndAnimation();
    } else {
      dock._settleAnimation();
    }

    dock.extension.integrations.bms_update_size(this);
  }

  cancelAnimations() {
    for (const appwell of this._bounceTargets?.keys() ?? []) {
      this._finishBounce(appwell);
    }
    this._dwellIcon = null;
    this._dwellTick = 0;
  }

  _finishBounce(appwell, reset = true) {
    const state = this._bounceTargets?.get(appwell);
    if (!state) return;
    this._bounceTargets.delete(appwell);
    this.extension._hiTimer?.cancel(state.sequence);
    appwell.disconnect(state.destroyId);
    if (reset) {
      appwell._bounce = false;
      appwell.translation_x = 0;
      appwell.translation_y = 0;
      this._translateBounce(state.container, 0, 0);
    }
  }

  _translateBounce(container, x, y) {
    for (const actor of [container._renderer, container._image, container._badge]) {
      if (!actor) continue;
      actor.translation_x = x;
      actor.translation_y = y;
    }
    this.dock?._syncIconInput?.(container);
    if (container._label) container._label.opacity = 0;
  }

  bounceIcon(appwell) {
    const dock = this.dock;
    const timer = this.extension._hiTimer;
    if (!this._enabled || dock._destroyed || !dock.dash || dock._dragging || !timer) {
      return;
    }
    const container = appwell.get_parent();
    if (!container) return;
    this._finishBounce(appwell);

    const travel = (dock._iconSize / 3) *
      ((0.25 + dock.extension.animation_bounce_height) * 1.5);
    if (!Number.isFinite(travel) || travel <= 0) return;

    // Keep one sequence per actor, and release it before the actor's children
    // are disposed. Looking up an app by a possibly missing _id could animate
    // a different icon after redisplay or leave _bounce set forever after drag.
    const state = {container, sequence: null, destroyId: 0};
    state.destroyId = appwell.connect('destroy', () => {
      this._finishBounce(appwell, false);
    });
    this._bounceTargets.set(appwell, state);
    appwell._bounce = true;

    const apply = (distance) => {
      if (!this._enabled || dock._destroyed || dock._dragging) {
        this._finishBounce(appwell);
        return;
      }
      let x = 0;
      let y = 0;
      if (dock.isVertical()) {
        x = distance * (dock._position === DockPosition.LEFT ? 1 : -1);
      } else {
        y = distance * (dock._position === DockPosition.BOTTOM ? -1 : 1);
      }
      appwell.translation_x = x;
      appwell.translation_y = y;
      this._translateBounce(container, x, y);
    };
    const frames = [];
    const frequency = [3, 1, 2, 3][dock.extension.animation_bounce_frequency] ?? 3;
    for (let i = 0; i < frequency; i++) {
      frames.push({
        _duration: 250,
        _func: frame => apply(Linear.easeNone(frame._time, 0, travel, frame._duration)),
      }, {
        _duration: 750,
        _func: frame => apply(Bounce.easeOut(frame._time, travel, -travel, frame._duration)),
      });
    }
    frames.push({
      _duration: 1,
      _func: () => this._finishBounce(appwell),
    });
    state.sequence = timer.runAnimation(frames);
    dock._beginAnimation();
  }
};
