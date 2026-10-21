import { open } from "node:fs/promises";

// Call only after host/site validation. The path is fixed by the application.
export async function sourceDownload(request: Request, path: string) {
  request.signal.throwIfAborted();
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Source archive is not a regular file");
    request.signal.throwIfAborted();
    let stopped = false;
    let closing: Promise<void> | undefined;
    let abort: () => void;
    const close = () => {
      stopped = true;
      request.signal.removeEventListener("abort", abort);
      return (closing ??= file.close());
    };
    // Read only on demand. A cancellation can arrive while file.read is pending.
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          abort = () => {
            controller.error(request.signal.reason);
            // The response is already errored; also release its file handle.
            void close().catch(() => {});
          };
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        },
        async pull(controller) {
          try {
            const chunk = new Uint8Array(64 * 1024);
            const { bytesRead } = await file.read(chunk);
            if (stopped) return;
            if (bytesRead) controller.enqueue(chunk.subarray(0, bytesRead));
            else {
              await close();
              controller.close();
            }
          } catch (error) {
            if (!stopped) controller.error(error);
            await close();
          }
        },
        cancel: close,
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      headers: {
        "content-type": "application/gzip",
        "content-length": String(info.size),
        "content-disposition":
          'attachment; filename="navigation-network-source.tar.gz"',
      },
    });
  } catch (error) {
    await file.close();
    throw error;
  }
}
