// Single entry point to the backend. In the application, these are the Tauri commands of the Rust
// core; in a browser (design preview), a fake backend written in JavaScript takes over.
//
// Commands return a snapshot { repositories, active }, or reject with { code, subject, message }.

import * as mock from './mock/mock-backend.js';
import * as tauri from './tauri-backend.js';

export const isDesktop = tauri.available;

const impl = isDesktop ? tauri : mock;

export const {
  startup,
  refresh,
  pickFolder,
  addRepositories,
  removeRepository,
  selectRepository,
  reorderRepository,
  openFolder,
  setLanguage,
  showWindow,
  onFoldersDropped,
} = impl;
