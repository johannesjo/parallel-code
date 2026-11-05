# Contributing to Parallel Code

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Report a bug or suggest a feature

- In the app: **Settings → General → Report a bug** or **Suggest a feature**. Bug reports open with the version, OS and detected agents filled in. Nothing is sent until you submit the issue on GitHub.
- On GitHub: [open an issue](https://github.com/johannesjo/parallel-code/issues/new/choose).

Search the [existing issues](https://github.com/johannesjo/parallel-code/issues) first; a 👍 on an existing issue helps prioritize it.

## Set up

Requires [Node.js](https://nodejs.org/) 22.12 or later.

```sh
git clone https://github.com/johannesjo/parallel-code.git
cd parallel-code
npm install
npm run dev
```

On Windows, run the npm scripts through Git Bash: `npm config set script-shell "C:\Program Files\Git\bin\bash.exe" --location project`.

## Find something to work on

- Issues labelled [`good first issue`](https://github.com/johannesjo/parallel-code/labels/good%20first%20issue) are small and well scoped.
- [`help wanted`](https://github.com/johannesjo/parallel-code/labels/help%20wanted) issues are ones the maintainer would like help with.
- For a larger change, comment on the issue or open one first, so we can agree on the approach before you invest time.

## Make the change

[AGENTS.md](AGENTS.md) is the project guide for people and coding agents alike: architecture, conventions, UI and motion rules, and how to verify changes. The short version:

- Run focused tests while you work: `npm run test:unit -- path/to/file.test.ts` or `npm run test:client -- path/to/file.client.test.tsx`.
- Before opening a pull request, run `npm run check` and `npm test`. The Git hooks run these too.
- Use conventional commit messages, such as `fix(terminal): restore focus`.
- Keep pull requests small and focused on one change.

## Using coding agents

Parallel Code is built with coding agents, and you are welcome to use them too. Parallel Code itself is a good way to do it. Two rules:

1. **You own the change.** Read and understand every line before you open the pull request, and make sure the checks pass.
2. **Say which agent helped** in the pull request description.

Reviewing takes time on both sides. If a pull request looks like it hasn't been read through yet, we may ask you to do that before we review it in detail.

## Security issues

Please don't report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
