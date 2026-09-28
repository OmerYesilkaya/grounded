import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Where learners' files live (design §4.5): an S3-compatible bucket in production, a folder in
 * development, memory in tests. The database holds what a file is; the store holds its bytes.
 */
export interface FileStore {
  put(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  /** Rejects with FileNotFound when nothing is stored under the key. */
  get(key: string): Promise<Uint8Array>;
  /** Deleting a key that holds nothing is not an error. */
  delete(key: string): Promise<void>;
}

export class FileNotFound extends Error {
  constructor(key: string) {
    super(`no file stored under ${key}`);
  }
}

// Keys are made by the app ("tracks/<id>/<id>"), never from a learner's file name, and this keeps
// them from reaching outside a folder store.
const KEY = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

function checked(key: string): string {
  if (!KEY.test(key)) throw new Error(`not a file store key: ${key}`);
  return key;
}

/** Runs `run` into a promise, so a bad key rejects, as it does in the other stores. */
const settled = <T>(run: () => T) =>
  new Promise<T>((done) => {
    done(run());
  });

export function createMemoryFileStore(): FileStore & { keys(): string[] } {
  const files = new Map<string, Uint8Array>();
  return {
    put: (key, bytes) =>
      settled(() => {
        files.set(checked(key), bytes.slice());
      }),
    get: (key) =>
      settled(() => {
        const bytes = files.get(checked(key));
        if (!bytes) throw new FileNotFound(key);
        return bytes.slice();
      }),
    delete: (key) =>
      settled(() => {
        files.delete(checked(key));
      }),
    keys: () => [...files.keys()],
  };
}

/** Development only: a container's disk doesn't outlive a deploy. */
export function createDirectoryFileStore(directory: string): FileStore {
  const root = resolve(directory);
  const pathOf = (key: string) => join(root, checked(key));
  return {
    async put(key, bytes) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(pathOf(key)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FileNotFound(key);
        throw error;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

export interface S3Settings {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Older buckets (and some S3-compatible stores) want the bucket in the path, not the host. */
  forcePathStyle: boolean;
}

/** An S3-compatible bucket (a Railway bucket in production). */
export function createS3FileStore(
  settings: S3Settings,
  client: Pick<S3Client, "send"> = new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  }),
): FileStore {
  const Bucket = settings.bucket;
  return {
    async put(key, bytes, mediaType) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: checked(key), Body: bytes, ContentType: mediaType }),
      );
    },
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket, Key: checked(key) }));
        if (!object.Body) throw new FileNotFound(key);
        return await object.Body.transformToByteArray();
      } catch (error) {
        if (error instanceof NoSuchKey) throw new FileNotFound(key);
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: checked(key) }));
    },
  };
}
