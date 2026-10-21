import { database } from "./database.js";
import { settings } from "./settings.js";
import { Application } from "./http.js";
let application: Application | undefined;
export async function serverResponse(request: Request) {
  application ??= new Application(database(), settings());
  return application.respond(request);
}
