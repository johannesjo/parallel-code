# Parallel Code

Electron desktop app — SolidJS frontend, Node.js backend. Published for **macOS and Linux only** (no Windows).

## Stack

- **Frontend:** SolidJS, TypeScript (strict), Vite
- **Backend:** Node.js (Electron, node-pty)
- **Package manager:** npm

## Commands

- `npm run dev` — start Electron app in dev mode
- `npm run build` — build production Electron app
- `npm run typecheck` — run TypeScript type checking

## Project Structure

- `src/` — SolidJS frontend (components, store, IPC, lib)
- `electron/` — Electron main process (IPC handlers, shims, preload)
- `electron/ipc/` — backend IPC handlers (pty, git, tasks, persistence)
- `electron/shims/` — Vite alias shims for @tauri-apps/* imports
- `src/store/` — app state management

## Conventions

- Functional components only (SolidJS signals/stores, no classes)
- Electron IPC for all frontend-backend communication
- Frontend imports `@tauri-apps/*` resolved to `electron/shims/*` via Vite aliases
- `strict: true` TypeScript, no `any`
