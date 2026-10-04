# Roadmap

* Panel mode features
* Apps folder

# Current Issues

* vertical layout does not support rearranging icons (as this is dependent on Gnome's own Dash which doesn't support this properly)
* vertical layout does not support Apps Icon at front

# Next Release

* Bug fixes
* add Gnome 51 support (icon effects use Cogl snippets)
* fix Gnome 50 errors: dock item right-click menu, scroll to cycle windows
* fix leaked docks and dashes after disable/lock screen
* fix trash, downloads and mounted icons without nautilus, localized Downloads folder, several mounted volumes
* fix middle click to open a new window, scroll cycling between two windows, touchpad scrolling
* fix per-monitor docks from config.json
* fix ```make g44``` build
* fix preferred monitor setting placing the dock on the wrong monitor
* fix reserved screen area after moving the dock or turning off autohide
* fix autohide not hiding until a window moved, pressure sense with the dock at the top
* fix Downloads folder chooser on Gnome 42 and 43, Downloads list missing files moved in
* fix trash icon state when enabled, Empty Trash no longer opens a terminal
* open the Trash, Downloads and Documents folders instead of selecting them in their parent folder
* fix Gnome 50 overview dash errors after rearranging favorites, overview dash left hidden after disable
* load ~/.config/d2da files regardless of the working directory

# Release 84

* add custom config for overriding file explorer and icon size
* add background for focused icon
* add transparent background on Overview
* adjust badges and dots positions

# Release 83

* add Gnome 49 support
* Filter icon actions to current monitor

# Release 75

* add Gnome 48 support
* 2xScaling fix
* add multi-user support

# Release 65

* Blurred Backgrounds
* Custom icons

# Release 64

* Minor bug fixes

# Release 57

* Gnome 45, 46
* Gnome 42, 43, 44
* Minor bug fixes

# Release 50

* Major bug fixes

# Release 47

* Add Downloads folder with fan pullout
* Add separator with styles
* Clock styles

# Release 46

* Minor bug fixes

# Release 45

* Multi-Monitor support
* Major overhaul
* Dynamic icons improvement

# Release 43

* Fix lag. Revamped animation for faster and more resource efficient animation.
* Add bounce animation setting

# Release 40

* Fix hit areas outside of dock region

# Release 37,38,39

* Fix unresponsive Apps Button when animation is disabled
* Other bug fixes

# Release 36

* Fix tint & monochrome settings
* Improve animtion icon positions

# Release 35

* Gnome 45

# Release 27

* Improved animation
* Fix startup artifacts showing prior to scaling down
* Fix Compiz Effects compatibility

# Release 21

* Fix shaking animation
* Fix bounce for zero rise settings

# Release 20

* Fix hovered icon shaking
* Fix Janky resizing on hover (total dash width shaking)
* Fix labels not centering
* Fix space is showing between Apps button & icons - more prominent with vertical layouts


# Release 19

* Major refactor of the dock - Code cleanup
* Add dock position - left, right layout
* Add scrollwheel cycle windows
* Add click maximize/minimize windows
* Add opening app animation
* Add topbar text color 

# Release 16

* Add preferred monitor
* Add icon color effects
* Icon Effect: Tint
* Icon Effect: Monochrome
* Add background color effects
* Add border settings color and thickness
* Add show/hide apps icon
* Add show/hide running app icons
* Add diagnostics/tests
* Improved animation and icon scaling
* Refactor timers (use less timers)


# Release 14

* Update settings panel
* Add animation tweaks
* Tweak: peek icons
* Tweak: icon magnification
* Tweak: icons spread
* Tweak: icons rise
* Tweak: frame rate
* Add dynamic trash icon
* Add dynamic clock
* Add dynamic calendar
* Add mounted devices 
* Add border radius settings
* Add hover icon border radius settings
* Add panel mode
* Custom running window indicator style and color

# Release 12

## Features:
* Animated dash icons
* Autohide(Intellihide)
* Pressure sense
* Shrink/Scale icons
* Dark background
* Background opacity
* Topbar opacity

