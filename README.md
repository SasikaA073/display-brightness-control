# Display Brightness Control

A [MonitorControl](https://github.com/MonitorControl/MonitorControl)-style brightness
controller for Ubuntu / GNOME Shell. It changes the hardware brightness of external
monitors over DDC/CI, and the brightness keys act on **the display under your mouse cursor**.

## Features

- **External monitors over DDC/CI** (via [`ddcutil`](https://www.ddcutil.com/)):
  brightness and contrast sliders.
- **Built-in laptop panels** through GNOME's own brightness manager.
- **Software dimming fallback** (a click-through overlay) for displays without DDC/CI.
- **Cursor-aware controls**
  - Brightness keys (`XF86MonBrightnessUp/Down`) change the display under the cursor
    (can be turned off in Settings).
  - `Ctrl+Super+Page Up` / `Ctrl+Super+Page Down` do the same on keyboards without brightness keys.
  - `Ctrl+Super+B` opens a brightness/contrast popup **at the cursor** for that display.
  - An on-screen indicator shows the new level on the display that changed.
- **Top-bar menu** with sliders for every connected display.
- Writes to the monitor are asynchronous and coalesced, so dragging a slider never
  freezes the shell or queues up I2C traffic.

## Requirements

- GNOME Shell 50 (Ubuntu 26.04). Older versions are not tested.
- `ddcutil` (the installer installs it if missing).
- DDC/CI enabled in the monitor's on-screen menu (usually on by default).

## Install

```bash
git clone https://github.com/SasikaA073/display-brightness-control.git
cd display-brightness-control
./install.sh
```

Then **log out and back in**. On Wayland, GNOME Shell only loads newly installed
extensions at login.

Uninstall with `./uninstall.sh`.

## Settings

Open the top-bar menu and click **Settings**, or run
`gnome-extensions prefs display-brightness-control@sasikaa073.github.io`.

| Setting | Default |
|---|---|
| Brightness step | 5 % |
| Brightness keys follow the cursor | on |
| Software dimming fallback | on |
| Shortcuts | `Ctrl+Super+Page_Up`, `Ctrl+Super+Page_Down`, `Ctrl+Super+B` |

## How it works

```
display-brightness-control@sasikaa073.github.io/
├── extension.js   # monitor mapping, keybindings, top-bar menu, cursor popup
├── lib/ddc.js     # async ddcutil wrapper: detect, getvcp, coalesced setvcp
├── lib/controls.js# per-display controls: built-in / DDC / software / none
├── lib/ui.js      # slider menu sections
├── prefs.js       # preferences window (libadwaita)
└── schemas/       # GSettings schema
```

Each GNOME monitor is matched to a `ddcutil` display by connector name (normalizing
DRM `HDMI-A-1` to Mutter `HDMI-1`), then by EDID vendor and serial. Displays GNOME
already controls (laptop panels) use GNOME's brightness manager. The rest fall back to
software dimming.

## Troubleshooting

- **Monitor shows "Not controllable" or uses software dimming:** run `ddcutil detect`.
  If the monitor isn't listed, enable DDC/CI in its OSD. Some docks and KVMs do not
  pass DDC/CI through.
- **Permission errors:** `ls -l /dev/i2c-*`. Ubuntu's `ddcutil` package grants the
  logged-in user access through a udev rule. Otherwise add yourself to the `i2c` group.
- **Logs:** `journalctl --user -b | grep display-brightness`

## Known limitations

- Software dimming overlays are removed while the screen is locked (GNOME disables
  extensions on the lock screen). DDC/CI brightness is unaffected.
- If you change brightness with the monitor's own buttons, the slider catches up the
  next time the menu opens, or after 10 seconds on the next key press.
