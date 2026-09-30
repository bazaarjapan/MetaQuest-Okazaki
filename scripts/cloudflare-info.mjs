import { readFile } from "node:fs/promises";
import { join } from "node:path";
const config = await readFile(
  join(process.env.APPDATA, "xdg.config/.wrangler/config/default.toml"),
  "utf8",
);
const token = config.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) throw new Error("Wrangler OAuth not available");
async function get(path) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (!j.success)
    throw new Error(
      "Cloudflare " +
        r.status +
        " " +
        JSON.stringify(
          j.errors?.map((e) => ({ code: e.code, message: e.message })),
        ),
    );
  return j.result;
}
const zones = await get("/zones?name=gigach.net");
console.log(
  "ZONE",
  JSON.stringify(
    zones.map((z) => ({
      id: z.id,
      name: z.name,
      status: z.status,
      account: z.account.id,
    })),
  ),
);
const account = "91bd93d7263b9929ef1c4db622a75979";
const scripts = await get(`/accounts/${account}/workers/scripts`);
console.log(
  "MATCHING_WORKERS",
  JSON.stringify(
    scripts
      .filter((s) => /okazaki|metaquest/i.test(s.id))
      .map((s) => ({ id: s.id })),
  ),
);
const domains = await get(`/accounts/${account}/workers/domains`);
console.log(
  "MATCHING_DOMAINS",
  JSON.stringify(
    domains.filter((d) => d.hostname === "metaquest001.gigach.net"),
  ),
);
console.log(
  "WORKERS_SUBDOMAIN",
  JSON.stringify(await get(`/accounts/${account}/workers/subdomain`)),
);
