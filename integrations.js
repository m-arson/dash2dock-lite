import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// these are hacks to make Dash2Dock Animated compatible with other Extensions
//
export const Integrations = class {
  enable() {
    this.hookCompiz();
    this.hookBms();
  }

  disable() {
    this.releaseCompiz();
    this.releaseBms();
  }

  hookCompiz(hook = true) {
    const compiz = Main.extensionManager.lookup(
      'compiz-alike-magic-lamp-effect@hermes83.github.com'
    );
    const target = compiz?.stateObj;
    if (this._compizHook && this._compizHook.target === target && hook && this.extension.lamp_app_animation &&
        target.getIcon === this._compizHook.wrapper) return;
    this.releaseCompiz();
    this._compiz = target ?? null;
    if (target && hook && this.extension.lamp_app_animation && typeof target.getIcon === 'function') {
      const original = target.getIcon;
      // Another extension can retain this wrapper in its own chain. Release
      // our owner on disable so that chain cannot keep this extension alive.
      const state = { owner: this, original };
      const wrapper = function (...args) {
        if (state.owner) return state.owner.compiz_getIcon(...args);
        return state.original.apply(this, args);
      };
      this._compizHook = { target, original, wrapper, state };
      target.getIcon = wrapper;
    }
  }

  releaseCompiz() {
    const hook = this._compizHook;
    this._compizHook = null;
    this._compiz = null;
    if (hook) hook.state.owner = null;
    try {
      if (hook && hook.target.getIcon === hook.wrapper) hook.target.getIcon = hook.original;
    } catch (error) {
      console.warn(`Unable to restore Compiz integration: ${error.message}`);
    }
  }

  // override compiz getIcon
  compiz_getIcon(actor) {
    const metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
    if (!metaWindow) return { x: 0, y: 0, width: 0, height: 0 };
    let [success, icon] = metaWindow.get_icon_geometry();
    if (success) {
      return icon;
    }

    let docks = this.extension.docks ?? [];

    let monitor = Main.layoutManager.monitors[metaWindow.get_monitor()] ?? Main.layoutManager.primaryMonitor;
    if (!monitor) return { x: 0, y: 0, width: 0, height: 0 };
    let dock = docks.find((d) => d._monitorIndex == monitor.index);

    if (!dock) {
      return { x: monitor.x, y: monitor.y, width: 0, height: 0 };
    }

    let dashIcon = null;

    let sz = dock._preferredIconSize();
    let ofs = 0;
    if (sz) {
      let scale = dock.getMonitor()?.geometry_scale || 1;
      ofs = (sz / 2) * scale;
    }

    let pids = null;
    let pid = metaWindow.get_pid();
    if (pid && dock.dash?._box) {
      for (let dashElement of dock.dash._box.get_children()) {
        const app = dashElement.child?._delegate?.app;
        if (!app) continue;
        pids = app.get_pids();
        if (pids && pids.indexOf(pid) >= 0) {
          if (dashElement._renderer) {
            dashElement = dashElement._renderer;
          }
          let transformed_position = dashElement.get_transformed_position();
          if (
            transformed_position &&
            Number.isFinite(transformed_position[0]) &&
            Number.isFinite(transformed_position[1])
          ) {
            dashIcon = {
              x: transformed_position[0],
              y: transformed_position[1],
              width: 0,
              height: 0,
            };
            break;
          }
        }
      }
    }

    if (!dashIcon) {
      return { x: monitor.x, y: monitor.y, width: 0, height: 0 };
    }

    // console.log('compiz-alike-magic-lamp-effect: getIcon');
    // console.log(`x:${dashIcon.x} y:${dashIcon.y} w:${dashIcon.width} h:${dashIcon.height}`);
    let x = dashIcon.x;
    let y = dashIcon.y;
    let w = 0; //dashIcon.width;
    let h = 0; //dashIcon.height;

    switch (dock._position) {
      case 'left':
        x = dock._monitor.x;
        y += ofs;
        break;
      case 'right':
        x = dock._monitor.x + dock._monitor.width;
        y += ofs;
        break;
      case 'top':
        y = dock._monitor.y;
        x += ofs;
        break;
      case 'bottom':
        y = dock._monitor.y + dock._monitor.height;
        x += ofs;
        break;
    }

    dashIcon = {
      x: x,
      y: y,
      width: w,
      height: h,
    };

    return dashIcon;
  }

  hookBms(hook = true) {
    if (!hook) {
      this.releaseBms();
      return;
    }
    let bms = Main.extensionManager.lookup('blur-my-shell@aunetx');
    const target = bms?.stateObj?._dash_to_dock_blur;
    if (this._bmsHook?.target === target && target && this.extension.blur_background &&
        target.update_size === this._bmsHook.wrapper) return;
    this._restoreBmsHook();

    this._bms = bms;
    if (bms && bms.stateObj && bms.metadata?.version >= 70) {
      let obj = bms.stateObj;
      if (obj._dash_to_dock_blur) {
        if (hook && this.extension.blur_background) {
          const target = obj._dash_to_dock_blur;
          const original = target.update_size;
          const wrapper = () => {};
          this._bmsHook = { target, original, wrapper };
          target.update_size = wrapper;
        }
      }
    }
  }

  releaseBms() {
    this._restoreBmsHook();
    (this.extension.docks ?? []).forEach((dock) => {
      if (dock.animator) {
        dock.animator._bms = null;
        dock.animator._blur_effects = null;
        dock.animator._bmsLayout = null;
      }
    });
    this._bms = null;
  }

  _restoreBmsHook() {
    const hook = this._bmsHook;
    this._bmsHook = null;
    try {
      if (hook && hook.target.update_size === hook.wrapper) hook.target.update_size = hook.original;
    } catch (error) {
      console.warn(`Unable to restore Blur My Shell integration: ${error.message}`);
    }
  }

  bms_update_size(animator) {
    let dock = animator.dock;
    if (!dock || dock._destroyed) return;
    // This runs with each animation frame. Most installations do not have
    // Blur My Shell, so avoid enumerating every dock child in that case.
    if (!this._bms) return;

    // blur my shell
    let bms = dock.get_children().find((child) => {
      let name = child.get_name();
      return name === 'bms-dash-backgroundgroup';
    });

    animator._bms = bms;

    if (!bms) {
      animator._bmsLayout = null;
      animator._blur_effects = null;
      return;
    }

    if (bms.visible !== dock.extension.blur_background) {
      bms.visible = dock.extension.blur_background;
    }
    if (!bms.visible) {
      animator._bmsLayout = null;
      return;
    }

    // compatible blur-my-shell version 70
    // bms version 70 supports 46,47..up
    if (
      dock.extension.integrations?._bms?.metadata?.version >= 70
    ) {
      const bg_offset_x = dock._background.x;
      const bg_offset_y = dock._background.y;
      let rw = dock.renderArea.width;
      let rh = dock.renderArea.height;

      let meta_background = bms.first_child?.first_child;
      if (!meta_background) {
        // this should exists
        return;
      }

      const container = bms.first_child;
      let x = 0;
      let y = 0;
      switch (dock._position) {
        case 'left':
        case 'top':
          break;
        case 'right':
          x = -meta_background.width + rw;
          break;
        case 'bottom':
        default:
          y = -meta_background.height + rh;
          break;
      }

      const opacity = (dock.extension.background_color[3] ?? 0.5) * 54 + 200;
      const radius = dock.extension.computed_border_radius;
      const layout = [bms, container, meta_background, x, y, bg_offset_x,
        bg_offset_y, dock._background.width, dock._background.height, opacity, radius];
      if (animator._bmsLayout?.every((value, index) => value === layout[index])) return;
      animator._bmsLayout = layout;

      bms.x = 0;
      bms.y = 0;
      container.x = x;
      container.y = y;
      container.set_clip(bg_offset_x - x, bg_offset_y - y,
        dock._background.width, dock._background.height);
      meta_background.opacity = opacity;

      animator._blur_effects = container.get_effects();
      if (animator._blur_effects) {
        animator._blur_effects.forEach((e) => {
          if (e.constructor.name == 'CornerEffect') {
            e.radius = radius;
          }
        });
      }

      return;
    }

    // bms version incompatible
    bms.visible = false;
    animator._bmsLayout = null;
    animator._blur_effects = null;
  }
};
