# Codewalker workflow

The user has requested that Codewalker changes always be installed after validation, not left only in the prepared package.

- Run the tests relevant to the change and `python3 scripts/check-ui.py` for UI changes.
- Run `python3 scripts/install.py --apply --check` to update the user's live Codewalker mod.
- Check `herdr-app status`, capture `herdr-app shot`, and inspect the image. Do not claim interaction testing unless performed.
- Keep the installer's collision and local-edit checks. If installation is blocked, report the blocker; do not bypass it or overwrite local edits.
- Do not change unrelated mods, layouts, settings, or keybindings. Installation does not authorize committing or pushing.
