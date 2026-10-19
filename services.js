'use strict';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
  tempPath,
  firstInstalledCommand,
} from './utils.js';
// import { trySpawnCommandLine } from 'resource:///org/gnome/shell/misc/util.js';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';

import { Clock } from './apps/clock.js';
import { Calendar } from './apps/calendar.js';

// sync with animator
const CANVAS_SIZE = 120;
const DEBOUNCE_CHECK_TIMEOUT = 750;

// Gio's asynchronous methods use callbacks unless explicitly promisified.
// Keep the wrappers local so other extensions' Gio prototypes are untouched.
function enumerateChildren(directory, attributes, cancellable) {
  return new Promise((resolve, reject) => {
    directory.enumerate_children_async(attributes, Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT, cancellable, (file, result) => {
        try { resolve(file.enumerate_children_finish(result)); }
        catch (error) { reject(error); }
      });
  });
}

function nextFiles(enumerator, count, cancellable) {
  return new Promise((resolve, reject) => {
    enumerator.next_files_async(count, GLib.PRIORITY_DEFAULT, cancellable,
      (source, result) => {
        try { resolve(source.next_files_finish(result)); }
        catch (error) { reject(error); }
      });
  });
}

function queryInfo(file, attributes, cancellable) {
  return new Promise((resolve, reject) => {
    file.query_info_async(attributes, Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
        try { resolve(source.query_info_finish(result)); }
        catch (error) { reject(error); }
      });
  });
}

function closeEnumerator(enumerator) {
  if (!enumerator) return Promise.resolve();
  return new Promise((resolve) => {
    // Closing must still happen after the operation's cancellable is cancelled.
    enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
      try { source.close_finish(result); } catch (error) {}
      resolve();
    });
  });
}

class ServiceCounter {
  constructor(name, interval, callback, advance) {
    advance = advance || 0;
    this.name = name;
    this._interval = interval;
    this._ticks = advance == -1 ? interval : advance;
    this._callback = callback;
  }

  update(elapsed) {
    this._ticks += elapsed;
    if (this._ticks >= this._interval) {
      // Waking after suspend needs one refresh, not a backlog of missed ones.
      this._ticks %= this._interval;
      if (this._callback) {
        this._callback();
      }
      return true;
    }
    return false;
  }
}

