import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDirectoryFileStore,
  createMemoryFileStore,
  createS3FileStore,
  FileNotFound,
  type FileStore,
} from "./store.js";

const bytes = new TextEncoder().encode("a CV, say");
const KEY = "tracks/0192-a/0192-b";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

const stores: [string, () => Promise<FileStore>][] = [
  ["memory", () => Promise.resolve(createMemoryFileStore())],
  [
    "directory",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "grounded-files-"));
      directories.push(directory);
      return createDirectoryFileStore(directory);
    },
  ],
];

describe.each(stores)("the %s file store", (_, make) => {
  it("keeps, returns and deletes a file", async () => {
    const store = await make();
    await store.put(KEY, bytes, "text/plain");
    expect(await store.get(KEY)).toEqual(bytes);
    await store.delete(KEY);
    await expect(store.get(KEY)).rejects.toBeInstanceOf(FileNotFound);
    await store.delete(KEY);
  });

  it("refuses keys the app doesn't make", async () => {
    const store = await make();
    for (const key of ["../outside", "/etc/passwd", "tracks/../../x", "Tracks/A", ""])
      await expect(store.put(key, bytes, "text/plain")).rejects.toThrow("not a file store key");
  });
});

describe("the S3 file store", () => {
  const settings = {
    bucket: "grounded-files",
    endpoint: "https://storage.example.com",
    region: "auto",
    accessKeyId: "id",
    secretAccessKey: "secret",
    forcePathStyle: false,
  };

  it("sends each operation to the bucket", async () => {
    const sent: unknown[] = [];
    const client = {
      send: (command: unknown) => {
        sent.push(command);
        if (command instanceof GetObjectCommand)
          return Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(bytes) } });
        return Promise.resolve({});
      },
    };
    const store = createS3FileStore(settings, client);
    await store.put(KEY, bytes, "application/pdf");
    expect(await store.get(KEY)).toEqual(bytes);
    await store.delete(KEY);

    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "grounded-files",
      Key: KEY,
      ContentType: "application/pdf",
    });
    expect((sent[1] as GetObjectCommand).input).toEqual({ Bucket: "grounded-files", Key: KEY });
    expect(sent[2]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("reports a missing object as not found", async () => {
    const client = {
      send: () => Promise.reject(new NoSuchKey({ message: "gone", $metadata: {} })),
    };
    const store = createS3FileStore(settings, client);
    await expect(store.get(KEY)).rejects.toBeInstanceOf(FileNotFound);
  });
});
