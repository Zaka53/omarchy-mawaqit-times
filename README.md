# Mawaqit Prayer Times

An [Omarchy](https://omarchy.org) bar plugin that shows the five daily prayer
times for a mosque of your choosing, pulled from its [mawaqit.net](https://mawaqit.net)
page. Prayer time lookup runs through a small bundled Python script; the QML
side only handles display, countdown, and settings.

The bar pill shows the next prayer and its time (e.g. `Asr 16:43`). Click it
to open a panel with all five prayers, sunrise, and Jumu'a, with the next
prayer highlighted.

## Install

```
omarchy plugin add https://github.com/zaka53/omarchy-mawaqit-times.git --enable
```

Or clone it into `~/.config/omarchy/plugins/` yourself and enable it from
_Setup > Plugins_.

## Configure

Click the bar pill to open the panel, then click "change mosque" (or just
enter one straight away if none is configured yet) and paste either:

- a mosque slug, e.g. `islamic-center-brooklyn`, or
- a full mawaqit.net link, e.g. `https://mawaqit.net/en/islamic-center-brooklyn`

Find your mosque's slug by searching for it at [mawaqit.net](https://mawaqit.net)
and copying the last part of its URL. Press Enter to save; Escape cancels.

The choice is stored in `~/.local/state/omarchy/settings/mawaqit-times.json`.

## How it works

`scripts/mawaqit_times.py` fetches the mosque's public mawaqit.net page and
reads the `confData` JSON object embedded in it (the same data the page
itself renders from — there's no official public API for this). It prints a
small JSON summary to stdout: the mosque name, timezone, the five prayer
times, sunrise, and Jumu'a. The QML panel runs this script via Quickshell's
`Process` type on open and every 5 minutes, and works out which prayer is
next locally so the bar pill can update between fetches without re-running
the script.

Requires `python3` (no extra Python packages) and a mosque that has a public
mawaqit.net page.

## License

MIT
