# ImpactBench apps

Real open-source TypeScript apps, each pinned to one full commit SHA, used to
check Graphentra's impact predictions against what really breaks.

```
npm run bench:fetch      # clone + checkout + install every app into impactbench/work/
npm run bench:baseline   # run each app's tests once, write baselines/<name>.json
```

Add an app: append an entry to `apps.json` with a full 40-character SHA (never a
branch or tag), then run both commands. Keep it only if its baseline passes and
the tests take under about 2 minutes. Use permissive licenses only (MIT, ISC, Apache-2.0, BSD).
Bump a pin on purpose: change `commit`, re-run both commands, commit the new baseline.
`work/` is git-ignored.
