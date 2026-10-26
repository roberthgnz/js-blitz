# JSBlitz

![image](https://github.com/user-attachments/assets/45dbee41-35a5-4a46-af13-6316d9a3bada)

JSBlitz is an alternative to RunJS that allows you to run JavaScript code in a flash. It provides a simple and efficient way to execute JavaScript/TypeScript code with support for package installation.

[![DOWNLOAD](https://github.com/user-attachments/assets/0b711e06-b18a-4b41-961f-c9e4c31df8b4)](https://github.com/roberthgnz/js-blitz/releases/download/v0.4.0/JSBlitz-0.4.0.Setup.exe)

## Features

- Execute JavaScript and TypeScript, including ES modules, CommonJS, top-level await, timers, promises, and Node.js built-ins.
- Inspect top-level expressions and streamed console output. Errors retain earlier output; Stop and execution limits terminate runaway code.
- Install real npm packages automatically from imports, or pin a version through the Packages panel. CJS, ESM-only packages, and package export maps use Node's native resolver.
- Work offline with a bundled Monaco editor, autocomplete, type checking, hover information, formatting, Node declarations, and package declarations.
- Keep multiple named tabs, code, language, and editor view state between tab switches. Code and the active tab persist across restarts.
- Save, edit, import, export, and insert personal snippets; built-in and saved snippets appear in autocomplete.
- Manage persistent environment variables and enable or disable them for subsequent runs.
- Chat with an OpenAI-compatible AI provider, including local providers, and explicitly apply suggested code to a new tab.

## Desktop workflow

Use **Run** or **Ctrl/Cmd+Enter** to execute the active tab. **Live** evaluates changes after a short delay; **Stop** terminates the current run. Choose JavaScript or TypeScript and a 10, 30, or 60 second execution limit in the toolbar. Type errors appear in the editor without blocking execution.

**Packages** installs registry packages such as `lodash`, `nanoid@5`, or `@scope/package`. Missing literal imports and requires also install automatically. Install `@types/package-name` when a package does not ship its own declarations. Packages are shared by tabs and cached in the application's writable workspace.

**Snippets** saves reusable code, imports or exports JSON libraries, inserts at the cursor, or opens a snippet in a new tab. Type a snippet name or use Ctrl+Space to show completions.

**Environment & AI** contains the environment manager and assistant. Save environment changes before running; disabled entries leave the inherited process environment in effect.

In the assistant, configure an OpenAI-compatible base URL and model. A hosted provider may need an API key; a local endpoint such as `http://localhost:11434/v1` can work without one. Keys are stored using the operating system's encrypted credential support. Code sharing is opt-in for each conversation request. Applying an AI suggestion opens a new tab with Live disabled so it can be reviewed before execution.

Every run uses a fresh, separately terminable Node process with full local Node.js access. The editor window remains isolated from Node; the execution process is not a security sandbox for untrusted code. Package installation and hosted AI calls require network access; editing and previously installed packages work offline.

Package lifecycle scripts are disabled so cancelling an installation can stop all its work. Packages requiring native compilation or postinstall setup need separate preparation.

## Installation

To install the dependencies, run:

```sh
pnpm install
```

## Development

To start the application in development mode, run:

```sh
pnpm dev
```

Check the project with:

```sh
pnpm typecheck
pnpm test
pnpm build
```

With `pnpm start` running, the Electron integration check can also exercise the real window, preload bridge, runner, package installation, and AI HTTP flow:

```sh
pnpm exec electron tests/electron-smoke.cjs
```

## Packaging

To package the application, run:

```sh
pnpm package
```

## Making

To create distributable packages, run:

```sh
pnpm make
```

## Publishing

To publish the application, run:

```sh
pnpm publish
```

## Scripts

- `start`: Start the Electron application
- `dev`: Start the Electron application in development mode
- `package`: Package the application
- `make`: Create distributable packages
- `publish`: Publish the application
- `postversion`: Push changes and tags to the remote repository

## License

This project is licensed under the MIT License. See the LICENSE file for details.

## Author

Roberth González

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Acknowledgements

- [Electron](https://www.electronjs.org/)
- [Vite](https://vitejs.dev/)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [Vue.js](https://vuejs.org/)
