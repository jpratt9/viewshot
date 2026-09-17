# ViewShot

A fast, minimal, **open-source** Chrome extension for screenshots — capture the **visible area**, the **full page**, or a **region** of any tab and save it as PNG/JPG/WebP (or copy to clipboard). 100% local: no account, no cloud, no tracking.

## Features
- One-click capture: visible area · full page (scroll-stitch, sticky-header aware) · region select
- PNG / JPG / WebP, with a quality slider
- Tab recording to WebM, MP4 or GIF — choose one as the format, then **Record** and **Stop recording** (GIFs are 10 fps, up to 720px wide, and stop by themselves after about a minute)
- Filename templates — `{date} {time} {domain} {title}`
- Download or copy straight to clipboard
- **Hide scrollbar before capturing** keeps the scrollbar out of screenshots (on by default)
- Keyboard shortcuts — `Alt+Shift+V` visible area · `Alt+Shift+F` full page · `Alt+Shift+R` region · `Alt+Shift+S` start/stop recording (change them at `chrome://extensions/shortcuts`). Select WebM, MP4, or GIF before starting a recording; an image format flashes `!`. The recording shortcut stops an active recording from any tab, regardless of the selected format.
- Nothing leaves your device — see [Permissions](#permissions)

## Install (unpacked)
1. Open `chrome://extensions` and enable **Developer mode**
2. **Load unpacked** → select this folder
3. Pin the ViewShot icon and click it (or use the keyboard shortcut)

## Permissions
- `activeTab` — capture the tab you clicked the icon or pressed a shortcut on
- `downloads` — save screenshots
- `scripting` — run the region selector, full-page scrolling and scrollbar hiding in that tab
- `storage` — remember your settings and whether a recording is running
- `offscreen` — copy to the clipboard and record, which the background service worker can't do
- `tabCapture` — get the tab's video for recording

## Development
There's no build step and nothing to install: Chrome runs the files in this folder as they are. After changing one, press the reload button on ViewShot's card in `chrome://extensions`.

Run the tests with `npm test`. They use Node's built-in test runner, live in `tests/`, and CI runs them on every push and pull request.

To publish, run `npm run package`. It builds `viewshot.zip` in this folder, holding only the files the extension needs, for upload to the Chrome Web Store.

## License
[GNU GPLv3](LICENSE) © John Pratt
