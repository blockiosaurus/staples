# Developer previews

Contributors can inspect design examples in the design guide and Storybook. These are development surfaces and do not count as production feature verification.

Implementation: [route registration](../ui/src/App.tsx), [design guide](../ui/src/pages/DesignGuide.tsx).

## Sub-features

- `design`: inspect shared components and layout examples in the design guide or Storybook.
- `route-gates`: distinguish dev-only, experimental, historical, and fallback surfaces.

## How to get to it (user POV)

### `preview-lab`

Use `/design-guide` or Storybook; consult `ui/src/App.tsx` for the current gated set.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a development/test environment. Confirm the route is registered for the current build before claiming the page is available.

### `preview-lab`

Automated: [onboarding variant](../ui/src/components/OnboardingWizardVariant.test.tsx) is an example component contract. There is no claim of full automated acceptance coverage for every preview page.

Manual: Open the specific state, inspect controls and layout, then repeat the affected interaction in the actual product host. Report fixture results separately from persisted task/company results.

## Gotchas

- An unmounted or obsolete preview file remains in the conservative page inventory but is not a shipped entry point.
- Screenshots of a preview do not prove live provider behavior, persistence, or authorization.
