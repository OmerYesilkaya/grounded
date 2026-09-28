import { fileURLToPath } from "node:url";
import type { Env } from "../env.js";
import { createDirectoryFileStore, createS3FileStore, type FileStore } from "./store.js";

/** `.files` at the repo root, wherever the process was started from. */
const DEFAULT_DIR = fileURLToPath(new URL("../../../../.files", import.meta.url));

/** The file store the environment names: its bucket, or (outside production) a folder. */
export function fileStoreFor(env: Env): FileStore {
  const { FILES_BUCKET, FILES_ENDPOINT, FILES_ACCESS_KEY_ID, FILES_SECRET_ACCESS_KEY } = env;
  if (FILES_BUCKET && FILES_ENDPOINT && FILES_ACCESS_KEY_ID && FILES_SECRET_ACCESS_KEY)
    return createS3FileStore({
      bucket: FILES_BUCKET,
      endpoint: FILES_ENDPOINT,
      region: env.FILES_REGION,
      accessKeyId: FILES_ACCESS_KEY_ID,
      secretAccessKey: FILES_SECRET_ACCESS_KEY,
      forcePathStyle: env.FILES_FORCE_PATH_STYLE === "true",
    });
  return createDirectoryFileStore(env.FILES_DIR ?? DEFAULT_DIR);
}
