import { fileURLToPath } from "node:url";

// The repository root, from this module's own location (apps/worker/dist/ after
// the build), never from the process cwd.
export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