export const Services = class {
  enable() {
    if (this._enabled) this.disable();
    this._enabled = true;
    this._generation = (this._generation ?? 0) + 1;
    this._mounts = {};
    this._services = [
      new ServiceCounter('trash', 1000 * 15, () => {
        // A working monitor delivers changes without polling the filesystem.
        if (!this._trashMonitor) this.checkTrash();
      }),
      new ServiceCounter(
        'clock',
        1000 * 60, // every minute
        // 1000 * 1, // every second
        () => {
          if (!this.extension.clock_icon) return;
          this.extension.docks.forEach((d) => {
            d._onClock();
          });
        },
        -1
      ),
      new ServiceCounter(
        'calendar',
        1000 * 60 * 15,
        () => {
          if (!this.extension.calendar_icon) return;
          this.extension.docks.forEach((d) => {
            d._onCalendar();
          });
        },
        -1
      ),
    ];

    this._disableNotifications = 0;

    this._deferredMounts = [];
    this.setupTrash();
    this.setupDownloads();
    this._setupNotifications();

    this.checkMounts();
    this._commitMounts();
  }

  disable() {
    this._enabled = false;
    this._generation = (this._generation ?? 0) + 1;
    this._downloadsCancellable?.cancel();
    this._downloadsCancellable = null;
    this._downloadsCheckPending = false;
    this._trashCancellable?.cancel();
    this._trashCancellable = null;
    this._trashCheckPending = false;
    Main.messageTray.disconnectObject?.(this);
    for (const source of this._notificationSources ?? []) source.disconnectObject(this);
    this._notificationSources = null;
    if (this.extension._loTimer) {
      if (this._debounceCheckDownloadsSeq) {
        this.extension._loTimer.cancel(this._debounceCheckDownloadsSeq);
        this._debounceCheckDownloadsSeq = null;
      }
    }
    if (this._downloadsMonitor) {
      this._downloadsMonitor.disconnectObject(this);
      this._downloadsMonitor.cancel();
      this._downloadsMonitor = null;
    }
    this._services = [];
    if (this._volumeMonitor) {
      this._volumeMonitor.disconnectObject(this);
      this._volumeMonitor = null;
    }
    if (this._trashMonitor) {
      this._trashMonitor.disconnectObject(this);
      this._trashMonitor.cancel();
      this._trashMonitor = null;
    }
    this._trashDir = null;
    this._downloadsDir = null;
    this._downloadFiles = [];
    this._downloadFilesLength = 0;
    this._mounts = {};
    this._deferredMounts = [];
    this.mounts = [];
    this.last_mounted = null;
    this._appNotices = {};
  }

  _monitorDirectory(directory) {
    try {
      return directory.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
    } catch (error) {
      // Missing XDG folders and unavailable GVfs backends must not abort enable.
      console.warn(`Unable to monitor ${directory.get_uri()}: ${error.message}`);
      return null;
    }
  }

  needsUpdates() {
    return this.nextUpdateDelay() !== null;
  }

  nextUpdateDelay() {
    if (!this._enabled) return null;
    const delays = this._services.filter((service) => this._serviceEnabled(service))
      .map((service) => Math.max(1, service._interval - service._ticks));
    return delays.length ? Math.min(...delays) : null;
  }

  _serviceEnabled(service) {
    switch (service.name) {
      case 'trash': return this.extension.trash_icon && !this._trashMonitor;
      case 'clock': return this.extension.clock_icon;
      case 'calendar': return this.extension.calendar_icon;
      default: return false;
    }
  }

  setupTrash() {
    this._trashCancellable?.cancel();
    this._trashCancellable = null;
    this._trashCheckPending = false;
    if (this._trashMonitor) {
      this._trashMonitor.disconnectObject(this);
      this._trashMonitor.cancel();
      this._trashMonitor = null;
    }
    this._trashDir = null;
    if (!this._enabled || !this.extension.trash_icon) return;
    this.setupTrashIcon();
    this._trashDir = Gio.File.new_for_uri('trash:///');
    this._trashMonitor = this._monitorDirectory(this._trashDir);
    this._trashMonitor?.connectObject('changed', () => this.checkTrash(), this);
    this.checkTrash();
  }

  setupDownloads() {
    if (!this._enabled) return;
    this._downloadsCancellable?.cancel();
    this._downloadsCancellable = null;
    this._downloadsCheckPending = false;
    this.extension._loTimer?.cancel(this._debounceCheckDownloadsSeq);
    this._debounceCheckDownloadsSeq = null;
    this._downloadFiles = [];
    this._downloadFilesLength = 0;
    if (this._downloadsMonitor) {
      this._downloadsMonitor.disconnectObject(this);
      this._downloadsMonitor.cancel();
      this._downloadsMonitor = null;
    }
    this._downloadsDir = null;
    if (!this.extension.downloads_icon) return;
    this._downloadsUserDir = this.extension.downloads_path;
    if (this._downloadsUserDir && this._downloadsUserDir.trim().length > 0) {
      let fn = Gio.File.new_for_path(this._downloadsUserDir);
      if (fn.query_exists(null)) {
        this._downloadsDir = fn;
      } else {
        this._downloadsUserDir = null;
        this._downloadsDir = this._defaultDownloadsDir();
      }
    } else {
      this._downloadsUserDir = null;
      this._downloadsDir = this._defaultDownloadsDir();
    }
    // keep the downloads item pointing at the folder being listed
    this.setupFolderIcon(
      'downloads',
      'Downloads',
      'folder-downloads',
      this._downloadsDir.get_path()
    );

    this._downloadsMonitor = this._monitorDirectory(this._downloadsDir);
    this._downloadsMonitor?.connectObject(
      'changed',
      (fileMonitor, file, otherFile, eventType) => {
        this._debounceCheckDownloads();
      },
      this
    );

    this._debounceCheckDownloads();
  }

  _commitMounts() {
    if (this._deferredMounts && this._deferredMounts.length) {
      let mounts = [...this._deferredMounts];
      this._deferredMounts = [];
      mounts.forEach((m) => {
        this._onMountAdded(null, m);
      });
    }
  }

  _onMountAdded(monitor, mount) {
    if (!this._enabled || !this.extension.mounted_icon) {
      return false;
    }

    this.last_mounted = mount;
    this.setupMountIcon(mount);
    this.extension.animate();
    return true;
  }

  _onMountRemoved(monitor, mount) {
    if (!this._enabled) return;
    this._deferredMounts = this._deferredMounts.filter((pending) => pending !== mount);
    this.mounts = (this.mounts ?? []).filter((current) => current !== mount);
    if (this.last_mounted === mount) this.last_mounted = null;
    // Drive/volume properties may already have disappeared on an unmount.
    // Release the stored object instead of deriving its old key from them.
    for (const [path, current] of Object.entries(this._mounts)) {
      if (current === mount) delete this._mounts[path];
    }
    this.extension.animate();
  }

  update(elapsed) {
    if (!this._enabled) return;
    this._services.forEach((s) => {
      if (this._serviceEnabled(s)) s.update(elapsed);
    });
  }

  setupTrashIcon() {
    let appname = `trash-dash2dock-lite.desktop`;
    let app_id = tempPath(appname);
    let fn = Gio.File.new_for_path(app_id);
    // the program must exist or Gio refuses to load the desktop file
    let open_app = this.extension.file_explorer();

    // gio empties the trash of every volume without opening a terminal
    let trash_action = 'gio trash --empty';
    let trash_terminal = 'false';
    if (!GLib.find_program_in_path('gio')) {
      let fn = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_data_dir(), 'Trash'])
      );
      trash_action = `rm -rf ${GLib.shell_quote(fn.get_path())}`;
      trash_terminal = 'true';
    }

    let content = `[Desktop Entry]\nVersion=1.0\nTerminal=false\nType=Application\nName=Trash\nExec=${open_app} trash:///\nIcon=user-trash\nStartupWMClass=trash-dash2dock-lite\nActions=trash\n\n[Desktop Action trash]\nName=Empty Trash\nExec=${trash_action}\nTerminal=${trash_terminal}\n`;
    const [, etag] = fn.replace_contents(
      content,
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null
    );
  }

  setupFolderIcon(name, title, icon, path) {
    // expand
    let full_path = Gio.file_new_for_path(path).get_path();
    let extension_path = this.extension.path;
    let appname = `${name}-dash2dock-lite.desktop`;
    let app_id = tempPath(appname);
    let fn = Gio.File.new_for_path(app_id);
    // the program must exist or Gio refuses to load the desktop file
    let open_app = this.extension.file_explorer();

    let quoted_path = GLib.shell_quote(full_path).replace(/%/g, '%%');
    let content = `[Desktop Entry]\nVersion=1.0\nTerminal=false\nType=Application\nName=${title}\nExec=${open_app} ${quoted_path}\nIcon=${icon}\nStartupWMClass=${name}-dash2dock-lite\n`;
    const [, etag] = fn.replace_contents(
      content,
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null
    );
  }

  setupFolderIcons() {
    // Async configuration may change the opener after these services started.
    // Refresh their launchers without replacing watchers or restarting scans.
    if (this.extension.trash_icon && this._trashDir) this.setupTrashIcon();
    if (this.extension.downloads_icon && this._downloadsDir) {
      this.setupFolderIcon(
        'downloads', 'Downloads', 'folder-downloads', this._downloadsDir.get_path()
      );
    }
    if (!this.extension.documents_icon) return;
    this.setupFolderIcon(
      'documents',
      'Documents',
      'folder-documents',
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Documents'])
    );
  }

  // the localized XDG download folder, not necessarily ~/Downloads
  _defaultDownloadsDir() {
    return Gio.File.new_for_path(
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Downloads'])
    );
  }

  _toSafeFileName(name) {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_') // replace anything not allowed
      .replace(/_+/g, '_') // collapse multiple underscores
      .replace(/^_+|_+$/g, ''); // trim leading/trailing underscores
  }

  // one desktop file per mount location so that mounts don't collide
  _mountAppName(mount) {
    let uri = mount.get_default_location().get_uri();
    let hash = GLib.compute_checksum_for_string(
      GLib.ChecksumType.MD5,
      uri,
      -1
    ).slice(0, 8);
    return `mount-${this._toSafeFileName(
      this._getMountName(mount)
    )}-${hash}-dash2dock-lite`;
  }

  setupMountIcon(mount) {
    let label = mount.get_name();
    let appname = this._mountAppName(mount);
    let location = mount.get_default_location();
    // remote mounts may have no local path
    let target = GLib.shell_quote(location.get_path() ?? location.get_uri());
    let icon = 'drive-harddisk-solidstate';
    if (mount.get_icon() && mount.get_icon().names) {
      icon =
        this.extension.lookup_icon_from_names(mount.get_icon().names) ?? icon;
    }
    let open_exec = `${this.extension.file_opener()} ${target}`.replace(/%/g, '%%');
    let mount_exec = 'echo "not implemented"';
    let unmount_exec = `${firstInstalledCommand(['gio mount -u', 'umount'])} ${target}`.replace(/%/g, '%%');
    let mount_id = tempPath(`${appname}.desktop`);
    let fn = Gio.File.new_for_path(mount_id);

    // rewrite every time; the mount may have changed since the last session
    let content = `[Desktop Entry]\nVersion=1.0\nTerminal=false\nType=Application\nName=${label}\nExec=${open_exec}\nIcon=${icon}\nStartupWMClass=${appname}\nActions=unmount;\n\n[Desktop Action mount]\nName=Mount\nExec=${mount_exec}\n\n[Desktop Action unmount]\nName=Unmount\nExec=${unmount_exec}\n`;
    const [, etag] = fn.replace_contents(
      content,
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null
    );

    this._mounts[mount_id] = mount;
  }

  _setupNotifications() {
    this._notificationSources = new Set();
    Main.messageTray.connectObject(
      'source-added', (tray, source) => {
        this._trackNotificationSource(source);
        this.checkNotifications();
      },
      'source-removed', (tray, source) => {
        if (this._notificationSources.delete(source)) source.disconnectObject(this);
        this.checkNotifications();
      },
      this
    );
    for (const source of Main.messageTray.getSources()) this._trackNotificationSource(source);
    this.checkNotifications();
  }

  _trackNotificationSource(source) {
    if (this._notificationSources.has(source)) return;
    this._notificationSources.add(source);
    source.connectObject('notify::count', () => this.checkNotifications(), this);
  }

  checkNotifications() {
    if (!this._enabled) return;
    if (this._disableNotifications > 4) return;

    let sources = Main.messageTray.getSources();
    const previous = this._appNotices ?? {};
    const notices = {};

    let app_map = {
      'org.gnome.Evolution-alarm-notify.desktop': 'org.gnome.Calendar.desktop',
    };

    sources.forEach((source) => {
      let appId = null;
      if (source.app) {
        appId = source.app.get_id();
      }
      if (!appId && source._app) {
        appId = source._app.get_id();
      }
      if (!appId) {
        appId = source._appId;
      }
      if (!appId) {
        appId = '?';
      }

      // remap
      appId = app_map[appId] || appId;

      if (!appId.endsWith('.desktop')) appId += '.desktop';
      if (!notices[appId]) {
        notices[appId] = {
          count: 0,
          previous: previous[appId]?.count ?? 0,
          urgency: 0,
        };
      }
      notices[appId].count += source.count;
    });

    let hasUpdates = false;
    for (const key of new Set([...Object.keys(previous), ...Object.keys(notices)])) {
      if ((previous[key]?.count ?? 0) !== (notices[key]?.count ?? 0)) {
        hasUpdates = true;
      }
    }

    let update = {};
    Object.keys(notices).forEach((k) => {
      if (notices[k].count > 0) {
        update[k] = notices[k];
      }
    });
    this._appNotices = update;

    if (hasUpdates) {
      this.extension.animate();
    }
  }

  async checkTrash() {
    if (!this._enabled || !this.extension.trash_icon) return;
    if (this._trashCancellable) {
      // A monitor event can arrive after the current scan took its snapshot.
      // Coalesce these events into one fresh scan once that request closes.
      this._trashCheckPending = true;
      return;
    }
    this._trashCheckPending = false;
    const generation = this._generation;
    const cancellable = new Gio.Cancellable();
    this._trashCancellable = cancellable;
    const prev = this.trashFull;
    let trashFull = false;
    let iter = null;
    try {
      iter = await enumerateChildren(this._trashDir, Gio.FILE_ATTRIBUTE_STANDARD_NAME, cancellable);
      trashFull = (await nextFiles(iter, 1, cancellable)).length > 0;
    } catch (err) {
      // trash:/// is unavailable without gvfs; this runs from enable()
    } finally {
      await closeEnumerator(iter);
      if (this._trashCancellable === cancellable) this._trashCancellable = null;
    }
    if (!this._enabled || generation !== this._generation || cancellable.is_cancelled()) return;
    this.trashFull = trashFull;
    if (prev !== trashFull) {
      this.extension.animate({ refresh: true });
    }
    if (this._trashCheckPending) return this.checkTrash();
    return this.trashFull;
  }

  async checkRecentFilesInFolder(path, cancellable = null) {
    let maxs = [5, 8, 10, 12, 15, 20, 25];
    let max_recent_items = maxs[this.extension.max_recent_items || 0] ?? maxs[0];
    let downloadFiles = [];
    let downloadFilesLength = 0;

    let directory = Gio.File.new_for_path(path);
    let enumerator = null;
    try {
      enumerator = await enumerateChildren(directory,
        [
          Gio.FILE_ATTRIBUTE_STANDARD_NAME,
          Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
        ].join(','),
        cancellable
      );
      while (true) {
        const files = await nextFiles(enumerator, 64, cancellable);
        if (!files.length) break;
        for (const fileInfo of files) {
          const fileName = fileInfo.get_name();
          downloadFilesLength++;
          downloadFiles.push({
            index: 0,
            name: fileName,
            display: fileName,
            path: [path, fileName].join('/'),
            date: { tv_sec: fileInfo.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED) },
          });
        }
        // Only retain the requested newest files, even for enormous folders.
        downloadFiles.sort((a, b) => b.date.tv_sec - a.date.tv_sec || a.name.localeCompare(b.name));
        downloadFiles.splice(max_recent_items);
      }
    } finally {
      await closeEnumerator(enumerator);
    }
    for (const [index, f] of downloadFiles.entries()) {
      f.index = index;
      f.icon = 'file';
      f.type = null;
      try {
        // Content type and icon discovery may inspect each file. Only request
        // that metadata for the few rows the user will actually see.
        const info = await queryInfo(directory.get_child(f.name),
          [Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE, Gio.FILE_ATTRIBUTE_STANDARD_ICON].join(','),
          cancellable);
        f.type = info.get_content_type();
        f.icon = this.extension.lookup_icon_from_names(info.get_icon()?.names ?? []) ?? 'file';
      } catch (error) {
        if (cancellable?.is_cancelled()) throw error;
        // A download may be moved or removed while its folder is being read.
      }
    }

    return [downloadFiles, downloadFilesLength];
  }

  async checkDownloads() {
    if (!this._enabled || !this.extension.downloads_icon || !this._downloadsDir) return;
    if (this._downloadsCancellable) {
      this._downloadsCheckPending = true;
      return;
    }
    this._downloadsCheckPending = false;
    this.extension._loTimer?.cancel(this._debounceCheckDownloadsSeq);
    this._debounceCheckDownloadsSeq = null;
    const generation = this._generation;
    const directory = this._downloadsDir;
    const cancellable = new Gio.Cancellable();
    this._downloadsCancellable = cancellable;
    try {
      const [files, count] = await this.checkRecentFilesInFolder(directory.get_path(), cancellable);
      if (!this._enabled || !this.extension.downloads_icon || generation !== this._generation ||
          this._downloadsDir !== directory || cancellable.is_cancelled()) return;
      const previous = this._downloadFiles ?? [];
      const changed = count !== this._downloadFilesLength || files.length !== previous.length ||
        files.some((file, index) => {
          const old = previous[index];
          return file.path !== old.path || file.date?.tv_sec !== old.date?.tv_sec ||
            file.icon !== old.icon || file.type !== old.type;
        });
      if (changed) {
        this._downloadFiles = files;
        this._downloadFilesLength = count;
        this.extension.animate();
      }
    } catch (err) {
      if (!cancellable.is_cancelled()) console.log(err);
    } finally {
      if (this._downloadsCancellable === cancellable) this._downloadsCancellable = null;
    }
    if (this._enabled && generation === this._generation && !cancellable.is_cancelled() &&
        this._downloadsCheckPending) return this.checkDownloads();
  }

  _debounceCheckDownloads() {
    if (!this._enabled || !this.extension.downloads_icon) return;
    if (this._downloadsCancellable) {
      this._downloadsCheckPending = true;
      return;
    }
    if (this.extension._loTimer) {
      if (!this._debounceCheckDownloadsSeq) {
        this._debounceCheckDownloadsSeq = this.extension._loTimer.runDebounced(
          () => {
            this._debounceCheckDownloadsSeq = null;
            this.checkDownloads();
          },
          DEBOUNCE_CHECK_TIMEOUT,
          'debounceCheckDownloads'
        );
      } else {
        this.extension._loTimer.runDebounced(this._debounceCheckDownloadsSeq);
      }
    }
  }

  _getMountName(mount) {
    let name = null;
    if (mount.get_drive()) {
      name = mount.get_drive().get_name();
    }

    if (!name) {
      if (mount.get_volume()) {
        name = mount.get_volume().get_name();
      }
    }

    if (!name) {
      if (mount.get_default_location()) {
        name = mount.get_default_location().get_basename();
      }
    }

    return name || 'Volume';
  }

  checkMounts() {
    if (!this._enabled) return;
    this._deferredMounts = [];
    if (!this.extension.mounted_icon) {
      this._volumeMonitor?.disconnectObject(this);
      this._volumeMonitor = null;
      this._mounts = {};
      this.mounts = [];
      this.last_mounted = null;
      return;
    }
    if (!this._volumeMonitor) {
      this._volumeMonitor = Gio.VolumeMonitor.get();
      this._volumeMonitor.connectObject(
        'mount-added', this._onMountAdded.bind(this),
        'mount-removed', this._onMountRemoved.bind(this), this
      );
    }

    let mounts = this._volumeMonitor.get_mounts() || [];

    this.mounts = mounts;
    mounts.forEach((mount) => {
      this._deferredMounts.push(mount);
    });

    // added devices will subsequently be on mounted events
  }

  // drop references once the widget is destroyed (e.g. with the render area)
  _forgetOnDestroy(widget, dock, item, prop) {
    widget.connect('destroy', () => {
      if (dock[prop] === widget) dock[prop] = null;
      if (item[prop] === widget) item[prop] = null;
      if (item._image === widget) item._image = null;
    });
  }

  //! this is out of place - services should only do background process - no rendering
  updateIcon(item, settings) {
    if (!item) {
      return;
    }
    let icon = item._icon;
    if (!icon || !icon.icon_name) {
      return;
    }

    let { scaleFactor, iconSize, dock } = settings;

    // todo move dots and badges here?

    // the trash
    if (this.extension.trash_icon && icon.icon_name.startsWith('user-trash')) {
      let new_icon = this.trashFull ? 'user-trash-full' : 'user-trash';
      if (new_icon != icon.icon_name) {
        icon.icon_name = new_icon;
      }
    }

    // clock
    if (icon.icon_name == 'org.gnome.clocks') {
      if (this.extension.clock_icon) {
        let clock = item._clock;
        if (!clock) {
          clock = new Clock(CANVAS_SIZE, dock.extension._widgetStyle);
          dock._clock = clock;
          item._clock = clock;
          item._image = clock;
          // item._appwell.first_child.add_child(clock);
          dock.renderArea.add_child(clock);
          this._forgetOnDestroy(clock, dock, item, '_clock');
        }
        if (clock) {
          clock._icon = icon;
          clock.width = item._renderer.width * item._renderer.scale_x;
          clock.height = clock.width;
          // let toScale = item._scale;
          // clock.set_scale(toScale, toScale);
          let canvasScale = clock.width / (clock._canvas.width + 2);
          clock._canvas.set_scale(canvasScale, canvasScale);
          clock.x = item._renderer.x;
          clock.y = item._renderer.y;
          clock.opacity = item._renderer.opacity;
          clock.show();
          item._renderer.opacity = clock.shouldHideIcon() ? 0 : 255;
        }
      } else {
        let clock = item._clock;
        item._icon.visible = true;
        item._renderer.opacity = 255;
        clock?.destroy();
      }
    }

    // calender
    if (icon.icon_name == 'org.gnome.Calendar') {
      if (this.extension.calendar_icon) {
        let calendar = item._calendar;
        if (!calendar) {
          calendar = new Calendar(CANVAS_SIZE, dock.extension._widgetStyle);
          dock._calendar = calendar;
          item._calendar = calendar;
          item._image = calendar;
          dock.renderArea.add_child(calendar);
          this._forgetOnDestroy(calendar, dock, item, '_calendar');
        }
        if (calendar) {
          calendar._icon = icon;
          calendar.width = item._renderer.width * item._renderer.scale_x;
          calendar.height = calendar.width;
          // let toScale = item._scale;
          // calendar.set_scale(toScale, toScale);
          let canvasScale = calendar.width / (calendar._canvas.width + 2);
          calendar._canvas.set_scale(canvasScale, canvasScale);
          calendar.x = item._renderer.x;
          calendar.y = item._renderer.y;
          calendar.opacity = item._renderer.opacity;
          calendar.show();
          item._renderer.opacity = calendar.shouldHideIcon() ? 0 : 255;
        }
      } else {
        let calendar = item._calendar;
        item._icon.visible = true;
        item._renderer.opacity = 255;
        calendar?.destroy();
      }
    }
  }
};
