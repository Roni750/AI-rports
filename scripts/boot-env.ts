/**
 * Load `.env.local` before anything else in a script's module graph is evaluated.
 *
 * Importing this FIRST is the whole point, and it is not a style preference. Several modules read
 * their configuration into a `const` at module scope — `CLASSIFIER_MODEL` and the
 * `ACTIVE_CLASSIFIER_VERSION` built from it, `DEFAULT_MODEL`, `APP_VERSION`. ES modules are
 * evaluated depth-first in source order, so a `loadEnvLocal()` call inside `main()` runs long after
 * those constants have already been frozen against an environment that did not have the file's
 * values in it yet.
 *
 * The failure is silent and it corrupts the one thing the analytics layer cannot recover: a run
 * with CLASSIFIER_MODEL set in `.env.local` would call the default model and stamp every row with
 * the default model's version string. Comparing two classifiers over identical traffic is the
 * entire premise of versioning labels, and a wrong version string breaks it invisibly.
 *
 * So: `import "./boot-env";` on the first line of the import block, above every other import.
 */

import { loadEnvLocal } from "./load-env";

loadEnvLocal();
