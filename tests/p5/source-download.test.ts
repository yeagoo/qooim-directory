import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  open,
  writeFile,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { sourceDownload } from "../../src/server/source-download.js";

async function fixture(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "navigation-download-"));
  try {
    await run(join(directory, "source.tar.gz"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function descriptors(path: string) {
  const result: string[] = [];
  for (const fd of await readdir("/proc/self/fd")) {
    try {
      if ((await readlink(`/proc/self/fd/${fd}`)) === path) result.push(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}
async function assertClosed(path: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await descriptors(path)).length) return;
    await setTimeout(10);
  }
  assert.fail("Download file descriptor remained open");
}
const request = (signal?: AbortSignal) =>
  new Request("https://example.test/source.tar.gz", { signal });

test("source download uses the opened revision across an atomic archive replacement", async () => {
  await fixture(async (path) => {
    const bytes = Buffer.from("original archive");
    await writeFile(path, bytes);
    const response = await sourceDownload(request(), path);
    await writeFile(path + ".new", "new archive has a different length");
    await rename(path + ".new", path);
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    assert.equal(response.headers.get("content-type"), "application/gzip");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const current = await sourceDownload(request(), path);
    assert.equal(await current.text(), "new archive has a different length");
  });
});

test(
  "slow source consumers keep bounded reads and cancellation closes the descriptor",
  { skip: process.platform !== "linux" },
  async () => {
    await fixture(async (path) => {
      const file = await open(path, "wx");
      await file.truncate(512 * 1024 * 1024); // Sparse: no large allocation or disk write.
      await file.close();
      const response = await sourceDownload(request(), path);
      await setTimeout(50);
      const [fd] = await descriptors(path);
      assert.ok(fd);
      const info = await readFile(`/proc/self/fdinfo/${fd}`, "utf8");
      const position = Number(/^pos:\s+(\d+)/m.exec(info)?.[1]);
      assert.ok(
        position <= 256 * 1024,
        `Slow download read ${position} bytes ahead`,
      );
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      assert.ok(chunk.value && chunk.value.byteLength <= 64 * 1024);
      await reader.cancel();
      await assertClosed(path);
      const next = await sourceDownload(request(), path);
      const pendingReader = next.body!.getReader();
      const pendingRead = pendingReader.read();
      // Let pull enter file.read, then cancel before the filesystem callback.
      await Promise.resolve();
      await pendingReader.cancel();
      assert.equal((await pendingRead).done, true);
      await assertClosed(path);
    });
  },
);

test(
  "request abort rejects the download and closes its file descriptor",
  { skip: process.platform !== "linux" },
  async () => {
    await fixture(async (path) => {
      const file = await open(path, "wx");
      await file.truncate(1024 * 1024);
      await file.close();
      const controller = new AbortController();
      const response = await sourceDownload(request(controller.signal), path);
      controller.abort();
      await assert.rejects(response.arrayBuffer(), /abort/i);
      await assertClosed(path);
      await assert.rejects(
        sourceDownload(request(controller.signal), path),
        /abort/i,
      );
      await assertClosed(path);
    });
  },
);

test("missing archives and non-files reject before returning successful headers", async () => {
  await fixture(async (path) => {
    await assert.rejects(sourceDownload(request(), path), /ENOENT/);
    await assert.rejects(
      sourceDownload(request(), join(path, "..")),
      /regular file/,
    );
    if (process.platform === "linux") await assertClosed(join(path, ".."));
  });
});
