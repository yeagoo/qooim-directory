import type { PoolClient } from "pg";
import { HttpError } from "./operators.js";
export async function activeProjectSite(c: PoolClient, site: string) {
  if (
    !(
      await c.query(
        "SELECT 1 FROM site WHERE id=$1 AND active AND modules @> ARRAY['directory','opensource']::text[] FOR SHARE",
        [site],
      )
    ).rowCount
  )
    throw new HttpError(409, "请先启用本站及开源项目模块");
}
