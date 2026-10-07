# Contributor instructions

## Rules

- Never throw from `assign`, `value`, or a function returned by `function` because of a
  Statespace failure. Return the default, log a warning, and record `statespace.error`.
- Keep assignment identical to the Python and Go SDKs. `test/sdk.test.ts` holds the shared
  vectors.
- Keep the public API in `src/index.ts`.

## Checks

```shell
npm run format:check
npm run typecheck
npm test
npm pack --dry-run
```

## Commits

Use Conventional Commits, such as `fix(group): accept integers for number defaults`.
