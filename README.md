# JSBlitz

![image](https://github.com/user-attachments/assets/45dbee41-35a5-4a46-af13-6316d9a3bada)

JSBlitz is an alternative to RunJS that allows you to run JavaScript code in a flash. It provides a simple and efficient way to execute JavaScript/TypeScript code with support for package installation.

[![DOWNLOAD](https://github.com/user-attachments/assets/0b711e06-b18a-4b41-961f-c9e4c31df8b4)](https://github.com/roberthgnz/js-blitz/releases/latest)

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

Each tab can run in **Node.js** or **Browser**, selected in the status bar. Node.js uses the bundled runtime, native npm packages and desktop environment variables. Browser runs in an isolated preview with real `window`, `document`, DOM and canvas APIs. Use **Preview** to see rendered content and **Console** to inspect values and errors. Switching environments also updates autocomplete, hover information and type checking.

To open the playground directly in a web browser:

```sh
pnpm dev:web
```

Open `http://127.0.0.1:1420`. New tabs use Browser when the native desktop host is unavailable. A static browser build is available with `pnpm build:frontend`; serve the generated `dist` directory over HTTP. Native Node.js execution, npm installation, desktop environment settings and AI configuration require the desktop application.

Use **Run** or **Ctrl/Cmd+Enter** to execute the active tab. **Live** evaluates changes after a short delay; **Stop** terminates the current run. Choose JavaScript or TypeScript and a 10, 30, or 60 second execution limit in the toolbar. Type errors appear in the editor without blocking execution.

**Packages** installs registry packages such as `lodash`, `nanoid@5`, or `@scope/package`. Missing literal imports and requires also install automatically. Install `@types/package-name` when a package does not ship its own declarations. Packages are shared by tabs and cached in the application's writable workspace.

**Snippets** saves reusable code, imports or exports JSON libraries, inserts at the cursor, or opens a snippet in a new tab. Type a snippet name or use Ctrl+Space to show completions.

**Environment & AI** contains the environment manager and assistant. Save environment changes before running; disabled entries leave the inherited process environment in effect.

In the assistant, configure an OpenAI-compatible base URL and model. A hosted provider may need an API key; a local endpoint such as `http://localhost:11434/v1` can work without one. Keys are stored using the operating system's encrypted credential support. Code sharing is opt-in for each conversation request. Applying an AI suggestion opens a new tab with Live disabled so it can be reviewed before execution.

JSBlitz uses Tauri 2, Rust and the system WebView for its desktop window. A bundled Node.js runtime runs the desktop service and starts a fresh, separately terminable worker for each execution. This preserves native Node module loading, npm and TypeScript without requiring Node.js on the installed user's system. The editor window remains isolated from Node; execution has full local Node.js access and is not a security sandbox for untrusted code. Package installation and hosted AI calls require network access; editing and previously installed packages work offline.

Assistant credentials are encrypted with AES-256-GCM using a wrapping key kept in the operating system's credential store. The key travels only over the private Rust-to-service input pipe; it is not exposed to the WebView or inherited by execution workers. If the credential store is unavailable, local providers can still be used without saving a key.

Package lifecycle scripts are disabled so cancelling an installation can stop all its work. Packages requiring native compilation or postinstall setup need separate preparation.

## Installation

For development, install Node.js 22 or newer, pnpm, a current stable Rust toolchain, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows these include Visual Studio C++ Build Tools and WebView2. Then install the JavaScript dependencies:

```sh
pnpm install
```

## Development

To start the native Tauri application with Vite hot reload:

```sh
pnpm dev
```

Check the project with:

```sh
pnpm typecheck
pnpm test
pnpm build
```

The build prepares the Node service, execution worker, npm, TypeScript and the platform's Node executable under `src-tauri/resources/desktop` and `src-tauri/binaries`. Generated runtime files and Rust build outputs are ignored by Git. Builds must run on the same operating system and architecture as the bundled Node executable; cross-target runtime binaries are not substituted automatically.

Check the Rust host after preparing the runtime:

```sh
pnpm build:desktop
pnpm check:native
```

## Packaging

To build the native executable without generating installers:

```sh
pnpm package
```

## Making

To create Tauri installers for the current platform:

```sh
pnpm make
```

Artifacts are written to `src-tauri/target/release`, with installers under `bundle`. Windows builds use the system WebView2 runtime. Publishing a release and configuring signed automatic updates are separate release tasks; the application's update menu opens the GitHub releases page.

## Existing Electron data

When an existing Electron workspace or settings file is detected in the legacy `js-blitz` configuration directory, the Node service reuses that directory. Installed npm packages and environment settings stay available. Previously encrypted Electron API keys may need to be entered again because the credential provider changed.

Tauri uses a different WebView storage origin. Tabs, themes and snippet libraries stored in Electron's localStorage do not transfer automatically. Export personal snippets from the former application before switching; retain the old application data until any unsaved tabs have been copied. The migration does not delete the legacy browser data.

## Scripts

- `start` / `dev`: Start the native Tauri application with Vite
- `build`: Prepare the bundled runtime and build the frontend
- `build:desktop`: Prepare the service, worker, npm, TypeScript and Node sidecar
- `dev:frontend`: Prepare the runtime and start Vite on port 1420
- `check:native`: Check the Rust host
- `package`: Build the native executable
- `make`: Create distributable Tauri installers
- `tauri`: Run the Tauri CLI directly

## License

This project is licensed under the MIT License. See the LICENSE file for details.

## Author

Roberth González

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Acknowledgements

- [Tauri](https://tauri.app/)
- [Vite](https://vitejs.dev/)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [Vue.js](https://vuejs.org/)
