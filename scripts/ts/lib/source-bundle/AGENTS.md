# Source Bundle Notes

- This folder owns upstream bundle intake only: DMG selection, extraction, `app.asar` unpacking, and bundle sync into the working app tree.
- Keep it free from runtime donor logic, platform patch logic, and packaging logic.
- Fail fast on missing inputs; do not add installer-like fallback behavior here.
