## What this changes

<!-- And why. Link the issue if there is one. -->

## Checklist

- [ ] `npm run typecheck && npm test && npm run build` all pass
- [ ] New or changed decision rules live in `src/core/decide.ts` as a pure function of facts, with a test case
- [ ] Any new removal path goes through `applyPlan`, so it archives and re-verifies first
- [ ] No new runtime dependencies
- [ ] A new signal source has a test against a real repo (`test/fixture.ts`)
