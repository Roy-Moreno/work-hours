# Roadmap — work-hours

## CHORE: Hosting on GitHub Pages

**Summary**
- Why: PWA must be served over HTTPS to install on phone.
- How: Public repo Roy-Moreno/work-hours, Pages from `main` root → https://roy-moreno.github.io/work-hours/
- Advantage: Free, no build step, every push to `main` redeploys.
- Disadvantage: Repo must stay public on free plan.

**Status:** Done

**Tasks**
- [x] Connect remote and push `main`
- [x] Make repo public
- [x] Enable Pages on `main`
- [ ] Install app on phone and smoke-test
- [ ] Remove stray nested `work-hours/` duplicate folder

**Caution**
- `sw.js` is network-first, so online phones get updates on next load; bump `CACHE` (`wh-v1`) only when the asset list changes.

## FEATURE: In-app help

**Summary**
- Why: Home screen has many buttons; user unsure what to press.
- How: "?" in top bar → sheet with TL;DR + collapsible section per tab, current tab expanded; auto-opens once on first launch.

**Status:** Done

**Tasks**
- [x] Help sheet + "?" button
- [x] First-run auto-open
- [x] Test in browser preview
- [x] Commit and push to Pages

## FEATURE: Vacation pay and yearly balance

**Summary**
- Why: Vacation days are limited per year and paid; sick days not necessarily paid. App treated both as unpaid labels.
- How: Vacation day paid at regular start→end hours, added to salary stats; yearly quota + per-year adjustment in Settings; home shows remaining days. Sick days counted, unpaid.

**Status:** Done

**Tasks**
- [x] Settings: yearly quota + per-year adjustment
- [x] Vacation pay in salary stats
- [x] Balance on home + breakdown on sheet
- [x] Help text updated
- [x] Commit and push to Pages
- [ ] Set real yearly quota in phone Settings

**Caution**
- Balance is per calendar year, not employment year. Carried days go in the per-year adjustment field.
- Half-day vacation not supported (a day is all or nothing).
