# Contributing

Open an issue before a substantial change to the public API. Report security issues
privately, as [SECURITY.md](SECURITY.md) describes.

Install Node.js 20 or later and run the checks that CI runs.

```shell
npm ci
npm run format:check
npm run typecheck
npm test
```

Use Conventional Commits and add a `CHANGELOG.md` entry for user-visible changes. By
contributing, you agree that your contribution is licensed under the Apache License 2.0.
