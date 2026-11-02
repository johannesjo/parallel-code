/**
 * Git exports `GIT_DIR`, `GIT_INDEX_FILE` and friends into the environment of
 * every hook it runs. `npm test` from `.husky/pre-push` therefore hands those
 * to each vitest worker, and any `git` a test spawns inherits them — so tests
 * that build a repository in a temp folder silently operate on the developer's
 * real checkout instead, committing fixtures onto their branch and clobbering
 * their index. Scrubbing them here keeps the suite hermetic whatever invoked it.
 */
const REPO_POINTING_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_CEILING_DIRECTORIES',
] as const;

for (const name of REPO_POINTING_VARS) Reflect.deleteProperty(process.env, name);

/**
 * happy-dom 21 implements `Element.animate`, but its animations do not finish
 * the way a browser's do: exit ghosts linger in the DOM and cancelled
 * animations reject `finished` unobserved. Removing it keeps the motion code on
 * its no-animation path, as on happy-dom 20; tests that cover motion install
 * their own `animate` stub.
 */
if (typeof Element !== 'undefined') Reflect.deleteProperty(Element.prototype, 'animate');
