import type { Pool, PoolClient } from "pg";

const connectionFailures = new WeakMap<PoolClient, Error>();
const observed = new WeakSet<PoolClient>();
// pg emits an error event as well as rejecting a query when a checked-out socket dies.
// Keep one handler for the client's lifetime; discard failed clients instead of returning them to the pool.
export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const client = await pool.connect();
  if (!observed.has(client)) {
    observed.add(client);
    client.on("error", (error) => connectionFailures.set(client, error));
  }
  try {
    await client.query(
      readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
    );
    const result = await work(client);
    const failure = connectionFailures.get(client);
    if (failure) throw failure;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      connectionFailures.set(
        client,
        rollbackError instanceof Error
          ? rollbackError
          : new Error("Rollback failed"),
      );
    }
    throw error;
  } finally {
    client.release(connectionFailures.get(client));
  }
}
