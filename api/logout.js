export const config = { runtime: "edge" };
import { app } from "../lib/app.js";

// Path is passed explicitly: Vercel rewrites do not preserve request.url.
export default (request) => app(request, "/logout");
