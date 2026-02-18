# Parallel Code

Tauri v2 desktop app — SolidJS frontend, Rust backend.

## Stack

- **Frontend:** SolidJS, TypeScript (strict), Vite
- **Backend:** Rust (Tauri v2, tokio, portable-pty)
- **Package manager:** pnpm

## Commands

- `pnpm dev` — start Vite dev server
- `pnpm tauri:dev` — run full Tauri app in dev mode
- `pnpm build` — build frontend
- `cargo test` — run Rust tests (from `src-tauri/`)

## Project Structure

- `src/` — SolidJS frontend (components, store, IPC, lib)
- `src-tauri/` — Rust backend (Tauri commands, PTY management)
- `src/ipc/` — frontend-to-backend IPC layer
- `src/store/` — app state management

## Conventions

- Functional components only (SolidJS signals/stores, no classes)
- Tauri IPC for all frontend↔backend communication
- `strict: true` TypeScript, no `any`
